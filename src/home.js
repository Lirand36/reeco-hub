// "Good morning" dashboard: per-role KPIs plus a ranked list of next best actions.
// Each action carries a CTA the UI can render as a link or as a one-click API call.

import { CONFIG, ONBOARDING_STEPS, db } from './store.js';

const RANK = { urgent: 0, high: 1, normal: 2, info: 3 };
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const moneyK = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1000)}K`);
const minsUntil = (iso) => Math.round((new Date(iso) - Date.now()) / 60000);
const daysSince = (iso) => Math.floor((Date.now() - new Date(iso)) / 86400000);
const fmtMins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const link = (label, href) => ({ label, kind: 'link', href });
const call = (label, endpoint, body, done) => ({ label, kind: 'action', endpoint, body, done });

function awaitingReply(c) {
  return c.state === 'open' && c.messages.at(-1)?.from === 'customer';
}

// ---------------------------------------------------------------- support

function support(user) {
  const convs = db.accounts.flatMap((a) => a.conversations.map((c) => ({ a, c })));
  const waiting = convs.filter(({ c }) => awaitingReply(c));
  const breached = waiting.filter(({ c }) => c.slaDueAt && minsUntil(c.slaDueAt) < 0);
  const atRisk = waiting.filter(({ c }) => c.slaDueAt && minsUntil(c.slaDueAt) >= 0 && minsUntil(c.slaDueAt) <= 30);
  const escalated = convs.filter(({ c }) => c.escalatedTo && c.state === 'open');

  const actions = waiting.map(({ a, c }) => {
    const m = c.slaDueAt ? minsUntil(c.slaDueAt) : null;
    const last = c.messages.at(-1);
    const priority = m == null ? 'normal' : m < 0 ? 'urgent' : m <= 30 ? 'high' : 'normal';
    const flagged = c.flagged?.length && !c.escalatedTo;
    return {
      id: `reply-${c.id}`, priority, icon: '✉', sort: m ?? 9999,
      title: `Reply to ${last.author} at ${a.name}`,
      detail: `“${last.text.length > 120 ? last.text.slice(0, 117) + '…' : last.text}”`,
      tags: [
        m == null ? null : m < 0 ? { text: `SLA breached ${fmtMins(-m)} ago`, tone: 'bad' } : { text: `SLA in ${fmtMins(m)}`, tone: m <= 30 ? 'warn' : '' },
        a.segment === 'Enterprise' ? { text: 'Enterprise', tone: 'brand' } : null,
        ...(c.flagged ?? []).filter((f) => f !== 'Enterprise account').map((f) => ({ text: f, tone: 'bad' })),
        c.escalatedTo ? { text: c.escalatedTo, tone: 'info' } : null,
      ].filter(Boolean),
      cta: link('Reply now', `#/inbox/${c.id}`),
      secondary: flagged ? call('Escalate to engineering', `/api/conversations/${c.id}/escalate`, null, 'Escalated to Jira + Slack') : null,
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

  const summary = waiting.length
    ? `${plural(waiting.length, 'customer')} waiting on a reply${breached.length ? `, ${breached.length} already past SLA` : ''}.`
    : 'Inbox zero. Nobody is waiting on you.';

  return {
    summary,
    kpis: [
      { label: 'Waiting on reply', value: waiting.length },
      { label: 'SLA breached', value: breached.length, tone: breached.length ? 'bad' : '' },
      { label: 'SLA < 30 min', value: atRisk.length, tone: atRisk.length ? 'warn' : '' },
      { label: 'With engineering', value: escalated.length },
    ],
    actions,
    footer: link('Open inbox', '#/inbox'),
  };
}

