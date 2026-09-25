// Customer Success suggestions: what each account needs next, in the same shape as deal suggestions
// (src/deals.js), so My portfolio, the account's Health tab and Good morning show the same cards.

import { ONBOARDING_STEPS, db } from './store.js';
import { computeHealth } from './health.js';

const DAY = 86400000;
const daysSince = (iso) => Math.floor((Date.now() - new Date(iso)) / DAY);
const first = (name) => String(name).split(' ')[0];
const RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

// Short form of an anomaly for one line: "NetSuite sync errors up 5.6×", "AI-processed invoices down 46%".
export const anomalyShort = (x) => (x.direction === 'up'
  ? `${x.label} up ${x.change >= 2 ? `${x.change.toFixed(1)}×` : `${Math.round((x.change - 1) * 100)}%`}`
  : `${x.label} down ${Math.round(x.change * 100)}%`);

export function accountSuggestions(a) {
  if (a.status === 'Prospect') return [];
  const out = [];
  const h = computeHealth(a, db.anomalies);

  // 1. Usage anomalies to review (Snowflake)
  for (const an of db.anomalies.filter((x) => x.accountId === a.id && x.status === 'new')) {
    out.push({
      type: 'anomaly', key: `anomaly-${an.id}`, anomalyId: an.id, priority: an.severity === 'bad' ? 'high' : 'normal', icon: 'i-trend-down',
      action: an.metric === 'syncErrors' ? 'Look into the sync errors' : 'Look into the usage drop',
      why: anomalyShort(an),
      title: 'Usage anomaly', tag: 'Anomaly',
      detail: `${anomalyShort(an)} last week (${an.current} vs ~${an.baseline} a week), found ${daysSince(an.detectedAt) ? `${daysSince(an.detectedAt)} days ago` : 'today'}. Check with the customer, then mark it reviewed; your note goes to HubSpot.`,
      cta: { kind: 'anomaly', label: 'Review', anomalyId: an.id },
    });
  }

  // 2. At risk: start a save plan (once)
  const atRisk = h.level === 'high' || (h.level === 'medium' && h.renewalDays != null && h.renewalDays <= 90);
  if (atRisk && !a.savePlan) {
    const reasons = h.reasons.filter((r) => !r.startsWith('Usage anomaly'));
    out.push({
      type: 'saveplan', key: 'saveplan', priority: h.level === 'high' ? 'high' : 'normal', icon: 'i-alert',
      action: 'Start a save plan',
      why: `Health ${h.score}${h.renewalDays != null && h.renewalDays <= 90 ? ` · renewal in ${h.renewalDays} days` : ''}`,
      title: `${h.level === 'high' ? 'High' : 'Medium'} risk`, tag: 'At risk',
      detail: `${reasons.slice(0, 3).join(' · ')}. A save plan gets the AE and the customer's exec sponsor aligned before the renewal.`,
      cta: { kind: 'saveplan', label: 'Start a save plan' },
    });
  }

  // 3. A request they made shipped: tell them
  for (const f of db.featureRequests.filter((x) => x.status === 'shipped')) {
    const r = f.accounts.find((x) => x.accountId === a.id && !x.notified);
    if (!r) continue;
    out.push({
      type: 'tell', key: `tell-${f.id}`, frId: f.id, priority: 'normal', icon: 'i-bulb',
      action: `Tell ${first(a.contact.name)} it shipped`,
      why: `“${f.title}” is live`,
      title: 'Request shipped', tag: 'Shipped',
      detail: `${a.contact.name} asked for “${f.title}” ${daysSince(r.requestedAt) ? `${daysSince(r.requestedAt)} days ago` : 'recently'} (${f.jiraKey}). A short message builds goodwill${a.renewalDate ? ' before the renewal' : ''}.`,
      cta: { kind: 'tell', label: 'Send the message', frId: f.id },
    });
  }

  // 4. Onboarding: the next step someone has to do by hand
  if (a.status === 'Onboarding' && a.onboarding) {
    const day = daysSince(a.onboarding.startedAt);
    const next = ONBOARDING_STEPS.find((s) => !s.auto && !a.onboarding.steps[s.id].done);
    const done = ONBOARDING_STEPS.filter((s) => a.onboarding.steps[s.id].done).length;
    if (next) {
      out.push({
        type: 'step', key: `step-${next.id}`, stepId: next.id, priority: day > 10 ? 'high' : 'normal', icon: 'i-check',
        action: `Complete “${next.label}”`,
        why: `Onboarding day ${day} · ${done}/${ONBOARDING_STEPS.length} steps`,
        title: 'Onboarding step', tag: 'Onboarding',
        detail: `Day ${day} of onboarding, ${done} of ${ONBOARDING_STEPS.length} steps done, ${a.usage?.propertiesLive ?? 0}/${a.properties} properties live. Mark “${next.label}” done once it's finished; the team is updated in ${a.onboarding.slackChannel}.`,
        cta: { kind: 'step', label: 'Mark done', stepId: next.id },
      });
    }
  }

  return out.sort((x, y) => RANK[x.priority] - RANK[y.priority]);
}

// One plain line for tables: the most important thing going on with the account.
export function statusLine(a) {
  if (a.status === 'Prospect') return null;
  const h = computeHealth(a, db.anomalies);
  const an = db.anomalies.find((x) => x.accountId === a.id && x.status === 'new');
  if (an) return { text: anomalyShort(an), tone: an.severity === 'bad' ? 'bad' : 'warn' };
  const reason = h.reasons.find((r) => !r.startsWith('Usage anomaly') && !r.startsWith('Renewal in'));
  if (reason) return { text: reason, tone: h.level === 'high' ? 'bad' : h.level === 'medium' ? 'warn' : '' };
  if (a.savePlan) return { text: `Save plan started by ${a.savePlan.by}`, tone: '' };
  return { text: 'No warning signs', tone: 'good' };
}

export function csView(a) {
  const suggestions = accountSuggestions(a);
  return { csSuggestions: suggestions, csStatus: statusLine(a), savePlan: a.savePlan ?? null };
}
