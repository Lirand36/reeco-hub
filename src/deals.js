// Sales signals: what each open deal needs next, so reps act instead of browsing.
// Used by the Pipeline page (board and table) and the Good morning dashboard.

import { DEAL_STAGES, SILENT_DAYS, STAGE_DAYS, STAGE_GATES, db } from './store.js';

const DAY = 86400000;
const daysSince = (iso) => Math.floor((Date.now() - new Date(iso)) / DAY);
const money = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${n}`);
const first = (name) => String(name).split(' ')[0];
const stageIndex = (id) => DEAL_STAGES.findIndex((s) => s.id === id);
export const isOpen = (a) => !['closedwon', 'closedlost'].includes(a.deal.stage);
const RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

// ---------------------------------------------------------------- stage gates

// Gates to pass when moving from one stage to another. Forward moves collect every gate on
// the way (Discovery → Contract needs the qualify, demo, champion and contract fields).
// Moving back needs nothing; Closed lost only asks why.
export function gatesBetween(from, to) {
  if (to === 'closedlost') return ['closedlost'];
  const i = stageIndex(from), j = stageIndex(to);
  if (j <= i) return [];
  return DEAL_STAGES.slice(i + 1, j + 1).map((s) => s.id).filter((id) => STAGE_GATES[id] && id !== 'closedlost');
}

// Current value of a gate field, falling back to what we already know about the account.
export function fieldValue(a, id) {
  if (id === 'closeDate') return a.deal.closeDate ? a.deal.closeDate.slice(0, 10) : '';
  const v = a.deal.fields[id];
  if (v != null && v !== '') return v;
  if (id === 'properties') return a.properties;
  if (id === 'erp') return a.platform?.erp ?? '';
  return '';
}

const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
export function isRequired(field, values) {
  if (!field.requiredIf) return true;
  const [other, equals] = field.requiredIf;
  return values[other] === equals;
}

// Required fields still missing for the given gates, considering values about to be saved.
export function missingFields(a, gates, incoming = {}) {
  const values = {};
  for (const g of gates) for (const f of STAGE_GATES[g].fields) values[f.id] = f.id in incoming ? incoming[f.id] : fieldValue(a, f.id);
  return gates.flatMap((g) => STAGE_GATES[g].fields.filter((f) => isRequired(f, values) && empty(values[f.id])));
}

// Gates of the stages the deal already passed that still have holes (e.g. a demo with no SE).
export function gapsSoFar(a) {
  const i = stageIndex(a.deal.stage);
  const passed = DEAL_STAGES.slice(1, i + 1).map((s) => s.id).filter((id) => STAGE_GATES[id] && id !== 'closedlost');
  return passed.filter((g) => missingFields(a, [g]).length);
}

// ---------------------------------------------------------------- similar wins

// A colleague's closed-won deal that looks like this one: same segment and ERP, similar size, shared modules.
export function similarWin(a) {
  const erp = fieldValue(a, 'erp');
  const scored = db.wonDeals
    .filter((w) => w.owner !== a.owner)
    .map((w) => {
      let score = 0;
      if (w.segment === a.segment) score += 3;
      if (erp && w.erp === erp) score += 2;
      const ratio = a.properties / w.properties;
      if (ratio >= 0.5 && ratio <= 2) score += 1;
      const shared = (a.deal.modules ?? []).filter((m) => w.modules.includes(m)).length;
      score += Math.min(2, shared);
      return { w, score, shared };
    })
    .filter((x) => x.score >= 6 && x.shared)
    .sort((x, y) => y.score - x.score || new Date(y.w.closedAt) - new Date(x.w.closedAt));
  return scored[0]?.w ?? null;
}

// ---------------------------------------------------------------- signals

const lastInbound = (a) => a.deal.activities.filter((x) => x.dir === 'in').sort((x, y) => y.at.localeCompare(x.at))[0] ?? null;

export function followUpDraft(a) {
  const name = first(a.contact.name);
  const last = lastInbound(a);
  const nextByStage = {
    appointmentscheduled: 'a 20-minute call this week to map where your team spends the most time on ordering and invoices',
    qualifiedtobuy: 'a demo with your team, using a few of your own invoices, so you can see the savings on real numbers',
    presentationscheduled: 'a short follow-up to answer anything that came up in the demo',
    decisionmakerboughtin: 'a call to finalize the business case together before we send the paperwork',
    contractsent: 'a quick call to walk through the order form and anything legal flagged',
  };
  return {
    to: `${a.contact.name} <${a.contact.email}>`,
    subject: last ? `Re: ${last.subject.replace(/^Re:\s*/i, '')}` : `Reeco for ${a.name}`,
    body: `Hi ${name},\n\nI wanted to check in on ${a.deal.name.split(':')[0]}. Would ${nextByStage[a.deal.stage] ?? 'a quick call'} be useful?\n\nIf the timing has changed on your side, just let me know and I'll follow up later.\n\nBest,\n${a.owner}`,
  };
}

const PLAYBOOK = {
  appointmentscheduled: { title: 'Qualify it', detail: 'Capture the pain, ERP and decision maker, then move it to Qualified.', to: 'qualifiedtobuy' },
  qualifiedtobuy: { title: 'Book the demo', detail: 'Pick a date and loop in a Solutions Engineer.', to: 'presentationscheduled' },
  presentationscheduled: { title: 'Confirm the champion', detail: 'Get a named champion and the business value they agree to.', to: 'decisionmakerboughtin' },
  decisionmakerboughtin: { title: 'Send the contract', detail: 'Name the signer and legal contact, and set the close date.', to: 'contractsent' },
  contractsent: { title: 'Get it signed', detail: 'Closing it kicks off onboarding automatically.', to: 'closedwon' },
};