// ---------------------------------------------------------------- sales (AE)

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

  for (const a of open) {
    const lastNote = a.notes[0]?.at;
    const idle = lastNote ? daysSince(lastNote) : null;
    if (a.deal.stage === 'contractsent') {
      actions.push({
        id: `close-${a.id}`, priority: 'high', icon: '✍', sort: 0,
        title: `${a.name} has the contract. Get it signed.`,
        detail: `${money(a.deal.amount)} ARR · ${a.properties} properties. Closing it kicks off onboarding automatically.`,
        tags: [{ text: 'Contract sent', tone: 'brand' }],
        cta: link('Open deal', `#/accounts/${a.id}`),
      });
    }
    if (idle == null || idle >= 5) {
      actions.push({
        id: `idle-${a.id}`, priority: 'normal', icon: '💤', sort: 1,
        title: `${a.name}: ${idle == null ? 'no activity logged yet' : `quiet for ${idle} days`}`,
        detail: `${a.deal.name} (${money(a.deal.amount)}). Log a next step so the deal doesn't stall.`,
        tags: [],
        cta: link('Add next step', `#/accounts/${a.id}?note=1`),
      });
    }
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
  const top = actions.filter((x) => x.priority !== 'info').length;
  return {
    summary: `${moneyK(pipeline)} open across ${plural(open.length, 'deal')}. ${top ? `${plural(top, 'deal')} need${top === 1 ? 's' : ''} a push today.` : 'Nothing urgent.'}`,
    kpis: [
      { label: 'Open pipeline', value: moneyK(pipeline) },
      { label: 'Open deals', value: open.length },
      { label: 'Contracts out', value: open.filter((a) => a.deal.stage === 'contractsent').length },
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
  const open = db.accounts.filter((a) => !['closedwon', 'closedlost'].includes(a.deal.stage));
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
  const onboarding = db.accounts.filter((a) => a.status === 'Onboarding' && a.csm === user.name);
  const atRisk = db.accounts.filter((a) => a.status === 'Live' && a.health != null && a.health < 50 && a.csm === user.name);
  const actions = [];

  for (const a of onboarding) {
    const day = daysSince(a.onboarding.startedAt);
    const next = ONBOARDING_STEPS.find((s) => !s.auto && !a.onboarding.steps[s.id].done);
    const done = ONBOARDING_STEPS.filter((s) => a.onboarding.steps[s.id].done).length;
    if (day <= 1 && done === 0) {
      actions.push({
        id: `kick-${a.id}`, priority: 'high', icon: '🚀', sort: 0,
        title: `Kick off ${a.name}`,
        detail: `Closed ${day ? 'yesterday' : 'today'}: ${a.properties} properties. Intro yourself in ${a.onboarding.slackChannel} and book the kickoff call.`,
        tags: [{ text: 'New customer', tone: 'brand' }],
        cta: link('Open onboarding', `#/accounts/${a.id}`),
      });
    }
    if (next) {
      actions.push({
        id: `step-${a.id}-${next.id}`, priority: day > 10 ? 'high' : 'normal', icon: '☐', sort: 1,
        title: `${a.name}: ${next.label}`,
        detail: `Day ${day} of onboarding · ${done}/${ONBOARDING_STEPS.length} steps · ${a.usage?.propertiesLive ?? 0}/${a.properties} properties live.`,
        tags: day > 10 ? [{ text: `Day ${day}`, tone: 'warn' }] : [],
        cta: call('Mark done', `/api/accounts/${a.id}/steps/${next.id}`, null, `${next.label} marked done. Posted to ${a.onboarding.slackChannel}`),
        secondary: link('Open', `#/accounts/${a.id}`),
      });
    }
  }

  const autoPending = onboarding.some((a) => ONBOARDING_STEPS.some((s) => s.auto && !a.onboarding.steps[s.id].done));
  if (autoPending) {
    actions.push({
      id: 'sync', priority: 'normal', icon: '❄', sort: 2,
      title: 'Pull fresh usage from Snowflake',
      detail: 'Usage-based steps (vendors, first PO, first AI invoice) tick themselves off when the data shows them.',
      tags: [],
      cta: call('Sync now', '/api/onboarding/sync', null, 'Usage synced from Snowflake'),
    });
  }

  for (const a of atRisk) {
    const open = a.conversations.filter((c) => c.state === 'open').length;
    actions.push({
      id: `risk-${a.id}`, priority: 'high', icon: '⚠', sort: 0,
      title: `${a.name} health is ${a.health}`,
      detail: `${plural(open, 'open conversation')}, ${plural(a.tickets.filter((t) => t.status !== 'Done').length, 'open ticket')}. Renewal (${moneyK(a.deal.amount)}) is with ${a.owner}. Plan a save call.`,
      tags: [{ text: 'At risk', tone: 'bad' }, { text: a.segment, tone: 'brand' }],
      cta: link('Open account', `#/accounts/${a.id}`),
      secondary: call('Add save-plan note', `/api/accounts/${a.id}/notes`, { text: `Save plan started by ${user.name}: exec call + weekly check-in until health > 60.` }, 'Save plan logged to HubSpot'),
    });
  }

  return {
    summary: `${plural(onboarding.length, 'customer')} onboarding${atRisk.length ? `, ${atRisk.length} live ${atRisk.length === 1 ? 'account needs' : 'accounts need'} attention` : ''}.`,
    kpis: [
      { label: 'Onboarding', value: onboarding.length },
      { label: 'Avg. day', value: onboarding.length ? Math.round(onboarding.reduce((s, a) => s + daysSince(a.onboarding.startedAt), 0) / onboarding.length) : '–' },
      { label: 'Properties live', value: `${onboarding.reduce((s, a) => s + (a.usage?.propertiesLive ?? 0), 0)}/${onboarding.reduce((s, a) => s + a.properties, 0)}` },
      { label: 'At-risk accounts', value: atRisk.length, tone: atRisk.length ? 'bad' : '' },
    ],
    actions,
    footer: link('Open onboarding', '#/onboarding'),
  };
}

export function goodMorning(user) {
  const build = user.approver ? manager : { sales, support, cs }[user.team] ?? sales;
  const data = build(user);
  data.actions.sort((x, y) => RANK[x.priority] - RANK[y.priority] || x.sort - y.sort);
  return { user, ...data, slaHours: CONFIG.slaHours };
}
