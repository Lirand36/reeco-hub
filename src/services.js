// Business actions. Each is one click for a rep; behind it we fan out to the right systems.
// Every action is also written to Snowflake (GTM.HUB_EVENTS) for reporting.

import * as hubspot from './connectors/hubspot.js';
import * as jira from './connectors/jira.js';
import * as intercom from './connectors/intercom.js';
import * as slack from './connectors/slack.js';
import * as snowflake from './connectors/snowflake.js';
import { bus } from './bus.js';
import { CONFIG, DEAL_STAGES, ONBOARDING_STEPS, db, findAccount, findAccountByEmail, findConversation } from './store.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const now = () => new Date().toISOString();
const money = (n) => '$' + Number(n).toLocaleString('en-US');
const need = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };
const hubUrl = (path) => `${process.env.PUBLIC_URL || 'http://localhost:3000'}/#${path}`;

function getAccount(id) {
  const a = findAccount(id);
  need(a, 404, 'Account not found');
  return a;
}

function failIfRejected(entry) {
  if (!entry.ok) throw new HttpError(502, `${entry.system} returned ${entry.status}`);
}

const changed = (accountId) => bus.emit('changed', { accountId });
const track = (event, accountId, actor, props) => snowflake.trackEvent(event, accountId, actor, props);

// ---------------------------------------------------------------- sales

export async function changeDealStage(accountId, stage, actor) {
  const a = getAccount(accountId);
  need(DEAL_STAGES.some((s) => s.id === stage), 400, 'Invalid stage');
  if (stage === a.deal.stage) return { account: a };
  const pending = db.approvals.find((p) => p.accountId === a.id && p.status === 'pending');
  need(!(stage === 'closedwon' && pending), 409, 'A discount approval is still pending for this deal');

  failIfRejected(await hubspot.updateDeal(a.deal.id, { dealstage: stage }, 'Update deal stage'));
  const from = a.deal.stage;
  a.deal.stage = stage;
  await track('deal.stage_changed', a.id, actor, { from, to: stage });

  if (stage === 'closedwon') await kickOffOnboarding(a, actor);
  changed(a.id);
  return { account: a };
}

// Automation: closing a deal starts onboarding without anyone leaving the hub.
async function kickOffOnboarding(a, actor) {
  const ch = slack.channels();
  await slack.postMessage(ch.deals, `Closed won: ${a.name} (${money(a.deal.amount)} ARR)`, [
    slack.section(`:tada: *Closed won: ${a.name}*\n${money(a.deal.amount)} ARR · ${a.properties} properties · ${a.segment}`),
    slack.context(`AE: ${actor} · CSM: ${a.csm} · <${hubUrl(`/accounts/${a.id}`)}|Open in Reeco Hub>`),
  ], 'Announce win');

  const epic = await jira.createIssue({
    project: 'onboarding', type: 'Epic', priority: 'High', labels: ['onboarding', 'auto'],
    summary: `Onboarding: ${a.name} (${a.properties} properties)`,
    description: `Closed by ${actor}. ARR ${money(a.deal.amount)}. Contact: ${a.contact.name} (${a.contact.email}). CSM: ${a.csm}.`,
  });

  const channelName = `onb-${a.id}`.slice(0, 80);
  const created = await slack.createChannel(channelName);
  const channelId = created.response?.channel?.id ?? `#${channelName}`;
  await slack.postMessage(channelId, `Onboarding kickoff for ${a.name}`, [
    slack.section(`:rocket: *Onboarding kickoff: ${a.name}*\nCSM *${a.csm}* · Jira epic *${epic.response?.key ?? 'n/a'}*`),
    slack.section(ONBOARDING_STEPS.map((s) => `☐ ${s.label}`).join('\n')),
    slack.context(`Steps marked auto are ticked from Snowflake usage. <${hubUrl(`/accounts/${a.id}`)}|Track in Reeco Hub>`),
  ], 'Kickoff checklist');

  a.status = 'Onboarding';
  a.health = 70;
  a.usage ??= { propertiesLive: 0, activeUsers: 0, pos30d: 0, invoicesAi30d: 0, spend30d: 0, vendorsConnected: 0, lastActive: now() };
  a.onboarding = {
    startedAt: now(),
    slackChannel: `#${channelName}`,
    jiraEpic: epic.response?.key,
    steps: Object.fromEntries(ONBOARDING_STEPS.map((s) => [s.id, { done: false }])),
  };
  if (epic.ok) a.tickets.unshift({ key: epic.response.key, summary: `Onboarding: ${a.name}`, status: 'To Do', priority: 'High', createdAt: now() });
  await track('onboarding.started', a.id, actor, { jiraEpic: epic.response?.key, slackChannel: channelName });
}

