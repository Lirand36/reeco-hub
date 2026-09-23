// Business actions. Each is one click for a rep; behind it we fan out to the right systems.
// Every action is also written to Snowflake (GTM.HUB_EVENTS) for reporting.

import * as hubspot from './connectors/hubspot.js';
import * as jira from './connectors/jira.js';
import * as intercom from './connectors/intercom.js';
import * as slack from './connectors/slack.js';
import * as snowflake from './connectors/snowflake.js';
import * as claude from './connectors/claude.js';
import { bus } from './bus.js';
import { announce, withActivity } from './activity.js';
import { CLASSIFICATIONS, classify, classificationLabel, fromCloseReason } from './classify.js';
import { CLOSE_REASONS, CONFIG, DEAL_STAGES, ONBOARDING_STEPS, PEOPLE, USERS, db, findAccount, findAccountByEmail, findConversation } from './store.js';

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

const SYSTEM_NAMES = { hubspot: 'HubSpot', jira: 'Jira', intercom: 'Intercom', slack: 'Slack', snowflake: 'Snowflake', claude: 'Claude' };
const first = (name) => String(name).split(' ')[0];
const stageLabel = (id) => DEAL_STAGES.find((x) => x.id === id)?.label ?? id;

// A failed call stops the action; the user gets a plain explanation instead of an HTTP status.
function failIfRejected(entry) {
  if (!entry.ok) throw new HttpError(502, `${SYSTEM_NAMES[entry.system] ?? entry.system} didn't respond, so nothing was changed. Please try again in a minute.`);
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

  failIfRejected(await hubspot.updateDeal(a.deal.id, { dealstage: stage }, 'Update deal stage', `Moved the deal to “${stageLabel(stage)}”`));
  const from = a.deal.stage;
  a.deal.stage = stage;
  await track('deal.stage_changed', a.id, actor, { from, to: stage });
  announce(stage === 'closedlost' ? `${a.name} marked as lost.` : `${a.name} moved to ${stageLabel(stage)}.`, { icon: stage === 'closedlost' ? '•' : '→', accountId: a.id });

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
  ], 'Kickoff checklist', `#${channelName}`);

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
  announce(`${a.name} is a customer! The team was told in #deals, and ${a.csm} has an onboarding plan and a #${channelName} channel ready.`, { icon: '🎉', accountId: a.id });
}

export async function requestDiscount(accountId, { pct, reason }, actor) {
  const a = getAccount(accountId);
  pct = Number(pct);
  need(pct > 0 && pct <= 50, 400, 'Discount must be between 1% and 50%');
  need(!db.approvals.some((p) => p.accountId === a.id && p.status === 'pending'), 409, 'There is already a pending request for this deal');

  if (pct <= CONFIG.discountApprovalThreshold) {
    failIfRejected(await hubspot.updateDeal(a.deal.id, { discount_pct: String(pct) }, 'Apply discount', `Saved the ${pct}% discount on the deal`));
    a.deal.discountPct = pct;
    await track('discount.applied', a.id, actor, { pct });
    announce(`${pct}% discount applied to ${a.name}'s deal.`, { icon: '%', accountId: a.id });
    changed(a.id);
    return { account: a, approvalNeeded: false };
  }

  const approval = { id: `apr_${Date.now()}`, accountId: a.id, dealId: a.deal.id, pct, reason: reason || '', requestedBy: actor, requestedAt: now(), status: 'pending' };
  const msg = await slack.postMessage(slack.channels().dealDesk, `Discount approval needed: ${a.name} ${pct}%`, approvalBlocks(a, approval), 'Request approval');
  failIfRejected(msg);
  approval.slack = { channel: msg.response.channel, ts: msg.response.ts };
  db.approvals.unshift(approval);
  await track('discount.requested', a.id, actor, { pct, approvalId: approval.id });
  const approver = USERS.find((u) => u.approver);
  announce(`Discount request sent. ${approver.name} (${approver.role}) will approve or reject ${pct}% off for ${a.name}.`, { icon: '⏳', tone: 'info', accountId: a.id });
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
    failIfRejected(await hubspot.updateDeal(a.deal.id, { discount_pct: String(p.pct) }, 'Apply approved discount', `Saved the approved ${p.pct}% discount on the deal`));
    a.deal.discountPct = p.pct;
  }
  Object.assign(p, { status: decision, decidedBy: actor, decidedAt: now(), via });

  const icon = decision === 'approved' ? ':white_check_mark:' : ':x:';
  await slack.updateMessage(p.slack.channel, p.slack.ts, `Discount ${decision}: ${a.name} ${p.pct}%`, [
    slack.section(`${icon} *${a.name}: ${p.pct}% discount ${decision}* by ${actor}`),
    slack.context(`Requested by ${p.requestedBy} · decided ${via === 'slack' ? 'in Slack' : 'in Reeco Hub'}`),
  ]);
  await track(`discount.${decision}`, a.id, actor, { pct: p.pct, approvalId: p.id, via });
  announce(decision === 'approved'
    ? `Approved: ${a.name} gets ${p.pct}% off. ${p.requestedBy} can close the deal.`
    : `Rejected: no ${p.pct}% discount for ${a.name}. ${p.requestedBy} was let know.`, { icon: decision === 'approved' ? '✓' : '✕', tone: decision === 'approved' ? 'good' : '', accountId: a.id });
  changed(a.id);
  return { approval: p };
}

