// db/init.js — Run once: node db/init.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const schema = `
-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT DEFAULT 'planning' CHECK (status IN ('planning','active','paused','blocked')),
  revenue_model TEXT,
  lead_agent  TEXT,
  progress    INTEGER DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  next_action TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Agent task queue (the core of semi-auto flow)
CREATE TABLE IF NOT EXISTS tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID REFERENCES projects(id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  task_type     TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  status        TEXT DEFAULT 'pending' CHECK (status IN ('pending','running','draft_ready','approved','rejected','executed','failed')),
  -- AI output stored here, waiting for your approval
  ai_draft      TEXT,
  ai_model      TEXT,
  tokens_used   INTEGER,
  cost_usd      NUMERIC(10,6),
  -- Your feedback loop
  your_feedback TEXT,
  final_output  TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Manual interventions needed from you
CREATE TABLE IF NOT EXISTS interventions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  description TEXT,
  agent_id    TEXT,
  urgency     TEXT DEFAULT 'med' CHECK (urgency IN ('high','med','low')),
  status      TEXT DEFAULT 'open' CHECK (status IN ('open','done')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Hurdles / blockers
CREATE TABLE IF NOT EXISTS hurdles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES projects(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  description TEXT,
  severity    TEXT DEFAULT 'high' CHECK (severity IN ('critical','high','med')),
  status      TEXT DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Activity log (agent feed)
CREATE TABLE IF NOT EXISTS activity_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    TEXT,
  project_id  UUID REFERENCES projects(id) ON DELETE SET NULL,
  event_type  TEXT, -- 'draft_ready' | 'task_done' | 'error' | 'intervention_raised'
  message     TEXT,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Feedback loop metrics (weekly snapshots)
CREATE TABLE IF NOT EXISTS feedback_metrics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start  DATE NOT NULL,
  metric_key  TEXT NOT NULL,
  metric_val  TEXT,
  delta       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast dashboard queries
CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project    ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_interventions_status ON interventions(status);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_projects_upd ON projects;
CREATE TRIGGER trg_projects_upd BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_tasks_upd ON tasks;
CREATE TRIGGER trg_tasks_upd BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at();
`;

async function init() {
  const client = await pool.connect();
  try {
    console.log('🔧 Initialising AXIS database schema...');
    await client.query(schema);
    console.log('✅ Schema created successfully');

    // Seed default agents config (stored in code, but log them)
    console.log('\n📋 Agent roster:');
    ['STRAT','CREO','VISU','GRWTH','OPSY','FINU','DEVI'].forEach(a => console.log(`  · ${a}`));
    console.log('\n🚀 AXIS database ready. Run: npm run dev');
  } catch (err) {
    console.error('❌ Schema error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

init();

// Note: run this migration if upgrading from v1
// ALTER TABLE tasks ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
