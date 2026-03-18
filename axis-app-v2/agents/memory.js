// agents/memory.js — Shared knowledge graph for all agents
// Fix for: memory corruption from concurrent writes (lesson from DEV.to solo founder)
// Fix for: context poisoning from stale/wrong data persisting
// Fix for: agents losing institutional knowledge between sessions

const fs   = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '../db/memory.jsonl');
const TMP_FILE    = MEMORY_FILE + '.tmp';

// In-memory mutex — prevents concurrent writes corrupting the JSONL file
let writeLock = false;
const writeQueue = [];

async function acquireLock() {
  return new Promise(resolve => {
    if (!writeLock) { writeLock = true; resolve(); }
    else writeQueue.push(resolve);
  });
}
function releaseLock() {
  if (writeQueue.length > 0) {
    const next = writeQueue.shift();
    next();
  } else {
    writeLock = false;
  }
}

// Load all memories — skip corrupt lines (auto-repair on load)
function loadMemories() {
  if (!fs.existsSync(MEMORY_FILE)) return [];
  const lines = fs.readFileSync(MEMORY_FILE, 'utf8').split('\n').filter(Boolean);
  const valid = [];
  const seen  = new Set();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      // Dedup by id
      if (entry.id && seen.has(entry.id)) continue;
      if (entry.id) seen.add(entry.id);
      valid.push(entry);
    } catch (_) {
      // Skip corrupt lines silently — auto-repair
    }
  }
  return valid;
}

// Atomic write — write to .tmp then rename (prevents half-written files)
async function saveMemories(memories) {
  await acquireLock();
  try {
    const content = memories.map(m => JSON.stringify(m)).join('\n') + '\n';
    fs.writeFileSync(TMP_FILE, content, 'utf8');
    fs.renameSync(TMP_FILE, MEMORY_FILE);
  } finally {
    releaseLock();
  }
}

// Pruning rules: keep decisions/lessons forever, prune standups > 7 days
function pruneStaleMemories(memories) {
  const KEEP_FOREVER = new Set(['decision', 'lesson', 'milestone', 'product', 'metric']);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
  return memories.filter(m => {
    if (KEEP_FOREVER.has(m.type)) return true;
    if (m.type === 'standup' && new Date(m.created_at).getTime() < cutoff) return false;
    return true;
  });
}

// Public API
const memory = {

  // Store a memory entry
  async store(entry) {
    const memories = loadMemories();
    const newEntry = {
      id:         `${entry.type}:${Date.now()}:${Math.random().toString(36).slice(2,7)}`,
      created_at: new Date().toISOString(),
      ...entry
    };
    memories.push(newEntry);
    const pruned = pruneStaleMemories(memories);
    await saveMemories(pruned);
    return newEntry;
  },

  // Store a lesson (permanent, from agent self-reflection)
  async storeLesson(agentId, category, summary, detail, action) {
    return this.store({
      type:     'lesson',
      agent_id: agentId,
      category,   // 'bug' | 'quality' | 'cost' | 'strategy' | 'user'
      summary,
      detail,
      action      // What was done to fix/improve
    });
  },

  // Store a decision (permanent)
  async storeDecision(agentId, projectId, decision, rationale) {
    return this.store({
      type:       'decision',
      agent_id:   agentId,
      project_id: projectId,
      decision,
      rationale
    });
  },

  // Query memories (type filter + text search)
  query({ type, agentId, projectId, search, limit = 20 } = {}) {
    let memories = loadMemories();
    if (type)      memories = memories.filter(m => m.type === type);
    if (agentId)   memories = memories.filter(m => m.agent_id === agentId);
    if (projectId) memories = memories.filter(m => m.project_id === projectId);
    if (search) {
      const q = search.toLowerCase();
      memories = memories.filter(m =>
        JSON.stringify(m).toLowerCase().includes(q)
      );
    }
    // Most recent first, limit
    return memories.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);
  },

  // Get relevant context for an agent task (precise, not full dump)
  // Fix for: "Dumb RAG" — don't dump everything into context, curate what's relevant
  getContextFor(agentId, projectId, taskType) {
    const entries = [];

    // Always include: recent decisions for this project
    entries.push(...this.query({ type: 'decision', projectId, limit: 5 }));

    // Agent-specific lessons (what this agent learned before)
    entries.push(...this.query({ type: 'lesson', agentId, limit: 5 }));

    // Recent milestones
    entries.push(...this.query({ type: 'milestone', projectId, limit: 3 }));

    // Deduplicate
    const seen = new Set();
    return entries.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id); return true;
    }).map(e => `[${e.type.toUpperCase()} by ${e.agent_id||'system'}]: ${e.summary || e.decision || e.detail || JSON.stringify(e)}`).join('\n');
  },

  // Get all lessons (for the Improver / feedback view)
  getLessons() {
    return this.query({ type: 'lesson', limit: 50 });
  },

  // Stats
  stats() {
    const all = loadMemories();
    const counts = {};
    all.forEach(m => { counts[m.type] = (counts[m.type] || 0) + 1; });
    return { total: all.length, by_type: counts };
  }
};

module.exports = memory;