export async function addNote(accountId, text, actor) {
  const a = getAccount(accountId);
  need(text?.trim(), 400, 'Note is empty');
  failIfRejected(await hubspot.createNote(a.hubspotCompanyId, `${text.trim()}\n— ${actor}`));
  a.notes.unshift({ text: text.trim(), author: actor, at: now() });
  await track('note.added', a.id, actor, {});
  announce(`Note saved to ${a.name}.`, { icon: '✎', accountId: a.id });
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
  announce(`New Jira ticket ${entry.response.key} opened for ${a.name}.`, { icon: '🎫', accountId: a.id });
  changed(a.id);
  return { account: a, key: entry.response.key };
}

function getConversation(id) {
  const found = findConversation(id);
  need(found, 404, 'Conversation not found');
  return found;
}

const reasonLabel = (id) => CLOSE_REASONS.find((r) => r.id === id)?.label;

// Closing always carries a reason: tagged in Intercom, logged to Snowflake for "why do customers contact us".
async function closeWithReason(a, c, reason, actor) {
  need(reasonLabel(reason), 400, 'Pick a close reason');
  await intercom.tag(c.id, reason, reasonLabel(reason));
  failIfRejected(await intercom.close(c.id));
  Object.assign(c, { state: 'closed', closeReason: reason, closedAt: now(), closedBy: actor, snoozedUntil: null, slaDueAt: null });
  await track('conversation.closed', a.id, actor, { conversationId: c.id, reason });
  announce(`Conversation with ${first(customerOf(c))} at ${a.name} closed as “${reasonLabel(reason)}”.`, { icon: '✓', accountId: a.id });
}

const customerOf = (c) => c.messages.find((m) => m.from === 'customer')?.author ?? 'the customer';

export async function reply(conversationId, text, actor, { close = false, reason } = {}) {
  const { account: a, conversation: c } = getConversation(conversationId);
  need(text?.trim(), 400, 'Message is empty');
  if (close) need(reasonLabel(reason), 400, 'Pick a close reason');
  failIfRejected(await intercom.reply(c.id, text.trim()));
  c.messages.push({ from: 'agent', author: actor, text: text.trim(), at: now() });
  c.updatedAt = now();
  c.slaDueAt = null; // answered
  if (!c.assignee) await assign(c.id, actor, actor, { quiet: true }); // replying takes ownership
  if (close) {
    await closeWithReason(a, c, reason, actor);
    announce(`Reply sent to ${first(customerOf(c))}, and the conversation was closed as “${reasonLabel(reason)}”.`, { icon: '✉', accountId: a.id });
  } else {
    await track('conversation.replied', a.id, actor, { conversationId: c.id });
    announce(`Reply sent to ${first(customerOf(c))} at ${a.name}.`, { icon: '✉', accountId: a.id });
  }
  changed(a.id);
  return { conversation: c };
}

