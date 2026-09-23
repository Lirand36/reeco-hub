// In-memory demo data. All companies and people are fictional.
// In production this becomes a DB kept in sync with HubSpot / Jira / Intercom / Snowflake;
// the IDs below mirror each system's own IDs.

import { classify } from './classify.js';
import { computeHealth } from './health.js';

export const CONFIG = {
  discountApprovalThreshold: 15, // % above which a manager must approve
  slaHours: { Enterprise: 1, 'Mid-market': 4, Independent: 4 },
  angryKeywords: ['unacceptable', 'cancel', 'third time', 'again', 'escalate', 'frustrated', 'furious', 'still broken'],
};

export const DEAL_STAGES = [
  { id: 'appointmentscheduled', label: 'Discovery' },
  { id: 'qualifiedtobuy', label: 'Qualified' },
  { id: 'presentationscheduled', label: 'Demo' },
  { id: 'decisionmakerboughtin', label: 'Champion bought in' },
  { id: 'contractsent', label: 'Contract sent' },
  { id: 'closedwon', label: 'Closed won' },
  { id: 'closedlost', label: 'Closed lost' },
];

// `auto` steps are ticked from Snowflake usage; the rest are ticked by the CSM.
export const ONBOARDING_STEPS = [
  { id: 'vendors', label: 'Vendors connected', auto: (u) => u.vendorsConnected >= 5, hint: '≥ 5 vendors connected' },
  { id: 'catalog', label: 'Catalog & pricing loaded' },
  { id: 'erp', label: 'Accounting / ERP integration' },
  { id: 'training', label: 'Staff trained' },
  { id: 'firstPo', label: 'First purchase order', auto: (u) => u.pos30d > 0, hint: 'first PO in Snowflake' },
  { id: 'firstInvoice', label: 'First AI-processed invoice', auto: (u) => u.invoicesAi30d > 0, hint: 'first AI invoice in Snowflake' },
];

// Why a conversation was closed. Tagged in Intercom and logged to Snowflake for reporting.
export const CLOSE_REASONS = [
  { id: 'bug_fixed', label: 'Platform bug: fixed' },
  { id: 'bug_workaround', label: 'Platform bug: workaround given' },
  { id: 'integration', label: 'ERP / integration issue' },
  { id: 'how_to', label: 'How-to / training' },
  { id: 'feature_request', label: 'Feature request' },
  { id: 'account_billing', label: 'Account / billing' },
  { id: 'no_response', label: 'No response / duplicate' },
];

// People the hub notifies but who don't log in to the demo.
export const PEOPLE = {
  vpSupport: { name: 'Moshe L.', title: 'VP Support', slackId: 'U04MOSHEL' },
};

export const USERS = [
  { id: 'maya', name: 'Maya K.', role: 'Account Executive', team: 'sales' },
  { id: 'eitan', name: 'Eitan B.', role: 'Sales Manager', team: 'sales', approver: true },
  { id: 'ron', name: 'Ron A.', role: 'Support', team: 'support', intercomAdminId: '5823101' },
  { id: 'tal', name: 'Tal G.', role: 'Support', team: 'support', intercomAdminId: '5823114' },
  { id: 'dana', name: 'Dana S.', role: 'Customer Success', team: 'cs', slackId: 'U04DANAS' },
];

// 12 weeks of weekly product usage (oldest → newest), as Snowflake's PRODUCT.WEEKLY_USAGE would return it.
const weeks = (arr) => arr.map((v) => Math.max(0, Math.round(v)));
const ramp = (from, to, n = 12) => Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
const wobble = (arr, amt) => arr.map((v, i) => v * (1 + amt * Math.sin(i * 1.7)));

const ago = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const inDays = (d) => new Date(Date.now() + d * 86400_000).toISOString();
const inH = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const closed = (id, subject, customer, agent, reason, hoursAgo, question, answer) => ({
  id, subject, state: 'closed', assignee: agent, closeReason: reason, updatedAt: ago(hoursAgo), slaDueAt: null,
  messages: [
    { from: 'customer', author: customer, text: question, at: ago(hoursAgo + 2) },
    { from: 'agent', author: agent, text: answer, at: ago(hoursAgo) },
  ],
});
const steps = (done = []) =>
  Object.fromEntries(ONBOARDING_STEPS.map((s) => [s.id, done.includes(s.id) ? { done: true, at: ago(48), by: s.auto ? 'Snowflake' : 'Dana S.' } : { done: false }]));

