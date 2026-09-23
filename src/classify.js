// What kind of problem is this conversation? Set when the customer writes in, corrected by the
// agent or refined by AI assist. Keyword rules for the demo; production would use Claude here too.

export const CLASSIFICATIONS = [
  { id: 'how_to', label: 'How-to' },
  { id: 'bug', label: 'Reeco technical issue' },
  { id: 'integration', label: 'Integration' },
  { id: 'feature_request', label: 'Feature request' },
  { id: 'account_billing', label: 'Account / billing' },
];

const TOOLS = [
  [/netsuite/i, 'NetSuite'],
  [/intacct|sage/i, 'Sage Intacct'],
  [/quickbooks|qbo/i, 'QuickBooks'],
  [/opera|pms/i, 'Opera PMS'],
];

export function classify(text, account) {
  const t = String(text).toLowerCase();
  const tool = TOOLS.find(([re]) => re.test(t))?.[1];
  if (tool || /\bsync|\berp\b|gl code/.test(t)) return { id: 'integration', tool: tool ?? account?.platform?.erp ?? null };
  if (/duplicate|error|\b5\d\d\b|broken|misread|wrong|failing|crash|not loading|slow|bug/.test(t)) return { id: 'bug' };
  if (/can reeco|feature|\brequest\b|would be great|automatically|roadmap/.test(t)) return { id: 'feature_request' };
  if (/billing|pricing|seat|contract|renewal|payment|cost/.test(t)) return { id: 'account_billing' };
  return { id: 'how_to' };
}

export const classificationLabel = (c) =>
  !c ? 'Not classified' : c.id === 'integration' && c.tool ? `Integration · ${c.tool}` : CLASSIFICATIONS.find((x) => x.id === c.id)?.label ?? c.id;

// Best starting point for the close reason (bugs are left for the agent: fixed vs workaround).
export const suggestedCloseReason = (c) => ({ how_to: 'how_to', integration: 'integration', feature_request: 'feature_request', account_billing: 'account_billing' })[c?.id] ?? null;

// AI assist returns a close-reason category; map it back to a classification.
export const fromCloseReason = (reason, account) =>
  ({ bug_fixed: { id: 'bug' }, bug_workaround: { id: 'bug' }, integration: { id: 'integration', tool: account?.platform?.erp ?? null }, how_to: { id: 'how_to' }, feature_request: { id: 'feature_request' }, account_billing: { id: 'account_billing' } })[reason] ?? null;