export async function close(conversationId, reason, actor) {
  const { account: a, conversation: c } = getConversation(conversationId);
  need(c.state !== 'closed', 409, 'Already closed');
  await closeWithReason(a, c, reason, actor);
  changed(a.id);
  return { conversation: c };
}

export async function assign(conversationId, assigneeName, actor, { quiet = false } = {}) {
  const { account: a, conversation: c } = getConversation(conversationId);
  const u = assigneeName ? USERS.find((x) => x.name === assigneeName && x.team === 'support') : null;
  need(!assigneeName || u, 400, 'Can only assign to a support agent');
  failIfRejected(await intercom.assign(c.id, u?.intercomAdminId ?? null, u?.name));
  c.assignee = u?.name ?? null;
  await track(u ? 'conversation.assigned' : 'conversation.unassigned', a.id, actor, { conversationId: c.id, assignee: c.assignee });
  if (!quiet) {
    announce(!u ? `${first(customerOf(c))}'s conversation is back in the unassigned queue.`
      : u.name === actor ? `${first(customerOf(c))} at ${a.name} is now yours.`
      : `${first(customerOf(c))}'s conversation assigned to ${u.name}.`, { icon: '👤', accountId: a.id });
  }
  if (!quiet) changed(a.id);
  return { conversation: c };
}

export async function reclassify(conversationId, id, tool, actor) {
  const { account: a, conversation: c } = getConversation(conversationId);
  need(CLASSIFICATIONS.some((x) => x.id === id), 400, 'Unknown classification');
  c.classification = { id, tool: id === 'integration' ? (tool || a.platform?.erp || null) : null };
  c.classifiedBy = 'agent';
  await track('conversation.classified', a.id, actor, { conversationId: c.id, classification: c.classification });
  announce(`${first(customerOf(c))}'s conversation is now classified as ${classificationLabel(c.classification)}.`, { icon: '🏷', tone: 'info', accountId: a.id });
  changed(a.id);
  return { conversation: c };
}

export async function snooze(conversationId, until, actor) {
  const { account: a, conversation: c } = getConversation(conversationId);
  if (!until) {
    failIfRejected(await intercom.reopen(c.id));
    c.snoozedUntil = null;
    await track('conversation.unsnoozed', a.id, actor, { conversationId: c.id });
    announce(`${first(customerOf(c))}'s conversation is back in the queue.`, { icon: '⏰', accountId: a.id });
  } else {
    need(new Date(until) > new Date(), 400, 'Snooze time must be in the future');
    failIfRejected(await intercom.snooze(c.id, until));
    c.snoozedUntil = new Date(until).toISOString();
    await track('conversation.snoozed', a.id, actor, { conversationId: c.id, until: c.snoozedUntil });
    const hours = Math.round((new Date(until) - Date.now()) / 3600_000);
    announce(`Snoozed ${hours >= 12 ? 'until tomorrow' : `for ${hours} hour${hours === 1 ? '' : 's'}`}. It comes back sooner if ${first(customerOf(c))} replies.`, { icon: '💤', tone: 'info', accountId: a.id });
  }
  changed(a.id);
  return { conversation: c };
}

// ---------------------------------------------------------------- AI assist

function accountContext(a, c) {
  const p = a.platform;
  const tickets = a.tickets.filter((t) => t.status !== 'Done');
  return [
    `${a.name}: ${a.segment}, ${a.properties} properties, ${a.status}, health ${a.health ?? 'n/a'}, ${money(a.deal.amount)} ARR. CSM ${a.csm}.`,
    p ? `Platform: ERP ${p.erp}, sync ${p.syncStatus} (${p.syncErrors24h} errors in 24h), app ${p.appVersion}.` : 'Platform: not live yet.',
    tickets.length ? `Open engineering tickets: ${tickets.map((t) => `${t.key} "${t.summary}" (${t.status})`).join('; ')}.` : 'No open engineering tickets.',
    c.escalatedTo ? `This conversation is escalated to ${c.escalatedTo}.` : '',
  ].filter(Boolean).join('\n');
}

