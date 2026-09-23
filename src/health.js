// Account health: one 0–100 score built from five explainable parts, so a CSM can see
// *why* an account is at risk, not just that it is. Weights live here in one place.

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const sum = (arr) => arr.reduce((s, v) => s + v, 0);
const daysUntil = (iso) => Math.round((new Date(iso) - Date.now()) / 86400000);

export const HEALTH_WEIGHTS = { usage: 0.3, adoption: 0.15, support: 0.2, platform: 0.15, sentiment: 0.2 };

export const riskLevel = (score) => (score == null ? null : score < 50 ? 'high' : score < 70 ? 'medium' : 'low');

// Volume of POs + AI-processed invoices, last 4 weeks vs the 4 before.
export function usageTrend(a) {
  const s = a.usageSeries;
  if (!s) return null;
  const vol = s.pos.map((v, i) => v + s.invoicesAi[i]);
  const prev = sum(vol.slice(-8, -4));
  const last = sum(vol.slice(-4));
  if (prev < 50) return null; // too new to compare
  return (last - prev) / prev;
}

export function computeHealth(a, anomalies = []) {
  if (a.status === 'Prospect') return { score: null, level: null, parts: [], reasons: [] };
  const open = anomalies.filter((x) => x.accountId === a.id && x.status !== 'resolved');
  const parts = [];

  // 1. Usage trend
  const trend = usageTrend(a);
  parts.push(trend == null
    ? { id: 'usage', label: 'Usage trend', score: 70, detail: 'Too early to compare (onboarding)' }
    : { id: 'usage', label: 'Usage trend', score: clamp(100 + trend * 350 - open.filter((x) => x.metric !== 'syncErrors').length * 10),
      detail: `${trend >= 0 ? 'Up' : 'Down'} ${Math.abs(Math.round(trend * 100))}% vs the previous 4 weeks`, bad: trend <= -0.1 });

  // 2. Adoption: properties live
  const live = a.usage?.propertiesLive ?? 0;
  const adoption = clamp((live / a.properties) * 100);
  parts.push({ id: 'adoption', label: 'Adoption', score: adoption, detail: `${live} of ${a.properties} properties live`, bad: adoption < 60 && a.status === 'Live' });

  // 3. Support load
  const openConvs = a.conversations.filter((c) => c.state === 'open');
  const bugs = a.tickets.filter((t) => t.status !== 'Done' && !t.key.startsWith('ONB'));
  const overdue = openConvs.filter((c) => c.slaDueAt && new Date(c.slaDueAt) < new Date());
  const support = clamp(100 - openConvs.length * 12 - bugs.length * 20 - overdue.length * 15);
  const sDetail = [openConvs.length && `${openConvs.length} open conversation${openConvs.length > 1 ? 's' : ''}`, bugs.length && `${bugs.length} open engineering ticket${bugs.length > 1 ? 's' : ''}`, overdue.length && `${overdue.length} overdue reply`].filter(Boolean);
  parts.push({ id: 'support', label: 'Support load', score: support, detail: sDetail.join(' · ') || 'No open support issues', bad: support < 60 });

  // 4. Platform stability (ERP sync)
  const p = a.platform;
  const platform = !p ? 70 : clamp({ ok: 100, degraded: 55, failing: 25 }[p.syncStatus] - Math.min(20, p.syncErrors24h / 2));
  parts.push({ id: 'platform', label: 'Platform stability', score: platform, detail: p ? `${p.erp} sync ${p.syncStatus} · ${p.syncErrors24h} errors in 24h` : 'Not connected yet', bad: platform < 60 });

  // 5. Sentiment & relationship
  const upset = a.conversations.filter((c) => (c.flagged ?? []).includes('Upset customer') && (c.state === 'open' || Date.now() - new Date(c.updatedAt) < 30 * 86400000));
  const escalated = a.conversations.filter((c) => c.escalatedTo && c.state === 'open');
  const renewalDays = a.renewalDate ? daysUntil(a.renewalDate) : null;
  const championLeft = a.notes.some((n) => /champion .*left|left in/i.test(n.text));
  const warning = trend != null && trend <= -0.1 || upset.length || championLeft;
  const renewalPressure = renewalDays != null && renewalDays <= 90 && warning; // a near renewal amplifies other warning signs
  const sentiment = clamp(90 - upset.length * 45 - escalated.length * 15 - (championLeft ? 30 : 0) - (renewalPressure ? 15 : 0));
  const sParts = [upset.length && 'Customer upset in a recent conversation', championLeft && 'Champion left the company', escalated.length && 'Open escalation'].filter(Boolean);
  parts.push({ id: 'sentiment', label: 'Sentiment', score: sentiment, detail: sParts.join(' · ') || 'No warning signs', bad: sentiment < 60 });

  const score = clamp(sum(parts.map((x) => x.score * HEALTH_WEIGHTS[x.id])));
  const reasons = parts.filter((x) => x.bad).sort((x, y) => x.score - y.score).map((x) => x.detail);
  if (renewalDays != null && renewalDays <= 90) reasons.push(`Renewal in ${renewalDays} days`);
  if (open.length) reasons.unshift(...open.map((x) => `Usage anomaly: ${anomalyText(x)}`));
  return { score, level: riskLevel(score), parts, reasons, renewalDays, trend };
}

export const anomalyText = (x) =>
  x.direction === 'up' ? `${x.label} up ${x.change >= 2 ? `${x.change.toFixed(1)}×` : `${Math.round((x.change - 1) * 100)}%`} (${x.current} vs ~${x.baseline} a week)`
    : `${x.label} down ${Math.round(x.change * 100)}% week over week (${x.current} vs ~${x.baseline})`;