export async function requestDiscount(accountId, { pct, reason }, actor) {
  const a = getAccount(accountId);
  pct = Number(pct);
  need(pct > 0 && pct <= 50, 400, 'Discount must be between 1% and 50%');
  need(!db.approvals.some((p) => p.accountId === a.id && p.status === 'pending'), 409, 'There is already a pending request for this deal');

  if (pct <= CONFIG.discountApprovalThreshold) {
    failIfRejected(await hubspot.updateDeal(a.deal.id, { discount_pct: String(pct) }, 'Apply discount'));
    a.deal.discountPct = pct;
    await track('discount.applied', a.id, actor, { pct });
    changed(a.id);
    return { account: a, approvalNeeded: false };
  }

  const approval = { id: `apr_${Date.now()}`, accountId: a.id, dealId: a.deal.id, pct, reason: reason || '', requestedBy: actor, requestedAt: now(), status: 'pending' };
  const msg = await slack.postMessage(slack.channels().dealDesk, `Discount approval needed: ${a.name} ${pct}%`, approvalBlocks(a, approval), 'Request approval');
  failIfRejected(msg);
  approval.slack = { channel: msg.response.channel, ts: msg.response.ts };
  db.approvals.unshift(approval);
  await track('discount.requested', a.id, actor, { pct, approvalId: approval.id });
  changed(a.id);
  return { account: a, approvalNeeded: true, approval };
}

function approvalBlocks(a, p) {
  const net = Math.round(a.deal.amount * (1 - p.pct / 100));
  return [
    slack.section(`:money_with_wings: *Discount approval: ${a.name}*\n*${p.pct}%* off ${money(a.deal.amount)} → *${money(net)}* ARR (threshold ${CONFIG.discountApprovalThreshold}%)`),
    slack.section(`> ${p.reason || 'No reason given'}\nRequested by ${p.requestedBy}`),
    slack.buttons([
      { text: 'Approve', actionId: 'discount_approve', value: p.id, style: 'primary' },
      { text: 'Reject', actionId: 'discount_reject', value: p.id, style: 'danger' },
    ]),
  ];
}

// Called from the hub UI or from Slack's interactivity webhook (the manager clicked a button).
export async function decideApproval(approvalId, decision, actor, via = 'hub') {
  const p = db.approvals.find((x) => x.id === approvalId);
  need(p, 404, 'Approval not found');
  need(p.status === 'pending', 409, `Already ${p.status}`);
  need(['approved', 'rejected'].includes(decision), 400, 'Invalid decision');
  const a = getAccount(p.accountId);

  if (decision === 'approved') {
    failIfRejected(await hubspot.updateDeal(a.deal.id, { discount_pct: String(p.pct) }, 'Apply approved discount'));
    a.deal.discountPct = p.pct;
  }
  Object.assign(p, { status: decision, decidedBy: actor, decidedAt: now(), via });

  const icon = decision === 'approved' ? ':white_check_mark:' : ':x:';
  await slack.updateMessage(p.slack.channel, p.slack.ts, `Discount ${decision}: ${a.name} ${p.pct}%`, [
    slack.section(`${icon} *${a.name}: ${p.pct}% discount ${decision}* by ${actor}`),
    slack.context(`Requested by ${p.requestedBy} · decided ${via === 'slack' ? 'in Slack' : 'in Reeco Hub'}`),
  ]);
  await track(`discount.${decision}`, a.id, actor, { pct: p.pct, approvalId: p.id, via });
  changed(a.id);
  return { approval: p };
}

export async function addNote(accountId, text, actor) {
  const a = getAccount(accountId);
  need(text?.trim(), 400, 'Note is empty');
  failIfRejected(await hubspot.createNote(a.hubspotCompanyId, `${text.trim()}\n— ${actor}`));
  a.notes.unshift({ text: text.trim(), author: actor, at: now() });
  await track('note.added', a.id, actor, {});
  changed(a.id);
  return { account: a };
}

// ---------------------------------------------------------------- support

export async function openTicket(accountId, { summary, description, priority }, actor) {
  const a = getAccount(accountId);
  need(summary?.trim(), 400, 'Summary is required');
  const entry = await jira.createIssue({
    summary: `[${a.name}] ${summary.trim()}`,
    description: `${description || ''}\n\nOpened by ${actor} from Reeco Hub. Account: ${a.domain}, ${a.segment}, ${a.properties} properties.`,
    priority: priority || 'Medium',
    labels: ['customer-reported'],
  });
  failIfRejected(entry);
  a.tickets.unshift({ key: entry.response.key, summary: summary.trim(), status: 'To Do', priority: priority || 'Medium', createdAt: now() });
  await track('ticket.created', a.id, actor, { key: entry.response.key });
  changed(a.id);
  return { account: a, key: entry.response.key };
}