// Mock-mode stand-in so the demo works without an API key. Deterministic keyword rules.
function heuristicAssist(a, c, agentName) {
  const last = c.messages.filter((m) => m.from === 'customer').at(-1);
  const all = c.messages.filter((m) => m.from === 'customer').map((m) => m.text).join(' ').toLowerCase();
  const first = last.author.split(' ')[0];
  const agent = agentName.split(' ')[0];
  const has = (re) => re.test(all);
  const sentiment = has(/unacceptable|third time|furious|cancel/) ? 'angry'
    : has(/still|again|broken|blocking|slow/) ? 'frustrated'
    : has(/how do|where do|how can|\?/) ? 'confused' : 'calm';
  const category = has(/netsuite|intacct|quickbooks|sync|gl code|erp/) ? 'integration'
    : has(/duplicate|error|502|broken|misread|wrong|failing/) ? 'bug_workaround'
    : has(/can reeco|feature|would be great|automatically/) ? 'feature_request'
    : has(/billing|pricing|seats?|contract/) ? 'account_billing' : 'how_to';
  const ticket = c.escalatedTo ?? a.tickets.find((t) => t.status !== 'Done' && !t.key.startsWith('ONB'))?.key;
  const sentence = last.text.split(/(?<=[.?!])\s/)[0];
  const erpNote = a.platform && a.platform.syncStatus !== 'ok' ? ` Their ${a.platform.erp} sync is ${a.platform.syncStatus} (${a.platform.syncErrors24h} errors in 24h).` : '';

  const steps = {
    integration: `Check the ${a.platform?.erp ?? 'ERP'} sync logs${ticket ? ` and link this to ${ticket}` : ', then escalate if it reproduces'}.`,
    bug_workaround: ticket ? `Reference ${ticket} and offer a workaround while engineering fixes it.` : 'Reproduce, then escalate to engineering with an example.',
    feature_request: 'Log it for product and set expectations. No timeline promises.',
    how_to: 'Send the relevant guide and offer a 10-minute walkthrough.',
    account_billing: `Loop in ${a.owner} for anything commercial.`,
  };
  const replies = {
    integration: `Hi ${first}, thanks for flagging this, and sorry for the hassle. I can see the ${a.platform?.erp ?? 'ERP'} sync issue on our side${ticket ? ` and it's already with engineering under ${ticket}` : ''}. I'm checking your sync logs now and will update you as soon as I know more. In the meantime, nothing is lost on the Reeco side.\n\n${agent}`,
    bug_workaround: `Hi ${first}, I'm sorry, that shouldn't happen, and I understand the manual work it's causing your team. ${ticket ? `Engineering is actively working on it (${ticket}). ` : ''}While they finish the fix, I'll clean up the affected records for you and keep you posted.\n\n${agent}`,
    feature_request: `Hi ${first}, great question. Reeco doesn't do that automatically yet. I've shared your use case with our product team, and I'll let you know if it makes the roadmap. Happy to show you the closest option we have today.\n\n${agent}`,
    how_to: `Hi ${first}, happy to help! You can set this up under Settings, and I'm sending a short guide with the steps. If it's easier, I can walk you through it on a 10-minute call.\n\n${agent}`,
    account_billing: `Hi ${first}, thanks for reaching out. I've looped in ${a.owner}, your account manager, who will follow up today.\n\n${agent}`,
  };
  const loopCsm = sentiment === 'angry' && a.segment === 'Enterprise' ? `Loop in ${a.csm} (CSM) first. ` : '';
  return {
    summary: `${last.author} (${a.name}): ${sentence}${erpNote}`,
    sentiment,
    category,
    next_step: loopCsm + steps[category],
    suggested_reply: replies[category],
  };
}

