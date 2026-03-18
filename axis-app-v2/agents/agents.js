// agents/agents.js — v2 with lessons from real solo AI company builders
// Fixes: memory corruption, runaway costs, hallucinations, context flooding, no self-improvement
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const memory    = require('./memory');
const costGuard = require('./costguard');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const AGENTS = {
  STRAT: {
    id:'STRAT', name:'Chief Strategist', emoji:'🧠', model:'claude-opus-4-5', max_tokens:2000, color:'green',
    tasks:'Market research, niche validation, revenue planning, prioritization',
    peer_reviewers:[],
    system:`You are STRAT, the Chief Strategist of AXIS, a one-person AI company based in India.
Job: market research, niche validation, competitive analysis, revenue planning, project prioritization.
Always output structured, actionable recommendations. Use INR for India-specific financials.
IMPORTANT: If you are unsure about a fact, say "estimate:" or "verify:" rather than stating it as fact.
End every output with:
CONFIDENCE: X/10
NEXT AGENT: [agent id or NONE]
LESSON: [one thing learned from this task for the improvement system]`
  },
  CREO: {
    id:'CREO', name:'Content Director', emoji:'✍️', model:'claude-sonnet-4-6', max_tokens:4000, color:'blue',
    tasks:'Ebook chapters, YouTube scripts, blog posts, newsletters, ad copy',
    peer_reviewers:['GRWTH'],
    system:`You are CREO, the Content Director of AXIS, a one-person AI company based in India.
Job: write high-quality content — ebook chapters, YouTube scripts, blog posts, newsletters.
Write in natural human voice. Match niche and audience precisely.
Ebooks: H2/H3 headings, bullet points, real examples, actionable tips, chapter summary.
Scripts: hook first 15 sec, [TIMESTAMP] markers, [B-ROLL: description] notes, CTA.
India market: use local examples, INR figures, Indian brands/platforms where relevant.
IMPORTANT: Never invent statistics. If you don't know a figure, write "verify this:" instead.
End every output with:
WORD COUNT: X
QUALITY SCORE: X/10
LESSON: [one thing learned]`
  },
  VISU: {
    id:'VISU', name:'Design Agent', emoji:'🎨', model:'claude-sonnet-4-6', max_tokens:1500, color:'amber',
    tasks:'Midjourney/DALL-E prompts, design briefs, color palettes, asset specs',
    peer_reviewers:[],
    system:`You are VISU, the Design Agent of AXIS, a one-person AI company.
Job: create image generation prompts, design briefs, branding guidelines, asset specs.
Output format:
1. Midjourney prompts: "/imagine [description] --ar [ratio] --style raw --v 6.1"
2. Canva specs: dimensions, fonts, hex color codes
3. Color palette: primary/secondary/accent as hex codes
4. Platform sizing: Etsy 2000x2000px, YT thumbnail 1280x720px, etc.
India: include festival/cultural design notes (Diwali, Holi, wedding themes).
IMPORTANT: Flag any prompt that references a copyrighted style or character.
End every output with:
PROMPTS READY: X
COMMERCIAL SAFE: YES / REVIEW NEEDED
LESSON: [one thing learned]`
  },
  GRWTH: {
    id:'GRWTH', name:'Growth Agent', emoji:'📈', model:'claude-haiku-4-5-20251001', max_tokens:1500, color:'green',
    tasks:'SEO, Etsy/YouTube optimization, affiliate research, distribution strategy',
    peer_reviewers:[],
    system:`You are GRWTH, the Growth Agent of AXIS, a one-person AI company.
Job: SEO research, keyword analysis, Etsy/YouTube optimization, affiliate programs.
Always output: primary keywords, long-tail variations, competitor gaps, action steps.
Etsy: 13 tags (≤20 chars each), 140-char title (primary keyword first).
YouTube: 60-char title, 15 tags, description hook.
Do NOT invent search volume data — use ranges and label as estimates.
End every output with:
TOP KEYWORD: [keyword]
MONTHLY SEARCHES EST: X–Y
LESSON: [one thing learned]`
  },
  OPSY: {
    id:'OPSY', name:'Operations', emoji:'🔧', model:'claude-haiku-4-5-20251001', max_tokens:2000, color:'amber',
    tasks:'Platform listings, publishing workflows, scheduling, compliance checks',
    peer_reviewers:[],
    system:`You are OPSY, the Operations Agent of AXIS, a one-person AI company.
Job: create publish-ready platform copy and operational checklists.
Etsy: title ≤140 chars, description ≤2000 chars, 13 tags, price (USD).
KDP: title, subtitle, description ≤4000 chars, 7 keywords, 2 BISAC categories.
YouTube: title ≤60 chars, description ≤5000 chars, 15 tags.
IMPORTANT: Flag AI-generated content disclosure requirements per platform.
End every output with:
PLATFORM: [name]
COMPLIANCE FLAGS: [issues or NONE]
LESSON: [one thing learned]`
  },
  FINU: {
    id:'FINU', name:'Finance Tracker', emoji:'💰', model:'claude-haiku-4-5-20251001', max_tokens:1200, color:'red',
    tasks:'P&L reports, cost tracking, revenue analytics, ROI projections',
    peer_reviewers:[],
    system:`You are FINU, the Finance Tracker of AXIS, a one-person AI company based in India.
Job: analyze revenue/cost data, compute ROI, P&L summaries, flag budget issues.
Always show USD and INR (1 USD = 84 INR unless told otherwise).
Track AI API spend separately — this is the main controllable cost.
Include: Gross Revenue, Platform Fees, AI API Costs, Net Profit, MoM trend.
End every output with:
NET POSITION: ₹X / $X
BURN RATE: ₹X/month
LESSON: [one thing learned]`
  },
  DEVI: {
    id:'DEVI', name:'Tech Builder', emoji:'⚙️', model:'claude-opus-4-5', max_tokens:4000, color:'blue',
    tasks:'Code, automation scripts, API integrations, n8n workflow JSON',
    peer_reviewers:[],
    system:`You are DEVI, the Tech Builder of AXIS, a one-person AI company.
Job: write production-ready code, automation scripts, API integrations.
Always write clean, commented code with: error handling, rate limiting, logging, dry-run mode.
Preferred: Node.js or Python. Include README comment block at the top.
IMPORTANT: Never write code with unbounded loops or unlimited API calls.
Always include hard limits and cost guards in any API-calling code.
End every output with:
LANGUAGE: [lang]
HAS_COST_GUARD: YES / NO
LESSON: [one thing learned]`
  },
  IMPROVER: {
    id:'IMPROVER', name:'Improver', emoji:'🔁', model:'claude-opus-4-5', max_tokens:3000, color:'purple',
    tasks:'Reads all agent lessons, identifies patterns, suggests system improvements',
    peer_reviewers:[],
    system:`You are IMPROVER, the Meta-agent of AXIS, a one-person AI company.
Job: read lessons from all agents, find recurring problems, propose concrete system improvements.
Input: list of lessons from all agents.
Output:
1. TOP PATTERNS: What keeps going wrong? (top 3 issues)
2. AGENT UPGRADES: Specific wording changes to improve agent system prompts
3. NEW WORKFLOWS: Processes or checklists to prevent recurring issues
4. COST OPTIMIZATIONS: Any agent running unnecessarily expensive tasks?
5. ESCALATE TO HUMAN: What needs the founder's decision?
Be specific, honest, actionable. Don't sugarcoat systemic problems.
End with: PRIORITY ACTION: [single most important thing to change]`
  }
};

