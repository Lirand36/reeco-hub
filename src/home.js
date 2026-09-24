// "Good morning" dashboard: per-role KPIs plus a ranked list of next best actions.
// Each action carries a CTA the UI can render as a link or as a one-click API call.

import { CONFIG, DEAL_STAGES, ONBOARDING_STEPS, db } from './store.js';
import { dealSignals, isOpen } from './deals.js';
import { classificationLabel } from './classify.js';
import { anomalyText, computeHealth } from './health.js';

const RANK = { urgent: 0, high: 1, normal: 2, info: 3 };
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const moneyK = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1000)}K`);
const minsUntil = (iso) => Math.round((new Date(iso) - Date.now()) / 60000);
const daysSince = (iso) => Math.floor((Date.now() - new Date(iso)) / 86400000);
const fmtMins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
const plural = (n, word, many) => `${n} ${n === 1 ? word : many ?? `${word}s`}`;

const link = (label, href) => ({ label, kind: 'link', href });
const call = (label, endpoint, body, done) => ({ label, kind: 'action', endpoint, body, done });

function awaitingReply(c) {
  return c.state === 'open' && c.messages.at(-1)?.from === 'customer';
}

// ---------------------------------------------------------------- support

function support(user) {
  const convs = db.accounts.flatMap((a) => a.conversations.map((c) => ({ a, c })));
  const snoozed = ({ c }) => c.snoozedUntil && new Date(c.snoozedUntil) > new Date();
  const waitingAll = convs.filter((x) => awaitingReply(x.c) && !snoozed(x));
  const mine = waitingAll.filter(({ c }) => c.assignee === user.name);
  const unassigned = waitingAll.filter(({ c }) => !c.assignee);
  const breached = waitingAll.filter(({ c }) => c.slaDueAt && minsUntil(c.slaDueAt) < 0);
  const escalated = convs.filter(({ c }) => c.escalatedTo && c.state === 'open' && c.assignee === user.name);

  const actions = [...mine, ...unassigned].map(({ a, c }) => {
    const m = c.slaDueAt ? minsUntil(c.slaDueAt) : null;
    const last = c.messages.at(-1);
    const priority = m == null ? 'normal' : m < 0 ? 'urgent' : m <= 30 ? 'high' : 'normal';
    const flagged = c.flagged?.length && !c.escalatedTo;
    return {
      id: `reply-${c.id}`, priority, icon: c.assignee ? '✉' : '📥', sort: m ?? 9999,
      title: c.assignee ? `Reply to ${last.author} at ${a.name}` : `Unassigned: ${last.author} at ${a.name}`,
      detail: c.ai && c.ai.forMessages === c.messages.length ? `✨ ${c.ai.summary}` : `“${last.text.length > 120 ? last.text.slice(0, 117) + '…' : last.text}”`,
      badge: a.segment === 'Enterprise' ? 'Enterprise' : null,
      tags: [
        m == null ? null : m < 0 ? { text: `Reply overdue ${fmtMins(-m)}`, tone: 'bad' } : { text: `Reply due in ${fmtMins(m)}`, tone: m <= 30 ? 'warn' : '' },
        { text: classificationLabel(c.classification), tone: 'info' },
        c.escalatedTo ? { text: c.escalatedTo, tone: 'info' } : null,
      ].filter(Boolean),
      cta: link('Reply now', `#/inbox/${c.id}`),
      secondary: !c.assignee
        ? call('Assign to me', `/api/conversations/${c.id}/assign`, { assignee: user.name }, 'Assigned to you in Intercom')
        : flagged ? { ...call('Escalate to engineering', `/api/conversations/${c.id}/escalate`, null, 'Escalated to Jira + Slack'), confirm: 'escalate' } : null,
    };
  });

  for (const { a, c } of escalated.filter(({ c }) => !awaitingReply(c))) {
    actions.push({
      id: `esc-${c.id}`, priority: 'info', icon: '⏳', sort: 0,
      title: `Waiting on engineering: ${c.escalatedTo}`,
      detail: `${a.name}: ${c.subject}. Give the customer an update when Jira moves.`,
      tags: [{ text: c.escalatedTo, tone: 'info' }],
      cta: link('Open conversation', `#/inbox/${c.id}`),
    });
  }

  const parts = [];
  if (mine.length) parts.push(`${plural(mine.length, 'customer')} waiting on you`);
  if (unassigned.length) parts.push(`${unassigned.length} unassigned in the queue`);
  const summary = parts.length
    ? `${parts.join(', ')}${breached.length ? `. ${breached.length} already overdue` : ''}.`
    : 'Inbox zero. Nobody is waiting on you.';

  return {
    summary,
    kpis: [
      { label: 'Waiting on you', value: mine.length },
      { label: 'Unassigned', value: unassigned.length, tone: unassigned.length ? 'warn' : '' },
      { label: 'Overdue replies (team)', value: breached.length, tone: breached.length ? 'bad' : '' },
      { label: 'Yours with engineering', value: escalated.length },
    ],
    actions,
    footer: link('Open inbox', '#/inbox'),
  };
}

