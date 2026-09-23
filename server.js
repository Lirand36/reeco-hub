import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bus } from './src/bus.js';
import { getLog, clearLog } from './src/connectors/http.js';
import * as hubspot from './src/connectors/hubspot.js';
import * as jira from './src/connectors/jira.js';
import * as intercom from './src/connectors/intercom.js';
import * as slack from './src/connectors/slack.js';
import * as snowflake from './src/connectors/snowflake.js';
import * as claude from './src/connectors/claude.js';
import { CLOSE_REASONS, CONFIG, DEAL_STAGES, ONBOARDING_STEPS, PEOPLE, USERS, db, reset } from './src/store.js';
import * as svc from './src/services.js';
import { goodMorning } from './src/home.js';
import { withActivity, announce, getActivities, clearActivities, setActor } from './src/activity.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

async function readRaw(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new svc.HttpError(413, 'Payload too large');
  }
  return raw;
}

function parseJson(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new svc.HttpError(400, 'Invalid JSON'); }
}

const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// https://api.slack.com/authentication/verifying-requests-from-slack
function verifySlack(req, raw) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return; // mock mode
  const ts = req.headers['x-slack-request-timestamp'];
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new svc.HttpError(401, 'Stale Slack request');
  const expected = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
  if (!safeEqual(expected, String(req.headers['x-slack-signature'] || ''))) throw new svc.HttpError(401, 'Bad Slack signature');
}

// https://developers.intercom.com/docs/webhooks/setting-up-webhooks (X-Hub-Signature = sha1 HMAC with client secret)
function verifyIntercom(req, raw) {
  const secret = process.env.INTERCOM_CLIENT_SECRET;
  if (!secret) return;
  const expected = 'sha1=' + createHmac('sha1', secret).update(raw).digest('hex');
  if (!safeEqual(expected, String(req.headers['x-hub-signature'] || ''))) throw new svc.HttpError(401, 'Bad Intercom signature');
}

// Demo auth: the UI sends the selected demo user. Replace with SSO (Google / Okta) in production.
function actorOf(req) {
  const id = String(req.headers['x-user'] || '');
  return USERS.find((u) => u.id === id) ?? USERS[0];
}

const summary = (a) => ({
  id: a.id, name: a.name, domain: a.domain, status: a.status, segment: a.segment, properties: a.properties,
  region: a.region, owner: a.owner, csm: a.csm, health: a.health,
  deal: a.deal, usage: a.usage,
  onboarding: a.onboarding && {
    done: ONBOARDING_STEPS.filter((s) => a.onboarding.steps[s.id].done).length,
    total: ONBOARDING_STEPS.length, startedAt: a.onboarding.startedAt, completedAt: a.onboarding.completedAt,
  },
  openTickets: a.tickets.filter((t) => t.status !== 'Done').length,
  openConversations: a.conversations.filter((c) => c.state === 'open').length,
  pendingApproval: db.approvals.some((p) => p.accountId === a.id && p.status === 'pending'),
});