function seedAccounts() {
  return [
    {
      id: 'harborline', name: 'Harborline Hotel Group', domain: 'harborlinehotels.com', status: 'Prospect',
      segment: 'Enterprise', properties: 14, region: 'US East', owner: 'Maya K.', csm: 'Dana S.', health: null,
      hubspotCompanyId: '9120034411',
      contact: { name: 'Laura Chen', role: 'VP Procurement', email: 'laura.chen@harborlinehotels.com' },
      deal: { id: '18840021', name: 'Harborline: 14-property rollout', amount: 186000, stage: 'contractsent', discountPct: 0 },
      usage: null, onboarding: null,
      tickets: [], conversations: [],
      notes: [{ text: 'Legal redlines back. CFO wants AP automation live before Q1 close.', author: 'Maya K.', at: ago(20) }],
    },
    {
      id: 'olive-court', name: 'The Olive Court Hotel', domain: 'olivecourthotel.com', status: 'Prospect',
      segment: 'Independent', properties: 1, region: 'US West', owner: 'Maya K.', csm: 'Dana S.', health: null,
      hubspotCompanyId: '9120034488',
      contact: { name: 'Marco Rossi', role: 'General Manager', email: 'marco@olivecourthotel.com' },
      deal: { id: '18840107', name: 'Olive Court: single property', amount: 9600, stage: 'presentationscheduled', discountPct: 0 },
      usage: null, onboarding: null,
      tickets: [], conversations: [],
      notes: [{ text: 'Very price sensitive. Currently on spreadsheets + email with 12 vendors.', author: 'Maya K.', at: ago(30) }],
    },
    {
      id: 'northgate', name: 'Northgate Inns', domain: 'northgateinns.com', status: 'Prospect',
      segment: 'Mid-market', properties: 11, region: 'Midwest', owner: 'Maya K.', csm: 'Dana S.', health: null,
      hubspotCompanyId: '9120034502',
      contact: { name: 'Tom Becker', role: 'Director of F&B', email: 'tom.becker@northgateinns.com' },
      deal: { id: '18840230', name: 'Northgate: P2P + inventory', amount: 72000, stage: 'qualifiedtobuy', discountPct: 0 },
      usage: null, onboarding: null,
      tickets: [], conversations: [], notes: [],
    },
    {
      id: 'sable-pine', name: 'Sable & Pine Resorts', domain: 'sableandpine.com', status: 'Onboarding',
      segment: 'Mid-market', properties: 6, region: 'Mountain', owner: 'Maya K.', csm: 'Dana S.', health: 74,
      hubspotCompanyId: '9120034577',
      contact: { name: 'Priya Nair', role: 'Corporate Controller', email: 'priya@sableandpine.com' },
      deal: { id: '18840311', name: 'Sable & Pine: 6 resorts', amount: 54000, stage: 'closedwon', discountPct: 10 },
      usage: { propertiesLive: 2, activeUsers: 23, pos30d: 41, invoicesAi30d: 0, spend30d: 184000, vendorsConnected: 7, lastActive: ago(0.5) },
      renewalDate: inDays(353),
      usageSeries: {
        pos: weeks([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14, 27]), invoicesAi: weeks(Array(12).fill(0)),
        activeUsers: weeks([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11, 23]), syncErrors: weeks([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 14]),
      },
      platform: { erp: 'Sage Intacct', syncStatus: 'failing', lastSyncAt: ago(3), syncErrors24h: 14, appVersion: '4.18.2' },
      onboarding: { startedAt: ago(24 * 12), slackChannel: '#onb-sable-pine', jiraEpic: 'ONB-114', steps: steps(['vendors', 'catalog', 'firstPo']) },
      tickets: [
        { key: 'ONB-114', summary: 'Onboarding: Sable & Pine Resorts', status: 'In Progress', priority: 'High', createdAt: ago(24 * 12) },
        { key: 'SUP-2297', summary: 'Sage Intacct sync: GL codes not mapping for resort #3', status: 'In Progress', priority: 'High', createdAt: ago(40) },
      ],
      conversations: [
        { id: '215469301', subject: 'Invoice capture: how to route to approvers?', state: 'open', assignee: 'Ron A.', updatedAt: ago(2.5), slaDueAt: inH(1.5), messages: [
          { from: 'customer', author: 'Priya Nair', text: 'Where do we set who approves invoices per property? We want GMs to approve under $5k.', at: ago(2.5) },
        ] },
        closed('215468802', 'GL codes missing after Intacct sync', 'Priya Nair', 'Tal G.', 'integration', 40,
          'After yesterday\'s sync, resort #3 invoices have no GL codes in Intacct.', 'Engineering is on it (SUP-2297). I\'ve re-mapped the codes manually for now.'),
      ],
      notes: [{ text: 'Kickoff went well. ERP integration is the long pole (Sage Intacct).', author: 'Dana S.', at: ago(24 * 10) }],
    },
    {
      id: 'meridian', name: 'Meridian Suites', domain: 'meridiansuites.com', status: 'Live',
      segment: 'Enterprise', properties: 22, region: 'US South', owner: 'Maya K.', csm: 'Dana S.', health: 41,
      hubspotCompanyId: '9120034610',
      contact: { name: 'Greg Walsh', role: 'CFO', email: 'greg.walsh@meridiansuites.com' },
      deal: { id: '18840402', name: 'Meridian: renewal + inventory module', amount: 240000, stage: 'decisionmakerboughtin', discountPct: 0 },
      usage: { propertiesLive: 22, activeUsers: 311, pos30d: 2140, invoicesAi30d: 5870, spend30d: 3_420_000, vendorsConnected: 188, lastActive: ago(0.1) },
      renewalDate: inDays(60),
      usageSeries: {
        pos: weeks(wobble(ramp(560, 470), 0.04)), invoicesAi: weeks([1650, 1620, 1680, 1600, 1590, 1540, 1520, 1380, 1250, 1160, 1080, 1010]),
        activeUsers: weeks(wobble(ramp(318, 296), 0.02)), syncErrors: weeks([4, 6, 5, 3, 6, 5, 4, 7, 6, 9, 22, 41]),
      },
      platform: { erp: 'NetSuite', syncStatus: 'degraded', lastSyncAt: ago(0.4), syncErrors24h: 37, appVersion: '4.18.2' },
      onboarding: { startedAt: ago(24 * 300), completedAt: ago(24 * 262), slackChannel: '#onb-meridian', jiraEpic: 'ONB-061', steps: steps(ONBOARDING_STEPS.map((s) => s.id)) },
      tickets: [
        { key: 'SUP-2301', summary: 'Invoices duplicated in NetSuite after AP sync retry', status: 'In Progress', priority: 'Highest', createdAt: ago(30) },
      ],
      conversations: [
        { id: '215469377', subject: 'Duplicate invoices in NetSuite', state: 'open', assignee: null, updatedAt: ago(0.8), slaDueAt: inH(0.2), flagged: ['Enterprise account', 'Upset customer'], messages: [
          { from: 'customer', author: 'Greg Walsh', text: 'This is the third time this month invoices were pushed twice to NetSuite. Our AP team is reconciling by hand. This is unacceptable before renewal.', at: ago(0.8) },
        ] },
        closed('215467710', 'Duplicate invoices after sync retry', 'Greg Walsh', 'Ron A.', 'bug_workaround', 24 * 9,
          'We have 40 invoices duplicated in NetSuite from last night.', 'We rolled back the duplicates and paused auto-retry for your workspace while engineering fixes the root cause.'),
        closed('215466930', 'Add approvers for new property', 'Greg Walsh', 'Tal G.', 'how_to', 24 * 21,
          'How do we add approvers for the new Austin property?', 'Settings → Approval flows → Austin → Add approver. Sent you a 2-min video too.'),
      ],
      notes: [{ text: 'Renewal in 60 days. Health dropped after the NetSuite sync incidents.', author: 'Dana S.', at: ago(12) }],
    },
    {
      id: 'coastal-keys', name: 'Coastal Keys Hospitality', domain: 'coastalkeys.com', status: 'Live',
      segment: 'Mid-market', properties: 9, region: 'Florida', owner: 'Maya K.', csm: 'Dana S.', health: 83,
      hubspotCompanyId: '9120034688',
      contact: { name: 'Ana Lopez', role: 'Purchasing Manager', email: 'ana@coastalkeys.com' },
      deal: { id: '18840455', name: 'Coastal Keys: add recipe costing', amount: 18000, stage: 'appointmentscheduled', discountPct: 0 },
      usage: { propertiesLive: 9, activeUsers: 64, pos30d: 612, invoicesAi30d: 1340, spend30d: 890_000, vendorsConnected: 57, lastActive: ago(0.3) },
      renewalDate: inDays(205),
      usageSeries: {
        pos: weeks(wobble(ramp(142, 156), 0.05)), invoicesAi: weeks([318, 326, 331, 322, 335, 329, 340, 334, 338, 342, 336, 182]),
        activeUsers: weeks(wobble(ramp(60, 64), 0.03)), syncErrors: weeks(Array(12).fill(0)),
      },
      platform: { erp: 'QuickBooks Online', syncStatus: 'ok', lastSyncAt: ago(0.2), syncErrors24h: 0, appVersion: '4.18.2' },
      onboarding: { startedAt: ago(24 * 200), completedAt: ago(24 * 171), slackChannel: '#onb-coastal-keys', jiraEpic: 'ONB-079', steps: steps(ONBOARDING_STEPS.map((s) => s.id)) },
      tickets: [],
      conversations: [
        { id: '215469240', subject: 'Vendor price differs from catalog', state: 'open', assignee: 'Tal G.', updatedAt: ago(1), slaDueAt: inH(3), messages: [
          { from: 'customer', author: 'Ana Lopez', text: 'Sysco invoice shows $4.20/lb for chicken breast but our catalog says $3.85. Can Reeco flag these automatically?', at: ago(1) },
        ] },
        closed('215467002', 'Invoice OCR misread quantity', 'Ana Lopez', 'Ron A.', 'bug_fixed', 24 * 6,
          'The AI read 12 cases as 120 on a US Foods invoice.', 'Thanks for flagging. The fix shipped in 4.18.2 and I corrected that invoice.'),
        closed('215466410', 'Request: par levels per outlet', 'Ana Lopez', 'Tal G.', 'feature_request', 24 * 15,
          'Can we set par levels per outlet?', 'Not yet. I logged it with product and will update you.'),
        closed('215466111', 'Change billing contact', 'Ana Lopez', 'Ron A.', 'account_billing', 24 * 26,
          'Please send invoices to ap@coastalkeys.com from now on.', 'Done, billing contact updated.'),
      ],
      notes: [{ text: 'Happy account, strong upsell fit for recipe costing.', author: 'Maya K.', at: ago(100) }],
    },
    {
      id: 'alder-main', name: 'Alder & Main Hotels', domain: 'alderandmain.com', status: 'Live',
      segment: 'Mid-market', properties: 7, region: 'Pacific NW', owner: 'Maya K.', csm: 'Dana S.', health: null,
      hubspotCompanyId: '9120034721',
      contact: { name: 'Jordan Pike', role: 'Director of Operations', email: 'jordan@alderandmain.com' },
      deal: { id: '18840510', name: 'Alder & Main: annual renewal', amount: 46000, stage: 'closedwon', discountPct: 0 },
      renewalDate: inDays(45),
      usageSeries: {
        pos: weeks([210, 205, 214, 198, 190, 181, 170, 164, 150, 142, 136, 128]), invoicesAi: weeks([420, 412, 425, 401, 380, 362, 344, 330, 312, 298, 284, 270]),
        activeUsers: weeks(ramp(48, 31)), syncErrors: weeks(Array(12).fill(1)),
      },
      platform: { erp: 'QuickBooks Online', syncStatus: 'ok', lastSyncAt: ago(0.4), syncErrors24h: 1, appVersion: '4.18.2' },
      usage: { propertiesLive: 5, activeUsers: 31, pos30d: 556, invoicesAi30d: 1164, spend30d: 402_000, vendorsConnected: 41, lastActive: ago(20) },
      onboarding: { startedAt: ago(24 * 420), completedAt: ago(24 * 380), slackChannel: '#onb-alder-main', jiraEpic: 'ONB-044', steps: steps(ONBOARDING_STEPS.map((s) => s.id)) },
      tickets: [],
      conversations: [
        closed('215465902', 'Two properties stopped using Reeco', 'Jordan Pike', 'Tal G.', 'how_to', 24 * 18,
          'Our Portland and Bend GMs say ordering in Reeco takes longer than email. How do we speed it up?', 'Sent the order-guide templates and booked a 20-min refresher for both GMs.'),
      ],
      notes: [{ text: 'Champion (Sam, former Ops VP) left in August. Jordan is new and still evaluating tools.', author: 'Dana S.', at: ago(24 * 30) }],
    },
    {
      id: 'bluewater', name: 'Bluewater Resorts', domain: 'bluewaterresorts.com', status: 'Live',
      segment: 'Enterprise', properties: 18, region: 'Caribbean', owner: 'Maya K.', csm: 'Dana S.', health: null,
      hubspotCompanyId: '9120034755',
      contact: { name: 'Elena Duarte', role: 'VP Finance', email: 'elena@bluewaterresorts.com' },
      deal: { id: '18840533', name: 'Bluewater: 3-year renewal', amount: 212000, stage: 'closedwon', discountPct: 5 },
      renewalDate: inDays(290),
      usageSeries: {
        pos: weeks(wobble(ramp(820, 960), 0.03)), invoicesAi: weeks(wobble(ramp(2100, 2480), 0.03)),
        activeUsers: weeks(ramp(236, 262)), syncErrors: weeks([2, 1, 3, 2, 2, 1, 2, 3, 1, 2, 2, 1]),
      },
      platform: { erp: 'NetSuite', syncStatus: 'ok', lastSyncAt: ago(0.1), syncErrors24h: 1, appVersion: '4.18.2' },
      usage: { propertiesLive: 18, activeUsers: 262, pos30d: 3780, invoicesAi30d: 9720, spend30d: 5_140_000, vendorsConnected: 214, lastActive: ago(0.05) },
      onboarding: { startedAt: ago(24 * 600), completedAt: ago(24 * 560), slackChannel: '#onb-bluewater', jiraEpic: 'ONB-021', steps: steps(ONBOARDING_STEPS.map((s) => s.id)) },
      tickets: [],
      conversations: [
        closed('215467311', 'Add vendor portal access for new resort', 'Elena Duarte', 'Ron A.', 'how_to', 24 * 11,
          'We opened a new resort in Aruba. How do vendors get portal access?', 'Invites go out from Vendors → Invite. I set up the first five for you.'),
      ],
      notes: [{ text: 'Very happy. Reference customer; open to a case study.', author: 'Dana S.', at: ago(24 * 20) }],
    },
  ];
}