export function dealSignals(a) {
  if (!isOpen(a)) return [];
  const out = [];
  const stage = DEAL_STAGES.find((s) => s.id === a.deal.stage);
  const name = first(a.contact.name);

  // 1. Prospect went quiet
  const last = lastInbound(a);
  const quiet = last ? daysSince(last.at) : null;
  const followedUp = a.deal.followedUpAt && daysSince(a.deal.followedUpAt) < 3;
  if (quiet != null && quiet >= SILENT_DAYS.flag) {
    out.push(followedUp
      ? { type: 'waiting', priority: 'low', icon: '⏳', title: `Followed up with ${name}`, detail: `No reply in ${quiet} days. You followed up ${daysSince(a.deal.followedUpAt) ? `${daysSince(a.deal.followedUpAt)}d ago` : 'today'}; give it a couple of days.` }
      : { type: 'silent', priority: quiet >= SILENT_DAYS.high ? 'high' : 'normal', icon: '💤', title: `${name} has gone quiet`, detail: `No reply from ${a.contact.name} (${a.contact.role}) in ${quiet} days. Last: “${last.subject}”.`, cta: { kind: 'followup', label: 'Draft a follow-up' }, days: quiet });
  }

  // 2. Close date passed
  if (a.deal.closeDate && new Date(a.deal.closeDate) < new Date()) {
    const d = daysSince(a.deal.closeDate);
    out.push({ type: 'overdue', priority: 'high', icon: '📅', title: `Close date passed ${d ? `${d} days ago` : 'today'}`, detail: 'Set a realistic date so the forecast stays honest, or push to close.', cta: { kind: 'closedate', label: 'Update close date' } });
  }

  // 3. Stuck in stage
  const inStage = a.deal.stageEnteredAt ? daysSince(a.deal.stageEnteredAt) : 0;
  if (STAGE_DAYS[a.deal.stage] && inStage > STAGE_DAYS[a.deal.stage]) {
    const p = PLAYBOOK[a.deal.stage];
    out.push({ type: 'stuck', priority: 'normal', icon: '🐢', title: `${inStage} days in ${stage.label}`, detail: `Deals usually move on within ${STAGE_DAYS[a.deal.stage]} days. Next: ${p.title.toLowerCase()}.`, cta: { kind: 'stage', label: p.title, to: p.to } });
  }

  // 4. Required info missing for the stage it's already in
  const gaps = gapsSoFar(a);
  if (gaps.length) {
    const missing = missingFields(a, gaps);
    out.push({ type: 'details', priority: 'normal', icon: '📝', title: 'Deal info missing', detail: `Still needed for ${stage.label}: ${missing.map((f) => f.label.toLowerCase()).join(', ')}.`, cta: { kind: 'details', label: 'Add the details' } });
  }

  // 5. Contract out
  if (a.deal.stage === 'contractsent' && !out.some((x) => x.priority === 'high')) {
    out.push({ type: 'sign', priority: 'high', icon: '✍', title: 'Contract is out. Get it signed', detail: `${money(a.deal.amount)} ARR. Closing it starts onboarding automatically.`, cta: { kind: 'stage', label: 'Mark closed won', to: 'closedwon' } });
  }

  // 6. A colleague won something similar
  const w = a.deal.stage !== 'contractsent' ? similarWin(a) : null;
  if (w) {
    const months = Math.max(1, Math.round(daysSince(w.closedAt) / 30));
    const asked = a.deal.askedColleague?.wonId === w.id;
    out.push({
      type: 'similar', priority: 'normal', icon: '💡', won: w,
      title: `${first(w.owner)} won a similar deal`,
      detail: `${w.owner} closed ${w.account} (${w.segment}, ${w.erp}, ${money(w.amount)}) ${months === 1 ? 'a month' : `${months} months`} ago. Business value: ${w.value}. What worked: ${w.how}.`,
      cta: asked ? null : { kind: 'ask', label: `Ask ${first(w.owner)} in Slack`, wonId: w.id },
      done: asked ? `You asked ${first(w.owner)} ${daysSince(a.deal.askedColleague.at) ? `${daysSince(a.deal.askedColleague.at)}d ago` : 'today'}` : null,
    });
  }

  // 7. Nothing wrong: the next step in the playbook
  if (!out.some((x) => x.type !== 'similar' && x.type !== 'waiting')) {
    const p = PLAYBOOK[a.deal.stage];
    if (p) out.push({ type: 'next', priority: 'low', icon: '→', title: p.title, detail: p.detail, cta: { kind: 'stage', label: p.to === 'closedwon' ? 'Mark closed won' : `Move to ${DEAL_STAGES[stageIndex(p.to)].label}`, to: p.to } });
  }

  return out.sort((x, y) => RANK[x.priority] - RANK[y.priority]);
}

// Everything the pipeline views need about one deal.
export function dealView(a) {
  const signals = dealSignals(a);
  const last = lastInbound(a);
  return {
    lastReplyAt: last?.at ?? null,
    daysInStage: a.deal.stageEnteredAt ? daysSince(a.deal.stageEnteredAt) : null,
    signals,
    next: signals.find((x) => x.type !== 'similar' && x.type !== 'waiting') ?? signals[0] ?? null,
    draft: signals.some((x) => x.type === 'silent') ? followUpDraft(a) : null,
    gaps: gapsSoFar(a),
  };
}