const integrations = () => [
  { id: 'hubspot', name: 'HubSpot', role: 'CRM: deals, notes', live: hubspot.isLive(), env: ['HUBSPOT_TOKEN'] },
  { id: 'intercom', name: 'Intercom', role: 'Support conversations', live: intercom.isLive(), env: ['INTERCOM_TOKEN', 'INTERCOM_ADMIN_ID', 'INTERCOM_CLIENT_SECRET'] },
  { id: 'jira', name: 'Jira', role: 'Escalations & onboarding epics', live: jira.isLive(), env: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'] },
  { id: 'slack', name: 'Slack', role: 'Alerts, approvals, onboarding channels', live: slack.isLive(), env: ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_CHANNEL_*'] },
  { id: 'snowflake', name: 'Snowflake', role: 'Product usage in, hub events out', live: snowflake.isLive(), env: ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_TOKEN', 'SNOWFLAKE_WAREHOUSE'] },
  { id: 'claude', name: 'Claude', role: 'AI assist: summaries & draft replies', live: claude.isLive(), env: ['ANTHROPIC_API_KEY', 'CLAUDE_MODEL'] },
];

const routes = [
  ['GET', /^\/api\/meta$/, () => ({
    stages: DEAL_STAGES, users: USERS, people: PEOPLE, config: CONFIG, integrations: integrations(), closeReasons: CLOSE_REASONS,
    steps: ONBOARDING_STEPS.map(({ id, label, auto, hint }) => ({ id, label, auto: Boolean(auto), hint })),
  })],
  ['GET', /^\/api\/home$/, (req) => goodMorning(actorOf(req))],
  ['GET', /^\/api\/accounts$/, () => db.accounts.map(summary)],
  ['GET', /^\/api\/accounts\/([\w-]+)$/, (req, [id]) => {
    const a = db.accounts.find((x) => x.id === id);
    if (!a) throw new svc.HttpError(404, 'Account not found');
    return { ...a, approvals: db.approvals.filter((p) => p.accountId === id) };
  }],
  ['GET', /^\/api\/inbox$/, () =>
    db.accounts.flatMap((a) => a.conversations.map((c) => ({ ...c, account: summary(a) })))
      .sort((x, y) => (y.state === 'open') - (x.state === 'open') || y.updatedAt.localeCompare(x.updatedAt))],
  ['GET', /^\/api\/approvals$/, () => db.approvals.map((p) => ({ ...p, account: summary(db.accounts.find((a) => a.id === p.accountId)) }))],
  ['GET', /^\/api\/log$/, () => getLog()],
  // Activity log: one row per user action, with the plain-language steps it caused
  ['GET', /^\/api\/activity$/, () => {
    const steps = getLog();
    return getActivities().map((a) => ({ ...a, steps: steps.filter((e) => e.activityId === a.id).reverse() }));
  }],
  // Why customers contact support: close reasons across all conversations (Snowflake-backed in production)
  ['GET', /^\/api\/support\/reasons$/, () => {
    const counts = Object.fromEntries(CLOSE_REASONS.map((r) => [r.id, 0]));
    for (const a of db.accounts) for (const c of a.conversations) if (c.closeReason) counts[c.closeReason]++;
    return CLOSE_REASONS.map((r) => ({ ...r, count: counts[r.id] }));
  }],

  ['POST', /^\/api\/accounts\/([\w-]+)\/deal-stage$/, (req, [id], b) => svc.changeDealStage(id, b.stage, actorOf(req).name)],
  ['POST', /^\/api\/accounts\/([\w-]+)\/discount$/, (req, [id], b) => svc.requestDiscount(id, b, actorOf(req).name)],
  ['POST', /^\/api\/accounts\/([\w-]+)\/notes$/, (req, [id], b) => svc.addNote(id, b.text, actorOf(req).name)],
  ['POST', /^\/api\/accounts\/([\w-]+)\/tickets$/, (req, [id], b) => svc.openTicket(id, b, actorOf(req).name)],
  ['POST', /^\/api\/accounts\/([\w-]+)\/sync-usage$/, (req, [id]) => svc.syncUsage(id, actorOf(req).name)],
  ['POST', /^\/api\/onboarding\/sync$/, async (req) => {
    const ids = db.accounts.filter((a) => a.status === 'Onboarding').map((a) => a.id);
    const results = [];
    for (const id of ids) results.push(await svc.syncUsage(id, actorOf(req).name));
    const ticked = results.flatMap((r) => r.ticked.map((t) => `${r.account.name}: ${t}`));
    announce(ticked.length ? `Usage synced. Completed automatically: ${ticked.join('; ')}.` : 'Usage synced. No new onboarding milestones yet.', { icon: ticked.length ? '✓' : '↻', tone: ticked.length ? 'good' : 'info' });
    return { ticked };
  }],
  ['POST', /^\/api\/accounts\/([\w-]+)\/steps\/(\w+)$/, (req, [id, step]) => svc.toggleStep(id, step, actorOf(req).name)],
  ['POST', /^\/api\/conversations\/([\w-]+)\/reply$/, (req, [id], b) => svc.reply(id, b.text, actorOf(req).name, { close: Boolean(b.close), reason: b.reason })],
  ['POST', /^\/api\/conversations\/([\w-]+)\/close$/, (req, [id], b) => svc.close(id, b.reason, actorOf(req).name)],
  ['POST', /^\/api\/conversations\/([\w-]+)\/assign$/, (req, [id], b) => svc.assign(id, b.assignee ?? null, actorOf(req).name)],
  ['POST', /^\/api\/conversations\/([\w-]+)\/snooze$/, (req, [id], b) => svc.snooze(id, b.until ?? null, actorOf(req).name)],
  ['POST', /^\/api\/conversations\/([\w-]+)\/ai$/, (req, [id]) => svc.aiAssist(id, actorOf(req).name)],
  ['POST', /^\/api\/conversations\/([\w-]+)\/escalate$/, (req, [id]) => svc.escalate(id, actorOf(req).name)],
  ['POST', /^\/api\/approvals\/([\w-]+)$/, (req, [id], b) => {
    const user = actorOf(req);
    if (!user.approver) throw new svc.HttpError(403, `${user.role}s can't approve discounts`);
    return svc.decideApproval(id, b.decision, user.name, 'hub');
  }],
  ['POST', /^\/api\/reset$/, () => {
    reset();
    clearLog();
    clearActivities();
    bus.emit('changed', { reset: true });
    announce('Demo data reset. Everything is back to the starting point.', { icon: '↺', tone: 'info' });
    return { ok: true };
  }],
];

// Inbound webhooks need the raw body for signature checks, so they are handled separately.
async function handleWebhook(req, res, source) {
  const raw = await readRaw(req);
  if (source === 'intercom') {
    verifyIntercom(req, raw);
    return json(res, 200, await svc.ingestIntercom(parseJson(raw)));
  }
  if (source === 'slack') {
    verifySlack(req, raw);
    // Slack interactivity posts application/x-www-form-urlencoded with a `payload` JSON field
    const payload = JSON.parse(new URLSearchParams(raw).get('payload') || '{}');
    const action = payload.actions?.[0];
    if (!action) return json(res, 400, { error: 'No action' });
    // Only listed Slack users may approve (comma-separated Slack user IDs). Unset = demo mode.
    const allowed = (process.env.SLACK_APPROVER_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(payload.user?.id)) throw new svc.HttpError(403, 'Not an approver');
    const who = payload.user?.name || USERS.find((u) => u.approver).name;
    setActor(`${who} (in Slack)`);
    const decision = action.action_id === 'discount_approve' ? 'approved' : 'rejected';
    const result = await svc.decideApproval(action.value, decision, who, 'slack');
    return json(res, 200, { ok: true, status: result.approval.status });
  }
  json(res, 404, { error: 'Unknown webhook source' });
}

function sse(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  const handlers = Object.fromEntries(['integration', 'inbound', 'changed', 'activity'].map((type) => [type, (data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)]));
  for (const [t, h] of Object.entries(handlers)) bus.on(t, h);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    for (const [t, h] of Object.entries(handlers)) bus.off(t, h);
  });
}

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)));
  if (rel.startsWith('..')) return json(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(join(PUBLIC_DIR, rel));
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/events') return sse(req, res);
    if (pathname === '/healthz') return json(res, 200, { ok: true });
    const hook = pathname.match(/^\/webhooks\/(\w+)/);
    if (hook && req.method === 'POST') return await withActivity(hook[1] === 'slack' ? 'Slack' : 'Intercom', () => handleWebhook(req, res, hook[1]));

    for (const [method, pattern, handler] of routes) {
      const m = pathname.match(pattern);
      if (!m || req.method !== method) continue;
      const body = method === 'POST' ? parseJson(await readRaw(req)) : undefined;
      const run = () => handler(req, m.slice(1), body);
      return json(res, 200, await (method === 'POST' ? withActivity(actorOf(req).name, run) : run()));
    }
    if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(pathname, res);
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    json(res, status, { error: err.message });
  }
});

setInterval(() => svc.checkSla().catch((e) => console.error('SLA check failed', e)), 30_000);

server.listen(PORT, () => {
  console.log(`Reeco Hub → http://localhost:${PORT}`);
  console.log(integrations().map((i) => `${i.name}: ${i.live ? 'live' : 'mock'}`).join(' · '));
});
