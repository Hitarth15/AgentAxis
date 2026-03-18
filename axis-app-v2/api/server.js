// api/server.js — AXIS backend v2
// New: /api/costs, /api/memory, /api/improver, cost guard on all task runs
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const { Pool } = require('pg');
const { AGENTS, runAgent, runImprover } = require('../agents/agents');
const costGuard = require('../agents/costguard');
const memory    = require('../agents/memory');

const app  = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ── Health ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', agents: Object.keys(AGENTS) });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━
// PROJECTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/projects', async (req, res) => {
  try { const { rows } = await pool.query('SELECT * FROM projects ORDER BY created_at DESC'); res.json(rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects', async (req, res) => {
  const { name, description, status, revenue_model, lead_agent, next_action } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO projects (name, description, status, revenue_model, lead_agent, next_action)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, description, status||'planning', revenue_model, lead_agent, next_action]
    );
    await log(null, rows[0].id, 'project_created', `Project "${name}" created`);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/projects/:id', async (req, res) => {
  const fields = ['name','description','status','revenue_model','lead_agent','progress','next_action'];
  const updates = []; const values = [];
  fields.forEach(f => { if (req.body[f] !== undefined) { values.push(req.body[f]); updates.push(`${f}=$${values.length}`); }});
  if (!updates.length) return res.status(400).json({ error: 'no fields' });
  values.push(req.params.id);
  try {
    const { rows } = await pool.query(`UPDATE projects SET ${updates.join(',')} WHERE id=$${values.length} RETURNING *`, values);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:id', async (req, res) => {
  try { await pool.query('DELETE FROM projects WHERE id=$1', [req.params.id]); res.json({ deleted: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━
// TASKS (Semi-auto flow)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/tasks', async (req, res) => {
  const { status, project_id } = req.query;
  let q = 'SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON t.project_id=p.id';
  const conds=[]; const vals=[];
  if (status)     { vals.push(status);     conds.push(`t.status=$${vals.length}`); }
  if (project_id) { vals.push(project_id); conds.push(`t.project_id=$${vals.length}`); }
  if (conds.length) q += ' WHERE ' + conds.join(' AND ');
  q += ' ORDER BY t.created_at DESC';
  try { const { rows } = await pool.query(q, vals); res.json(rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Run agent — creates task, calls Claude, saves draft
app.post('/api/tasks/run', async (req, res) => {
  const { project_id, agent_id, task_type, prompt, context } = req.body;
  if (!agent_id || !prompt) return res.status(400).json({ error: 'agent_id and prompt required' });

  // Pre-flight cost check (returns current spend info or throws)
  let costInfo;
  try { costInfo = await costGuard.checkBeforeRun(agent_id); }
  catch(e) {
    // Cost limit hit — return clear message to UI
    return res.status(429).json({ error: e.message, type: 'COST_LIMIT' });
  }

  let taskId;
  try {
    const { rows } = await pool.query(
      `INSERT INTO tasks (project_id, agent_id, task_type, prompt, status) VALUES ($1,$2,$3,$4,'running') RETURNING id`,
      [project_id, agent_id, task_type||'custom', prompt]
    );
    taskId = rows[0].id;
  } catch(e) { return res.status(500).json({ error: e.message }); }

  try {
    const result = await runAgent(agent_id, prompt, { ...(context||{}), task_type }, project_id);

    // Save peer review verdict in metadata
    const metadata = result.peer_review
      ? { peer_review: result.peer_review, cost_info: costInfo }
      : { cost_info: costInfo };

    await pool.query(
      `UPDATE tasks SET ai_draft=$1, ai_model=$2, tokens_used=$3, cost_usd=$4, status='draft_ready', metadata=$5 WHERE id=$6`,
      [result.output, result.model, result.tokens_total, result.cost_usd, JSON.stringify(metadata), taskId]
    );

    await log(agent_id, project_id, 'draft_ready',
      `${agent_id} completed "${task_type||'task'}" — awaiting approval${result.peer_review ? ' (peer reviewed by ' + result.peer_review.reviewer + ')' : ''}`);

    // Auto-create intervention
    await pool.query(
      `INSERT INTO interventions (project_id, title, description, agent_id, urgency) VALUES ($1,$2,$3,$4,'med')`,
      [project_id, `Review ${agent_id} draft: ${task_type||'task'}`, `${agent_id} draft ready. Cost: $${result.cost_usd}. ${result.peer_review ? 'Peer verdict: ' + result.peer_review.verdict.slice(0,80) : ''}`, agent_id]
    );

    res.json({ task_id: taskId, status: 'draft_ready', result, cost_info: costInfo });
  } catch(e) {
    await pool.query(`UPDATE tasks SET status='failed' WHERE id=$1`, [taskId]);
    await log(agent_id, project_id, 'error', `${agent_id} failed: ${e.message}`);
    res.status(500).json({ error: e.message, task_id: taskId });
  }
});

app.post('/api/tasks/:id/approve', async (req, res) => {
  const { feedback, final_output } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE tasks SET status='approved', your_feedback=$1, final_output=COALESCE($2,ai_draft) WHERE id=$3 RETURNING *`,
      [feedback||null, final_output||null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not found' });
    await log(rows[0].agent_id, rows[0].project_id, 'approved', `Task approved: ${rows[0].task_type}`);
    await pool.query(`UPDATE interventions SET status='done' WHERE agent_id=$1 AND status='open' AND title LIKE $2`,
      [rows[0].agent_id, `%${rows[0].task_type}%`]);
    // Store approval as a positive memory signal
    if (feedback) memory.storeDecision(rows[0].agent_id, rows[0].project_id, `Task approved with feedback: ${feedback}`, 'User approved with notes').catch(()=>{});
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tasks/:id/reject', async (req, res) => {
  const { feedback } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE tasks SET status='rejected', your_feedback=$1 WHERE id=$2 RETURNING *`,
      [feedback||'Rejected', req.params.id]
    );
    // Store rejection as a lesson for the improvement system
    memory.storeLesson(rows[0].agent_id, 'quality',
      `Task rejected: ${rows[0].task_type}`,
      `User feedback: ${feedback}`, 'Needs improvement before approval').catch(()=>{});
    await log(rows[0].agent_id, rows[0].project_id, 'rejected', `Task rejected: ${rows[0].task_type}. Feedback: ${feedback}`);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tasks/:id/redo', async (req, res) => {
  const { feedback } = req.body;
  try {
    const { rows: orig } = await pool.query('SELECT * FROM tasks WHERE id=$1', [req.params.id]);
    if (!orig[0]) return res.status(404).json({ error: 'not found' });
    const task = orig[0];

    // Cost check before redo too
    await costGuard.checkBeforeRun(task.agent_id);

    const revisedPrompt = `${task.prompt}\n\n--- REVISION REQUEST ---\nPrevious output was not approved.\nYour feedback to address: ${feedback}\n\nPlease revise with this feedback in mind.`;
    const result = await runAgent(task.agent_id, revisedPrompt, { task_type: task.task_type + '_revision' }, task.project_id);

    await pool.query(
      `UPDATE tasks SET ai_draft=$1, tokens_used=tokens_used+$2, cost_usd=cost_usd+$3, status='draft_ready', your_feedback=$4 WHERE id=$5`,
      [result.output, result.tokens_total, result.cost_usd, feedback, task.id]
    );
    await log(task.agent_id, task.project_id, 'draft_ready', `${task.agent_id} revised draft after feedback`);
    res.json({ task_id: task.id, status: 'draft_ready', result });
  } catch(e) {
    if (e.message.startsWith('COST_LIMIT')) return res.status(429).json({ error: e.message, type: 'COST_LIMIT' });
    res.status(500).json({ error: e.message });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━
// INTERVENTIONS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/interventions', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, p.name AS project_name FROM interventions i LEFT JOIN projects p ON i.project_id=p.id
       WHERE i.status='open' ORDER BY CASE urgency WHEN 'high' THEN 1 WHEN 'med' THEN 2 ELSE 3 END, i.created_at DESC`
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/interventions', async (req, res) => {
  const { project_id, title, description, agent_id, urgency } = req.body;
  try { const { rows } = await pool.query(`INSERT INTO interventions (project_id, title, description, agent_id, urgency) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [project_id, title, description, agent_id, urgency||'med']); res.json(rows[0]); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/interventions/:id/done', async (req, res) => {
  try { await pool.query(`UPDATE interventions SET status='done' WHERE id=$1`, [req.params.id]); res.json({ done: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━
// HURDLES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/hurdles', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT h.*, p.name AS project_name FROM hurdles h LEFT JOIN projects p ON h.project_id=p.id WHERE h.status='open'
       ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END`
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/hurdles', async (req, res) => {
  const { project_id, title, description, severity } = req.body;
  try { const { rows } = await pool.query(`INSERT INTO hurdles (project_id, title, description, severity) VALUES ($1,$2,$3,$4) RETURNING *`, [project_id, title, description, severity||'high']); res.json(rows[0]); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/hurdles/:id/resolve', async (req, res) => {
  try { await pool.query(`UPDATE hurdles SET status='resolved' WHERE id=$1`, [req.params.id]); res.json({ resolved: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━
// COST GUARD (NEW)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/costs', async (req, res) => {
  try { res.json(await costGuard.getSummary()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/costs/breakdown', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT agent_id, COUNT(*) AS task_count,
       SUM(cost_usd) AS total_usd, SUM(tokens_used) AS total_tokens,
       AVG(cost_usd) AS avg_usd_per_task
       FROM tasks WHERE status != 'failed' AND cost_usd IS NOT NULL
       GROUP BY agent_id ORDER BY total_usd DESC`
    );
    res.json(rows.map(r => ({
      ...r,
      total_inr: Math.round(parseFloat(r.total_usd || 0) * 84),
      avg_inr_per_task: Math.round(parseFloat(r.avg_usd_per_task || 0) * 84)
    })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━
// MEMORY / KNOWLEDGE GRAPH (NEW)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/memory', (req, res) => {
  try {
    const { type, agent_id, search } = req.query;
    res.json(memory.query({ type, agentId: agent_id, search, limit: 50 }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/memory/stats', (req, res) => {
  try { res.json(memory.stats()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/memory/decision', async (req, res) => {
  const { agent_id, project_id, decision, rationale } = req.body;
  try { res.json(await memory.storeDecision(agent_id, project_id, decision, rationale)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━
// IMPROVER META-AGENT (NEW)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/improver/run', async (req, res) => {
  try {
    await costGuard.checkBeforeRun('IMPROVER');
    const result = await runImprover();
    // Store the improvement report as a milestone memory
    await memory.store({
      type: 'milestone', agent_id: 'IMPROVER',
      summary: 'Monthly system improvement report generated',
      detail: result.output.slice(0, 500)
    });
    res.json(result);
  } catch(e) {
    if (e.message.startsWith('COST_LIMIT')) return res.status(429).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━
// ACTIVITY FEED
// ━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/activity', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, p.name AS project_name FROM activity_log a LEFT JOIN projects p ON a.project_id=p.id
       ORDER BY a.created_at DESC LIMIT 50`
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━
// DASHBOARD STATS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/dashboard', async (req, res) => {
  try {
    const [projects, tasks, interventions, hurdles, activity] = await Promise.all([
      pool.query(`SELECT status, COUNT(*) FROM projects GROUP BY status`),
      pool.query(`SELECT status, COUNT(*) FROM tasks GROUP BY status`),
      pool.query(`SELECT COUNT(*) FROM interventions WHERE status='open'`),
      pool.query(`SELECT COUNT(*) FROM hurdles WHERE status='open'`),
      pool.query(`SELECT a.*, p.name AS project_name FROM activity_log a LEFT JOIN projects p ON a.project_id=p.id ORDER BY a.created_at DESC LIMIT 10`)
    ]);
    const costs = await costGuard.getSummary();
    const memStats = memory.stats();
    res.json({
      projects:      projects.rows,
      tasks:         tasks.rows,
      interventions: parseInt(interventions.rows[0].count),
      hurdles:       parseInt(hurdles.rows[0].count),
      activity:      activity.rows,
      costs,
      memory:        memStats
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agents', (req, res) => {
  res.json(Object.values(AGENTS).map(a => ({
    id: a.id, name: a.name, emoji: a.emoji, model: a.model, tasks: a.tasks,
    peer_reviewers: a.peer_reviewers || []
  })));
});

// Helper
async function log(agentId, projectId, eventType, message, metadata = {}) {
  try {
    await pool.query(
      `INSERT INTO activity_log (agent_id, project_id, event_type, message, metadata) VALUES ($1,$2,$3,$4,$5)`,
      [agentId, projectId, eventType, message, JSON.stringify(metadata)]
    );
  } catch(_) {}
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 AXIS v2 backend running on :${PORT}`);
  console.log(`   Cost guard: $${process.env.DAILY_COST_LIMIT_USD||2}/day, $${process.env.MONTHLY_COST_LIMIT_USD||30}/month`);
  console.log(`   Agents: ${Object.keys(AGENTS).join(', ')}\n`);
});

module.exports = app;