export async function reply(conversationId, text, actor, { close = false } = {}) {
  const found = findConversation(conversationId);
  need(found, 404, 'Conversation not found');
  need(text?.trim(), 400, 'Message is empty');
  const { account: a, conversation: c } = found;
  failIfRejected(await intercom.reply(c.id, text.trim()));
  c.messages.push({ from: 'agent', author: actor, text: text.trim(), at: now() });
  c.updatedAt = now();
  c.slaDueAt = null; // answered
  if (close) {
    await intercom.close(c.id);
    c.state = 'closed';
  }
  await track(close ? 'conversation.closed' : 'conversation.replied', a.id, actor, { conversationId: c.id });
  changed(a.id);
  return { conversation: c };
}

// One click: Jira bug for engineering + internal note in Intercom + alert in Slack.
export async function escalate(conversationId, actor) {
  const found = findConversation(conversationId);
  need(found, 404, 'Conversation not found');
  const { account: a, conversation: c } = found;
  need(!c.escalatedTo, 409, `Already escalated to ${c.escalatedTo}`);
  const last = c.messages.filter((m) => m.from === 'customer').at(-1);

  const issue = await jira.createIssue({
    type: 'Bug',
    priority: a.segment === 'Enterprise' ? 'Highest' : 'High',
    labels: ['escalation', a.segment.toLowerCase()],
    summary: `[${a.name}] ${c.subject}`,
    description: `Escalated by ${actor} from Intercom conversation ${c.id}.\nCustomer: ${last?.author} (${a.segment}, ${a.properties} properties, ${money(a.deal.amount)} ARR).\n\n"${last?.text}"`,
  });
  failIfRejected(issue);
  const key = issue.response.key;
  await intercom.note(c.id, `Escalated to engineering: ${key}`);
  await postEscalation(a, c, `:rotating_light: *Escalated by ${actor}* → Jira *${key}*`);

  c.escalatedTo = key;
  a.tickets.unshift({ key, summary: c.subject, status: 'To Do', priority: a.segment === 'Enterprise' ? 'Highest' : 'High', createdAt: now() });
  await track('conversation.escalated', a.id, actor, { conversationId: c.id, jira: key });
  changed(a.id);
  return { conversation: c, key };
}

function postEscalation(a, c, headline) {
  const last = c.messages.filter((m) => m.from === 'customer').at(-1);
  return slack.postMessage(slack.channels().support, `${a.name}: ${c.subject}`, [
    slack.section(`${headline}\n*${a.name}* · ${a.segment} · ${money(a.deal.amount)} ARR · health ${a.health ?? 'n/a'}`),
    slack.section(`> ${last?.text ?? ''}`),
    slack.context(`<${hubUrl(`/inbox/${c.id}`)}|Open in Reeco Hub>`),
  ], 'Escalation');
}

// First sentence, cut at a word boundary
function subjectFrom(text) {
  const first = text.split(/(?<=[.?!])\s/)[0];
  return first.length <= 60 ? first : first.slice(0, 60).replace(/\s+\S*$/, '') + '…';
}

const isAngry = (text) => CONFIG.angryKeywords.some((k) => text.toLowerCase().includes(k));

// Inbound Intercom webhook (topic conversation.user.created / conversation.user.replied).
export async function ingestIntercom(payload) {
  const item = payload?.data?.item ?? {};
  const email = item.source?.author?.email ?? item.contacts?.contacts?.[0]?.email ?? payload.email;
  const text = String(item.source?.body ?? payload.text ?? 'Hi, can you help?').replace(/<[^>]+>/g, '');
  const a = (email && findAccountByEmail(email)) || db.accounts.find((x) => x.status !== 'Prospect');
  const id = String(item.id ?? Date.now());

  let c = a.conversations.find((x) => x.id === id);
  if (!c) {
    c = { id, subject: item.source?.subject || subjectFrom(text), state: 'open', messages: [] };
    a.conversations.unshift(c);
  }
  c.state = 'open';
  c.messages.push({ from: 'customer', author: a.contact.name, text, at: now() });
  c.updatedAt = now();
  c.slaDueAt = new Date(Date.now() + (CONFIG.slaHours[a.segment] ?? 4) * 3600_000).toISOString();

  const reasons = [];
  if (a.segment === 'Enterprise') reasons.push('Enterprise account');
  if (isAngry(text)) reasons.push('negative sentiment');
  if (reasons.length) {
    c.flagged = reasons;
    await postEscalation(a, c, `:warning: *Auto-flagged:* ${reasons.join(' + ')}`);
  }
  await track('conversation.inbound', a.id, 'intercom', { conversationId: c.id, flagged: reasons });
  bus.emit('inbound', { accountId: a.id, accountName: a.name, conversation: c, flagged: reasons });
  changed(a.id);
  return { ok: true, conversationId: c.id, flagged: reasons };
}