function seedApprovals() {
  return [
    {
      id: 'apr_1001', accountId: 'olive-court', dealId: '18840107', pct: 20, reason: 'Competing with a cheaper spreadsheet-based tool; GM wants year-1 relief.',
      requestedBy: 'Maya K.', requestedAt: ago(3), status: 'pending', slack: { channel: '#deal-desk', ts: '1758620000.000100' },
    },
  ];
}

export const FR_STATUSES = [
  { id: 'submitted', label: 'Submitted' },
  { id: 'under_review', label: 'Under review' },
  { id: 'planned', label: 'Planned' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'shipped', label: 'Shipped' },
  { id: 'declined', label: 'Declined' },
];

function seedFeatureRequests() {
  const req = (accountId, days, source, notified = false) => ({ accountId, requestedAt: ago(24 * days), source, notified });
  return [
    { id: 'fr_412', title: 'Par levels per outlet', jiraKey: 'PROD-412', status: 'planned', updatedAt: ago(24 * 4),
      accounts: [req('coastal-keys', 15, '215466410')] },
    { id: 'fr_418', title: 'Flag vendor prices that differ from the catalog', jiraKey: 'PROD-418', status: 'under_review', updatedAt: ago(24 * 2),
      accounts: [req('coastal-keys', 0.05, '215469240'), req('meridian', 30, null), req('alder-main', 40, null)] },
    { id: 'fr_397', title: 'Invoice approval thresholds per property', jiraKey: 'PROD-397', status: 'shipped', updatedAt: ago(40),
      accounts: [req('sable-pine', 2.5, '215469301'), req('meridian', 70, null, true)] },
    { id: 'fr_365', title: 'Opera PMS occupancy in par-level forecasts', jiraKey: 'PROD-365', status: 'declined', updatedAt: ago(24 * 25),
      accounts: [req('bluewater', 60, null, true)] },
  ];
}