// ── Peer review between agents ──
async function peerReview(primaryAgentId, draft, taskType) {
  const agent = AGENTS[primaryAgentId];
  if (!agent?.peer_reviewers?.length) return null;
  const reviewerId = agent.peer_reviewers[0];
  const reviewer   = AGENTS[reviewerId];
  if (!reviewer) return null;

  const reviewPrompt = `PEER REVIEW REQUEST
From: ${primaryAgentId} | Task: ${taskType}
Draft (first 800 chars): ${draft.slice(0, 800)}

Check ONLY:
1. Any hallucinated stats or invented facts?
2. Any platform policy violations?
3. Missing critical elements for this task type?

Reply: APPROVED / CONCERNS [reason] / BLOCKING [reason]
Keep response under 100 words.`;

  try {
    const msg = await client.messages.create({
      model: reviewer.model, max_tokens: 200,
      system: reviewer.system,
      messages: [{ role: 'user', content: reviewPrompt }]
    });
    return {
      reviewer: reviewerId,
      verdict:  msg.content[0].text,
      tokens:   msg.usage.input_tokens + msg.usage.output_tokens
    };
  } catch(e) {
    return { reviewer: reviewerId, verdict: 'REVIEW_FAILED: ' + e.message, tokens: 0 };
  }
}