export async function aiAssist(conversationId, actor) {
  const { account: a, conversation: c } = getConversation(conversationId);
  need(c.messages.some((m) => m.from === 'customer'), 400, 'Nothing to summarize yet');
  const transcript = c.messages.map((m) => `${m.from === 'customer' ? 'Customer' : 'Agent'} (${m.author}): ${m.text}`).join('\n');
  const out = await claude.assist({
    context: accountContext(a, c),
    transcript,
    agentName: actor,
    categories: CLOSE_REASONS.map((r) => r.id),
    mock: () => heuristicAssist(a, c, actor),
  });
  c.ai = { ...out, forMessages: c.messages.length, at: now() };
  if (c.classifiedBy !== 'agent') c.classification = fromCloseReason(out.category, a) ?? c.classification;
  await track('ai.assist', a.id, actor, { conversationId: c.id, mode: out.mode });
  announce(`Summary and a draft reply are ready for ${first(customerOf(c))}'s conversation.`, { icon: '✨', accountId: a.id });
  changed(a.id);
  return { ai: c.ai };
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
  const vp = PEOPLE.vpSupport;
  announce(`Ticket ${key} escalated to engineering, and ${vp.name} (${vp.title}) was notified.`, { icon: '🚨', accountId: a.id });
  changed(a.id);
  return { conversation: c, key };
}

// Escalation alerts go to #support-escalations and tag the VP Support so nothing sits unseen.
function postEscalation(a, c, headline) {
  const last = c.messages.filter((m) => m.from === 'customer').at(-1);
  const vp = PEOPLE.vpSupport;
  return slack.postMessage(slack.channels().support, `${a.name}: ${c.subject}`, [
    slack.section(`${headline}\n*${a.name}* · ${a.segment} · ${money(a.deal.amount)} ARR · health ${a.health ?? 'n/a'}\ncc <@${vp.slackId}> (${vp.title})`),
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
  c.snoozedUntil = null; // a customer reply wakes a snoozed conversation
  c.messages.push({ from: 'customer', author: a.contact.name, text, at: now() });
  c.updatedAt = now();
  c.slaDueAt = new Date(Date.now() + (CONFIG.slaHours[a.segment] ?? 4) * 3600_000).toISOString();
  if (c.classifiedBy !== 'agent') c.classification = classify(`${c.subject}. ${c.messages.filter((m) => m.from === 'customer').map((m) => m.text).join(' ')}`, a);

  const reasons = [];
  if (a.segment === 'Enterprise') reasons.push('Enterprise account');
  if (isAngry(text)) reasons.push('Upset customer');
  if (reasons.length) {
    c.flagged = reasons;
    await postEscalation(a, c, `:warning: *Auto-flagged:* ${reasons.join(' + ')}`);
  }
  await track('conversation.inbound', a.id, 'intercom', { conversationId: c.id, flagged: reasons });
  const who = `${first(a.contact.name)} at ${a.name}`;
  announce(reasons.length
    ? `New message from ${who} (${classificationLabel(c.classification)}). Flagged for attention, and ${PEOPLE.vpSupport.name} (${PEOPLE.vpSupport.title}) was notified.`
    : `New message from ${who} (${classificationLabel(c.classification)}).`, { icon: reasons.length ? '⚠' : '✉', tone: reasons.length ? 'warn' : 'info', accountId: a.id });
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
      await withActivity('Reeco Hub', async () => {
        await postEscalation(a, c, `:alarm_clock: *SLA breached* (${CONFIG.slaHours[a.segment]}h target, ${a.segment})`);
        await track('sla.breached', a.id, 'system', { conversationId: c.id });
        announce(`${first(customerOf(c))} at ${a.name} has waited longer than the ${CONFIG.slaHours[a.segment]}h target. ${PEOPLE.vpSupport.name} (${PEOPLE.vpSupport.title}) was notified.`, { icon: '⏰', tone: 'bad', accountId: a.id });
      });
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
    announce(ticked.length
      ? `${a.name}: ${ticked.join(' and ')} completed automatically from usage data.`
      : `${a.name}'s usage is up to date. No new milestones yet.`, { icon: ticked.length ? '✓' : '↻', tone: ticked.length ? 'good' : 'info', accountId: a.id });
    await maybeGoLive(a, actor);
  } else {
    announce(`${a.name}'s usage is up to date.`, { icon: '↻', tone: 'info', accountId: a.id });
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
  announce(cur.done ? `“${def.label}” reopened for ${a.name}.` : `“${def.label}” done for ${a.name}. The team was updated in ${a.onboarding.slackChannel}.`, { icon: cur.done ? '↺' : '✓', accountId: a.id });
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
  announce(`${a.name} finished onboarding and is live! The team was told in #deals.`, { icon: '🏁', accountId: a.id });
}