function seedAnomalies() {
  // Already detected before the demo starts; others are found by "Check for anomalies".
  return [
    { id: 'an_1', accountId: 'meridian', metric: 'syncErrors', label: 'NetSuite sync errors', change: 5.6, current: 41, baseline: 6, direction: 'up', severity: 'bad', detectedAt: ago(3), status: 'new' },
  ];
}

export const db = { accounts: [], approvals: [], featureRequests: [], anomalies: [] };

export function reset() {
  db.accounts = seedAccounts();
  for (const a of db.accounts) {
    for (const c of a.conversations) {
      c.classification = classify(c.messages.filter((m) => m.from === 'customer').map((m) => `${c.subject}. ${m.text}`).join(' '), a);
    }
  }
  db.approvals = seedApprovals();
  db.featureRequests = seedFeatureRequests();
  db.anomalies = seedAnomalies();
  for (const a of db.accounts) a.health = computeHealth(a, db.anomalies).score;
}
reset();

export const findAccount = (id) => db.accounts.find((a) => a.id === id);
export const findAccountByEmail = (email) =>
  db.accounts.find((a) => a.contact.email.toLowerCase() === String(email).toLowerCase());
export function findConversation(id) {
  for (const a of db.accounts) {
    const conversation = a.conversations.find((c) => c.id === id);
    if (conversation) return { account: a, conversation };
  }
  return null;
}
