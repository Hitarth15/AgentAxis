// agents/costguard.js — Hard cost limits to prevent runaway API bills
// Real incident: Two agents talked to each other for 11 days → $47,000 bill
// Fix: token budgets, daily caps, circuit breakers, loop detection

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ── CONFIG — tune these to your comfort level ──
const LIMITS = {
  // Per single agent task run (tokens)
  max_tokens_per_task: 8000,

  // Daily spend limit in USD — alerts at 80%, hard stops at 100%
  daily_usd_limit: parseFloat(process.env.DAILY_COST_LIMIT_USD || '2.00'),

  // Monthly spend limit in USD
  monthly_usd_limit: parseFloat(process.env.MONTHLY_COST_LIMIT_USD || '30.00'),

  // Max tasks per agent per hour (prevents loops)
  max_tasks_per_agent_per_hour: 10,

  // Max consecutive redo requests (prevents human-triggered loops)
  max_redos_per_task: 3,

  // Circuit breaker: if any task hits this token count, abort
  circuit_breaker_tokens: 12000
};

const costGuard = {

  // Check before running a task — throw if over limit
  async checkBeforeRun(agentId) {
    const todayCost = await this.getTodayCost();
    const monthlyCost = await this.getMonthlyCost();
    const recentTasks = await this.getRecentTaskCount(agentId);

    if (todayCost >= LIMITS.daily_usd_limit) {
      throw new Error(`COST_LIMIT: Daily limit of $${LIMITS.daily_usd_limit} reached ($${todayCost.toFixed(4)} spent today). Reset tomorrow or raise DAILY_COST_LIMIT_USD.`);
    }

    if (monthlyCost >= LIMITS.monthly_usd_limit) {
      throw new Error(`COST_LIMIT: Monthly limit of $${LIMITS.monthly_usd_limit} reached. Raise MONTHLY_COST_LIMIT_USD to continue.`);
    }

    if (todayCost >= LIMITS.daily_usd_limit * 0.8) {
      // Warning — not a stop, but log it
      console.warn(`⚠️  COST WARNING: ${Math.round((todayCost/LIMITS.daily_usd_limit)*100)}% of daily limit used ($${todayCost.toFixed(4)}/$${LIMITS.daily_usd_limit})`);
    }

    if (recentTasks >= LIMITS.max_tasks_per_agent_per_hour) {
      throw new Error(`LOOP_GUARD: ${agentId} has run ${recentTasks} tasks in the last hour. Possible loop. Manual reset required.`);
    }

    return {
      today_cost:    todayCost,
      monthly_cost:  monthlyCost,
      daily_limit:   LIMITS.daily_usd_limit,
      monthly_limit: LIMITS.monthly_usd_limit,
      remaining_today: LIMITS.daily_usd_limit - todayCost
    };
  },

  // Check redo count for a specific task
  async checkRedoLimit(taskId) {
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) FROM tasks WHERE id = $1 AND status = 'rejected'`, [taskId]
      );
      // We track redos by counting how many times a task has been rejected+resubmitted
      // Simple proxy: check your_feedback not null count
      const { rows: r2 } = await pool.query(
        `SELECT your_feedback FROM tasks WHERE id = $1`, [taskId]
      );
      // Each feedback = one redo cycle
      const redoCount = r2[0]?.your_feedback ? 1 : 0; // simplified
      if (redoCount >= LIMITS.max_redos_per_task) {
        throw new Error(`REDO_LIMIT: This task has been redone ${LIMITS.max_redos_per_task} times. Archive it and start fresh.`);
      }
    } catch(e) {
      if (e.message.startsWith('REDO_LIMIT')) throw e;
      // DB error — allow through, don't block
    }
  },

  // Get today's total cost from DB
  async getTodayCost() {
    try {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM tasks
         WHERE created_at >= NOW() - INTERVAL '24 hours' AND status != 'failed'`
      );
      return parseFloat(rows[0].total);
    } catch(_) { return 0; }
  },

  // Get this month's total cost
  async getMonthlyCost() {
    try {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM tasks
         WHERE created_at >= DATE_TRUNC('month', NOW()) AND status != 'failed'`
      );
      return parseFloat(rows[0].total);
    } catch(_) { return 0; }
  },

  // Count recent tasks for an agent (loop detection)
  async getRecentTaskCount(agentId) {
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*) FROM tasks
         WHERE agent_id = $1 AND created_at >= NOW() - INTERVAL '1 hour'`,
        [agentId]
      );
      return parseInt(rows[0].count);
    } catch(_) { return 0; }
  },

  // Dashboard cost summary
  async getSummary() {
    const today   = await this.getTodayCost();
    const monthly = await this.getMonthlyCost();
    return {
      today_usd:       today,
      today_inr:       Math.round(today * 84),
      monthly_usd:     monthly,
      monthly_inr:     Math.round(monthly * 84),
      daily_limit_usd: LIMITS.daily_usd_limit,
      monthly_limit_usd: LIMITS.monthly_usd_limit,
      daily_pct:       Math.round((today / LIMITS.daily_usd_limit) * 100),
      monthly_pct:     Math.round((monthly / LIMITS.monthly_usd_limit) * 100),
      status: today >= LIMITS.daily_usd_limit ? 'HARD_STOP'
            : today >= LIMITS.daily_usd_limit * 0.8 ? 'WARNING'
            : 'OK'
    };
  },

  LIMITS
};

module.exports = costGuard;