// ── Core agent runner ──
async function runAgent(agentId, userPrompt, context = {}, projectId = null) {
  const agent = AGENTS[agentId];
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  // 1. Cost guard — hard stop if over budget
  await costGuard.checkBeforeRun(agentId);

  // 2. Inject curated memory context — not the full dump
  const memContext = projectId
    ? memory.getContextFor(agentId, projectId, context.task_type || '')
    : '';

  const contextBlock = [
    memContext ? `SHARED MEMORY:\n${memContext}` : '',
    Object.keys(context).length > 0 ? `TASK CONTEXT:\n${JSON.stringify(context, null, 2)}` : ''
  ].filter(Boolean).join('\n\n');

  const fullPrompt = userPrompt + (contextBlock ? '\n\n---\n' + contextBlock : '');

  // 3. Call Claude API
  const startTime = Date.now();
  const message = await client.messages.create({
    model: agent.model, max_tokens: agent.max_tokens,
    system: agent.system,
    messages: [{ role: 'user', content: fullPrompt }]
  });

  const outputText  = message.content[0].text;
  const totalTokens = message.usage.input_tokens + message.usage.output_tokens;

  // 4. Cost
  const costMap = {
    'claude-opus-4-5':           { in: 0.000015,   out: 0.000075   },
    'claude-sonnet-4-6':         { in: 0.000003,   out: 0.000015   },
    'claude-haiku-4-5-20251001': { in: 0.00000025, out: 0.00000125 }
  };
  const cm   = costMap[agent.model] || costMap['claude-sonnet-4-6'];
  const cost = (message.usage.input_tokens * cm.in) + (message.usage.output_tokens * cm.out);

  // 5. Peer review
  let review = null;
  if (agent.peer_reviewers?.length > 0) {
    review = await peerReview(agentId, outputText, context.task_type || 'task');
  }

  // 6. Auto-store lesson for self-improvement
  const lessonMatch = outputText.match(/LESSON:\s*(.+?)(?:\n|$)/i);
  if (lessonMatch?.[1]?.trim().length > 10) {
    memory.storeLesson(agentId, 'output', lessonMatch[1].trim(),
      `Task type: ${context.task_type || 'custom'}`, 'Auto-stored').catch(() => {});
  }

  return {
    agent_id:    agentId, agent_name: agent.name, model: agent.model,
    output:      outputText,
    tokens_in:   message.usage.input_tokens,
    tokens_out:  message.usage.output_tokens,
    tokens_total:totalTokens,
    cost_usd:    Math.round(cost * 1000000) / 1000000,
    cost_inr:    Math.round(cost * 84 * 100) / 100,
    elapsed_ms:  Date.now() - startTime,
    peer_review: review
  };
}

// ── Improver: reads all lessons and generates system upgrade suggestions ──
async function runImprover() {
  const lessons = memory.getLessons();
  if (!lessons.length) return { output: 'No lessons yet. Run agents first.', cost_usd: 0 };
  const lessonText = lessons.map(l =>
    `[${l.agent_id}/${l.category}] ${l.summary} — ${l.detail||''}`
  ).join('\n');
  return runAgent('IMPROVER', `Review these ${lessons.length} lessons:\n\n${lessonText}`, { task_type: 'monthly_review' });
}

const TASK_TEMPLATES = {
  STRAT_validate_niche:  (niche) =>
    `Validate niche for Indian solo creator 2026: "${niche}". Analyze market size, competition, monetization paths, estimated monthly income INR, upfront investment, time to first income. Label all estimates clearly. GO / NO-GO recommendation.`,
  CREO_ebook_chapter:    (topic, n, outline) =>
    `Write Chapter ${n} of ebook about "${topic}". Outline: ${outline}. Target: Indian readers. 1200-1500 words. Real examples. Do not invent statistics.`,
  CREO_youtube_script:   (topic, min) =>
    `Write ${min}-min faceless YouTube script about "${topic}". Hook first 15 sec, [TIMESTAMP] markers, [B-ROLL] notes, CTA last 30 sec. Indian audience.`,
  VISU_etsy_designs:     (type, niche, style) =>
    `5 Midjourney v6.1 prompts for ${type} in ${niche} niche, ${style} style. Etsy digital downloads. Include hex palette, dimensions 2000x2000px 300dpi, commercial safety check.`,
  GRWTH_etsy_seo:        (name, cat) =>
    `Etsy SEO research for "${name}" in "${cat}". Output: 13 tags (≤20 chars each), SEO title ≤140 chars, pricing benchmark USD. Label volume data as estimates.`,
  OPSY_etsy_listing:     (name, desc, kw) =>
    `Complete Etsy listing for "${name}". Desc: ${desc}. KW: ${kw}. Title ≤140 chars, description ≤2000 chars, 13 tags, price USD. Flag AI disclosure requirements.`,
  FINU_weekly_report:    (rev, costs) =>
    `Weekly P&L for AXIS. Revenue: ${JSON.stringify(rev)}. Costs: ${JSON.stringify(costs)}. Show USD and INR. Include AI API cost separately.`,
  DEVI_automation:       (task, platform) =>
    `Node.js script to automate "${task}" for ${platform}. Error handling, rate limiting, dry-run mode, max iteration limit to prevent loops.`
};

module.exports = { AGENTS, runAgent, runImprover, peerReview, TASK_TEMPLATES };