// Runs every 30s: any conversation past its SLA gets one alert in Slack.
export async function checkSla() {
  for (const a of db.accounts) {
    for (const c of a.conversations) {
      if (c.state !== 'open' || !c.slaDueAt || c.slaAlerted || new Date(c.slaDueAt) > new Date()) continue;
      c.slaAlerted = true;
      await postEscalation(a, c, `:alarm_clock: *SLA breached* (${CONFIG.slaHours[a.segment]}h target, ${a.segment})`);
      await track('sla.breached', a.id, 'system', { conversationId: c.id });
      changed(a.id);
    }
  }
}

// ---------------------------------------------------------------- onboarding / CS

// Mock: usage grows a little each sync so the demo shows steps ticking off.
function simulatedUsage(a) {
  const u = a.usage ?? {};
  const step = a.status === 'Onboarding' ? 1 : 0.02;
  const grow = (v, by) => Math.round((v ?? 0) + by * step);
  return {
    properties_live: Math.min(a.properties, (u.propertiesLive ?? 0) + (a.status === 'Onboarding' ? 1 : 0)),
    active_users: grow(u.activeUsers, 6),
    pos_30d: grow(u.pos30d, 14),
    invoices_ai_30d: grow(u.invoicesAi30d, 9),
    spend_30d: grow(u.spend30d, 42000),
    vendors_connected: grow(u.vendorsConnected, 3),
    last_active: now(),
  };
}

export async function syncUsage(accountId, actor) {
  const a = getAccount(accountId);
  need(a.status !== 'Prospect', 400, 'No product usage for prospects');
  const entry = await snowflake.queryUsage(a.hubspotCompanyId, () => simulatedUsage(a));
  failIfRejected(entry);
  const r = snowflake.rowsOf(entry)[0];
  need(r, 404, 'No usage rows in Snowflake for this account');
  a.usage = {
    propertiesLive: Number(r.properties_live), activeUsers: Number(r.active_users), pos30d: Number(r.pos_30d),
    invoicesAi30d: Number(r.invoices_ai_30d), spend30d: Number(r.spend_30d), vendorsConnected: Number(r.vendors_connected), lastActive: r.last_active,
  };

  const ticked = [];
  if (a.onboarding) {
    for (const s of ONBOARDING_STEPS) {
      if (s.auto && !a.onboarding.steps[s.id].done && s.auto(a.usage)) {
        a.onboarding.steps[s.id] = { done: true, at: now(), by: 'Snowflake' };
        ticked.push(s.label);
      }
    }
    if (ticked.length) {
      await slack.postMessage(a.onboarding.slackChannel, `${a.name}: ${ticked.join(', ')}`,
        [slack.section(`:white_check_mark: *Auto-completed from usage data:* ${ticked.join(', ')}`)], 'Onboarding progress');
    }
    await maybeGoLive(a, actor);
  }
  changed(a.id);
  return { account: a, ticked };
}

export async function toggleStep(accountId, stepId, actor) {
  const a = getAccount(accountId);
  need(a.onboarding, 400, 'Account is not onboarding');
  const def = ONBOARDING_STEPS.find((s) => s.id === stepId);
  need(def, 404, 'Unknown step');
  need(!def.auto, 400, 'This step is completed automatically from Snowflake usage');
  const cur = a.onboarding.steps[stepId];
  a.onboarding.steps[stepId] = cur.done ? { done: false } : { done: true, at: now(), by: actor };
  if (!cur.done) {
    await slack.postMessage(a.onboarding.slackChannel, `${a.name}: ${def.label} done`,
      [slack.section(`:white_check_mark: *${def.label}* marked done by ${actor}`)], 'Onboarding progress');
  }
  await track(cur.done ? 'onboarding.step_reopened' : 'onboarding.step_done', a.id, actor, { step: stepId });
  await maybeGoLive(a, actor);
  changed(a.id);
  return { account: a };
}

async function maybeGoLive(a, actor) {
  if (a.status !== 'Onboarding' || !ONBOARDING_STEPS.every((s) => a.onboarding.steps[s.id].done)) return;
  a.status = 'Live';
  a.onboarding.completedAt = now();
  await slack.postMessage(slack.channels().deals, `${a.name} is live`, [
    slack.section(`:checkered_flag: *${a.name} completed onboarding* and is live on Reeco`),
    slack.context(`CSM: ${a.csm}`),
  ], 'Go-live');
  await track('onboarding.completed', a.id, actor, {});
}