// ---------------------------------------------------------------- sales (AE)

const stageName = (id) => DEAL_STAGES.find((x) => x.id === id)?.label ?? id;
// One pipeline signal as a Good morning action; CTAs open the same pop-ups as the Pipeline page.
function dealAction(a, x, { team = false } = {}) {
  const open = (kind, extra = '') => `#/pipeline?do=${kind}&deal=${a.id}${extra}`;
  const cta = {
    followup: () => link(x.cta.label, open('followup')),
    closedate: () => link(x.cta.label, open('closedate')),
    details: () => link(x.cta.label, open('details')),
    stage: () => link(x.cta.label, open('stage', `&to=${x.cta.to}`)),
    ask: () => call(x.cta.label, `/api/accounts/${a.id}/ask-colleague`, { wonId: x.cta.wonId }, 'Asked in Slack'),
  }[x.cta.kind]();
  return {
    id: `deal-${a.id}-${x.type}`, dealId: a.id, priority: x.priority, icon: x.icon, sort: -a.deal.amount / 1e6,
    title: `${a.name}: ${x.title}`, badge: a.segment === 'Enterprise' ? 'Enterprise' : null,
    detail: x.detail,
    tags: [{ text: stageName(a.deal.stage), tone: 'brand' }, { text: `${moneyK(a.deal.amount)} ARR`, tone: '' }, team ? { text: a.owner, tone: '' } : null].filter(Boolean),
    cta: team ? link('Open pipeline', '#/pipeline') : cta,
  };
}

function sales(user) {
  const mine = db.accounts.filter((a) => a.owner === user.name);
  const open = mine.filter((a) => !['closedwon', 'closedlost'].includes(a.deal.stage));
  const actions = [];

  for (const p of db.approvals.filter((p) => p.status === 'pending' && p.requestedBy === user.name)) {
    const a = db.accounts.find((x) => x.id === p.accountId);
    actions.push({
      id: `apr-${p.id}`, priority: 'info', icon: '⏳', sort: 0,
      title: `Waiting on approval: ${a.name}, ${p.pct}% off`,
      detail: `Sent to #deal-desk ${daysSince(p.requestedAt) ? `${daysSince(p.requestedAt)}d` : 'today'}. You can't close the deal until it's decided.`,
      tags: [{ text: 'Deal desk', tone: 'warn' }],
      cta: link('View request', '#/approvals'),
    });
  }

  // Next best actions from the pipeline engine (src/deals.js)
  for (const a of open) {
    // At most two per deal, so one messy deal doesn't bury the rest
    for (const x of dealSignals(a).filter((x) => x.cta && x.priority !== 'low').slice(0, 2)) {
      actions.push(dealAction(a, x));
    }
  }
  for (const a of open) {
    if (a.status === 'Live' && a.health != null && a.health < 50) {
      actions.push({
        id: `risk-${a.id}`, priority: 'high', icon: '⚠', sort: 1,
        title: `${a.name} renewal at risk`,
        detail: `Health ${a.health} with ${plural(a.tickets.filter((t) => t.status !== 'Done').length, 'open ticket')}. Sync with ${a.csm} before pushing the ${moneyK(a.deal.amount)} renewal.`,
        tags: [{ text: `Health ${a.health}`, tone: 'bad' }],
        cta: link('Open account', `#/accounts/${a.id}`),
      });
    }
  }

  const pipeline = open.reduce((s, a) => s + a.deal.amount * (1 - (a.deal.discountPct || 0) / 100), 0);
  const top = new Set(actions.filter((x) => x.priority !== 'info' && x.dealId).map((x) => x.dealId)).size;
  return {
    summary: `${moneyK(pipeline)} open across ${plural(open.length, 'deal')}. ${top ? `${plural(top, 'deal')} need${top === 1 ? 's' : ''} a push today.` : 'Nothing urgent.'}`,
    kpis: [
      { label: 'Open pipeline', value: moneyK(pipeline) },
      { label: 'Open deals', value: open.length },
      { label: 'Gone quiet', value: open.filter((a) => dealSignals(a).some((x) => x.type === 'silent')).length, tone: open.some((a) => dealSignals(a).some((x) => x.type === 'silent')) ? 'warn' : '' },
      { label: 'Awaiting approval', value: db.approvals.filter((p) => p.status === 'pending' && p.requestedBy === user.name).length },
    ],
    actions,
    footer: link('Open pipeline', '#/pipeline'),
  };
}

// ---------------------------------------------------------------- sales manager

function manager(user) {
  const pending = db.approvals.filter((p) => p.status === 'pending');
  const actions = pending.map((p) => {
    const a = db.accounts.find((x) => x.id === p.accountId);
    const hours = Math.floor((Date.now() - new Date(p.requestedAt)) / 3600000);
    return {
      id: `apr-${p.id}`, priority: hours >= 2 ? 'high' : 'normal', icon: '✓', sort: -hours,
      title: `Approve ${p.pct}% off for ${a.name}?`,
      detail: `${money(a.deal.amount)} → ${money(a.deal.amount * (1 - p.pct / 100))} ARR. ${p.requestedBy}: “${p.reason || 'no reason given'}”`,
      tags: [{ text: hours ? `Waiting ${hours}h` : 'Just in', tone: hours >= 2 ? 'warn' : '' }, { text: a.segment, tone: '' }],
      cta: call('Approve', `/api/approvals/${p.id}`, { decision: 'approved' }, `Approved. HubSpot and #deal-desk updated`),
      secondary: call('Reject', `/api/approvals/${p.id}`, { decision: 'rejected' }, 'Rejected. Rep notified in #deal-desk'),
    };
  });
  const open = db.accounts.filter(isOpen);
  // Deals across the team that need a push (high priority only, so it stays short)
  for (const a of open) {
    const x = dealSignals(a).find((y) => y.priority === 'high' && y.type !== 'sign');
    if (x) actions.push({ ...dealAction(a, x, { team: true }), priority: 'normal', sort: 3 });
  }
  const atRisk = db.accounts.filter((a) => a.status === 'Live' && a.health != null && a.health < 50);
  for (const a of atRisk) {
    actions.push({
      id: `risk-${a.id}`, priority: 'normal', icon: '⚠', sort: 5,
      title: `${a.name} renewal at risk (${moneyK(a.deal.amount)})`,
      detail: `Health ${a.health}. AE ${a.owner}, CSM ${a.csm}.`,
      tags: [{ text: `Health ${a.health}`, tone: 'bad' }],
      cta: link('Open account', `#/accounts/${a.id}`),
    });
  }
  return {
    summary: pending.length ? `${plural(pending.length, 'discount')} waiting on your call.` : 'No approvals waiting. Team is unblocked.',
    kpis: [
      { label: 'Pending approvals', value: pending.length, tone: pending.length ? 'warn' : '' },
      { label: 'Team pipeline', value: moneyK(open.reduce((s, a) => s + a.deal.amount, 0)) },
      { label: 'Contracts out', value: open.filter((a) => a.deal.stage === 'contractsent').length },
      { label: 'Renewals at risk', value: atRisk.length, tone: atRisk.length ? 'bad' : '' },
    ],
    actions,
    footer: link('Open approvals', '#/approvals'),
  };
}

// ---------------------------------------------------------------- customer success

function cs(user) {
  const mine = db.accounts.filter((a) => a.csm === user.name && a.status !== 'Prospect');
  const live = mine.filter((a) => a.status === 'Live');
  const onboarding = mine.filter((a) => a.status === 'Onboarding');
  const healthOf = (a) => computeHealth(a, db.anomalies);
  const actions = [];

  // 1. Usage anomalies from Snowflake
  for (const an of db.anomalies.filter((x) => x.status === 'new' && mine.some((a) => a.id === x.accountId))) {
    const a = mine.find((x) => x.id === an.accountId);
    actions.push({
      id: `an-${an.id}`, priority: an.severity === 'bad' ? 'urgent' : 'high', icon: '📉', sort: 0,
      title: `Usage anomaly at ${a.name}`, badge: a.segment === 'Enterprise' ? 'Enterprise' : null,
      detail: `${anomalyText(an)}. Detected by Snowflake ${daysSince(an.detectedAt) ? `${daysSince(an.detectedAt)}d ago` : 'today'}.`,
      tags: [{ text: 'Snowflake', tone: 'info' }],
      cta: link('Investigate', `#/accounts/${a.id}?tab=health`),
      secondary: call('Mark reviewed', `/api/anomalies/${an.id}/ack`, null),
    });
  }

  // 2. Accounts at risk, highest risk first
  for (const a of mine) {
    const h = healthOf(a);
    if (h.level !== 'high' && !(h.level === 'medium' && h.renewalDays != null && h.renewalDays <= 90)) continue;
    actions.push({
      id: `risk-${a.id}`, priority: h.level === 'high' ? 'urgent' : 'high', icon: '⚠', sort: h.score,
      title: `${a.name}: ${h.level} risk (health ${h.score})`, badge: a.segment === 'Enterprise' ? 'Enterprise' : null,
      detail: h.reasons.filter((r) => !r.startsWith('Usage anomaly')).slice(0, 3).join(' · '), // anomalies have their own card
      tags: [h.renewalDays != null ? { text: `Renewal in ${h.renewalDays} days`, tone: h.renewalDays <= 90 ? 'warn' : '' } : null, { text: `${moneyK(a.deal.amount)} ARR`, tone: '' }].filter(Boolean),
      cta: link('Open account', `#/accounts/${a.id}?tab=health`),
      secondary: call('Start save plan', `/api/accounts/${a.id}/notes`, { text: `Save plan started by ${user.name}: exec sponsor call, weekly check-in, fix open issues before renewal.` }),
    });
  }

  // 3. Support on my accounts: escalations and anything overdue or technical
  for (const a of mine) {
    for (const c of a.conversations.filter((x) => x.state === 'open')) {
      const important = c.escalatedTo || (c.slaDueAt && minsUntil(c.slaDueAt) < 0) || ['bug', 'integration'].includes(c.classification?.id);
      if (!important) continue;
      actions.push({
        id: `sup-${c.id}`, priority: c.escalatedTo ? 'high' : 'normal', icon: '🎧', sort: 2,
        title: `Support: ${a.name}, “${c.subject}”`, badge: a.segment === 'Enterprise' ? 'Enterprise' : null,
        detail: `${classificationLabel(c.classification)} · owner ${c.assignee ?? 'unassigned'}${c.escalatedTo ? ` · with engineering (${c.escalatedTo})` : ''}.`,
        tags: [{ text: classificationLabel(c.classification), tone: 'info' }],
        cta: link('View conversation', `#/inbox/${c.id}`),
      });
    }
  }

  // 4. Feature requests that shipped: tell the customer
  for (const f of db.featureRequests.filter((x) => x.status === 'shipped')) {
    for (const r of f.accounts.filter((x) => !x.notified)) {
      const a = mine.find((x) => x.id === r.accountId);
      if (!a) continue;
      actions.push({
        id: `fr-${f.id}-${a.id}`, priority: 'high', icon: '🚀', sort: 1,
        title: `Tell ${a.name}: “${f.title}” is live`,
        detail: `They asked for it ${daysSince(r.requestedAt) ? `${daysSince(r.requestedAt)} days ago` : 'recently'} (${f.jiraKey}). A quick note builds goodwill${a.renewalDate ? ' before renewal' : ''}.`,
        tags: [{ text: 'Shipped', tone: 'good' }],
        cta: call('Tell the customer', `/api/feature-requests/${f.id}/tell`, { accountId: a.id }),
        secondary: link('Open request', `#/requests`),
      });
    }
  }

  // 5. Onboarding
  for (const a of onboarding) {
    const day = daysSince(a.onboarding.startedAt);
    const next = ONBOARDING_STEPS.find((s) => !s.auto && !a.onboarding.steps[s.id].done);
    const done = ONBOARDING_STEPS.filter((s) => a.onboarding.steps[s.id].done).length;
    if (day <= 1 && done === 0) {
      actions.push({
        id: `kick-${a.id}`, priority: 'high', icon: '🚀', sort: 0,
        title: `Kick off ${a.name}`,
        detail: `New customer: ${a.properties} properties. Introduce yourself in ${a.onboarding.slackChannel} and book the kickoff call.`,
        tags: [{ text: 'New customer', tone: 'brand' }],
        cta: link('Open onboarding', `#/accounts/${a.id}`),
      });
    }
    if (next) {
      actions.push({
        id: `step-${a.id}-${next.id}`, priority: day > 10 ? 'high' : 'normal', icon: '☐', sort: 3,
        title: `${a.name}: ${next.label}`,
        detail: `Onboarding day ${day} · ${done}/${ONBOARDING_STEPS.length} steps · ${a.usage?.propertiesLive ?? 0}/${a.properties} properties live.`,
        tags: day > 10 ? [{ text: `Day ${day}`, tone: 'warn' }] : [],
        cta: call('Mark done', `/api/accounts/${a.id}/steps/${next.id}`, null),
        secondary: link('Open', `#/accounts/${a.id}`),
      });
    }
  }

  actions.push({
    id: 'scan', priority: 'info', icon: '❄', sort: 9,
    title: 'Check Snowflake for usage anomalies',
    detail: 'Compares last week with the 4 weeks before for POs, AI invoices, active users and ERP sync errors. Also runs automatically every 30 minutes.',
    tags: [],
    cta: call('Check now', '/api/anomalies/scan', null),
  });

  const scored = mine.map((a) => ({ a, h: healthOf(a) }));
  const high = scored.filter((x) => x.h.level === 'high');
  const arrAtRisk = scored.filter((x) => x.h.level !== 'low').reduce((s, x) => s + x.a.deal.amount, 0);
  const openAnoms = db.anomalies.filter((x) => x.status === 'new' && mine.some((a) => a.id === x.accountId)).length;
  const openSupport = mine.reduce((s, a) => s + a.conversations.filter((c) => c.state === 'open').length, 0);

  return {
    summary: `${plural(mine.length, 'account')} in your portfolio. ${high.length ? `${plural(high.length, 'account')} at high risk` : 'None at high risk'}${openAnoms ? `, ${plural(openAnoms, 'usage anomaly', 'usage anomalies')} to review` : ''}.`,
    kpis: [
      { label: 'ARR at risk', value: moneyK(arrAtRisk), tone: arrAtRisk ? 'warn' : '' },
      { label: 'High-risk accounts', value: high.length, tone: high.length ? 'bad' : '' },
      { label: 'Usage anomalies', value: openAnoms, tone: openAnoms ? 'warn' : '' },
      { label: 'Open support (your accounts)', value: openSupport },
    ],
    actions,
    footer: link('Open my portfolio', '#/portfolio'),
  };
}

export function goodMorning(user) {
  const build = user.approver ? manager : { sales, support, cs }[user.team] ?? sales;
  const data = build(user);
  data.actions.sort((x, y) => RANK[x.priority] - RANK[y.priority] || x.sort - y.sort);
  return { user, ...data, slaHours: CONFIG.slaHours };
}
