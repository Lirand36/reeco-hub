// Reeco Hub: front end. Plain JS, no build step: hash routing + template strings.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');

const SYSTEMS = {
  hubspot: { name: 'HubSpot', color: 'var(--hubspot)', letter: 'H' },
  intercom: { name: 'Intercom', color: 'var(--intercom)', letter: 'I' },
  jira: { name: 'Jira', color: 'var(--jira)', letter: 'J' },
  slack: { name: 'Slack', color: 'var(--slack)', letter: 'S' },
  snowflake: { name: 'Snowflake', color: 'var(--snowflake)', letter: '❄' },
  claude: { name: 'Claude', color: 'var(--claude)', letter: '✦' },
};

const state = { meta: null, log: [], logFilter: null, flashId: null };

// ---------- helpers ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Math.round(Number(n || 0)).toLocaleString('en-US');
const compact = (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const moneyCompact = (n) => '$' + compact(n);
function relText(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const rel = (iso) => `<time datetime="${esc(iso)}" title="${esc(new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}">${relText(iso)}</time>`;
const days = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso)) / 86400000));
const stageLabel = (id) => state.meta.stages.find((s) => s.id === id)?.label ?? id;
const src = (sys, text) => `<span class="src ${sys}">${esc(text ?? SYSTEMS[sys].name)}</span>`;
const user = () => state.meta.users.find((u) => u.id === $('#user').value) ?? state.meta.users[0];

const healthBar = (h) => h == null ? '<span class="muted small">n/a</span>' :
  `<div class="health"><div class="bar"><span style="width:${h}%;background:${h >= 75 ? 'var(--good)' : h >= 50 ? 'var(--warn)' : 'var(--bad)'}"></span></div><span class="small num">${h}</span></div>`;
const statusChip = (s) => `<span class="chip ${s === 'Live' ? 'good' : s === 'Onboarding' ? 'info' : ''}">${esc(s)}</span>`;
const priorityChip = (p) => `<span class="chip ${/High/.test(p) ? 'bad' : p === 'Medium' ? 'warn' : ''}">${esc(p)}</span>`;
const ticketStatus = (s) => `<span class="chip ${s === 'Done' ? 'good' : s === 'In Progress' ? 'info' : ''}">${esc(s)}</span>`;

function slaChip(c) {
  if (c.state !== 'open' || !c.slaDueAt) return '';
  const mins = Math.round((new Date(c.slaDueAt) - Date.now()) / 60000);
  if (mins < 0) return `<span class="chip bad" title="Past the response-time target">Reply overdue ${fmtMins(-mins)}</span>`;
  return `<span class="chip ${mins <= 30 ? 'warn' : ''}" title="Time left to reply within the target">Reply due in ${fmtMins(mins)}</span>`;
}
// How urgent a conversation is, in words: drives the colored status line and left edge.
function urgency(c) {
  if (c.state !== 'open' || !c.slaDueAt) return null;
  const mins = Math.round((new Date(c.slaDueAt) - Date.now()) / 60000);
  if (mins < 0) return { tone: 'bad', text: `Reply overdue ${fmtMins(-mins)}` };
  return { tone: mins <= 30 ? 'warn' : 'calm', text: `Reply due in ${fmtMins(mins)}` };
}
const segBadge = (seg) => (seg === 'Enterprise' ? '<span class="seg-badge" title="Enterprise customer">Enterprise</span>' : '');

function confirmEscalate() {
  const vp = state.meta.people.vpSupport;
  return confirmDialog({
    title: 'Escalate to engineering?',
    body: `<p class="muted" style="margin-bottom:8px">This will:</p><ul class="small plain-list">
      <li>Open a high-priority bug in Jira with this conversation attached</li>
      <li>Alert <b>#support-escalations</b> in Slack and notify <b>${esc(vp.name)} (${esc(vp.title)})</b></li>
      <li>Leave an internal note in Intercom so the team sees it</li></ul>`,
    confirmLabel: 'Escalate',
    danger: true,
  });
}

const fmtMins = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User': user().id },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(html, { system, error, tone, ms = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${system ?? ''} ${tone ? `t-${tone}` : ''} ${error ? 'error' : ''}`;
  el.setAttribute('role', error ? 'alert' : 'status');
  el.innerHTML = `${html}<button class="t-close" aria-label="Dismiss"><svg class="ico"><use href="#i-x"/></svg></button>`;
  const box = $('#toasts');
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  let timer;
  const arm = () => { timer = setTimeout(() => el.remove(), error ? ms * 2 : ms); };
  el.addEventListener('mouseenter', () => clearTimeout(timer)); // hovering keeps it open to read
  el.addEventListener('mouseleave', arm);
  $('.t-close', el).addEventListener('click', () => el.remove());
  arm();
}

// Runs an action with the button disabled; errors become a toast.
async function run(btn, fn) {
  if (btn) { btn.disabled = true; btn.classList.add('busy'); btn.setAttribute('aria-busy', 'true'); }
  try { return await fn(); }
  catch (err) { toast(`<strong>Couldn't complete:</strong> ${esc(err.message)}`, { error: true }); }
  finally { if (btn) { btn.disabled = false; btn.classList.remove('busy'); btn.removeAttribute('aria-busy'); } }
}

// ---------- live updates ----------
let renderTimer;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    // Don't wipe out something the user is typing
    const a = document.activeElement;
    if (a && view.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.value) return;
    if ($('#modal').open) return;
    route({ keepScroll: true });
  }, 250);
}

function connectEvents() {
  const es = new EventSource('/api/events');
  // Raw system calls aren't shown to users; they only refresh the activity log if it's open.
  es.addEventListener('integration', () => { if (location.hash.startsWith('#/log')) scheduleRender(); });
  es.addEventListener('activity', (e) => {
    const x = JSON.parse(e.data);
    const byOther = x.actor && x.actor !== user().name;
    toast(`<div class="t-body"><span class="t-ico" aria-hidden="true">${esc(x.icon)}</span>
      <div><div>${esc(x.text)}</div>${byOther ? `<div class="muted xs">by ${esc(x.actor)}</div>` : ''}</div></div>
      <a class="link xs t-more" href="#/log?open=${esc(x.id)}">Details</a>`, { tone: x.tone || 'good', ms: 6000 });
  });
  es.addEventListener('inbound', (e) => { state.flashId = JSON.parse(e.data).conversation.id; });
  es.addEventListener('changed', () => {
    refreshBadges();
    scheduleRender();
  });
}

async function refreshBadges() {
  const [inbox, approvals] = await Promise.all([api('/api/inbox'), api('/api/approvals')]);
  const set = (id, n) => { const b = $(id); b.hidden = !n; b.textContent = n; };
  set('#badge-inbox', inbox.filter((c) => c.state === 'open').length);
  set('#badge-approvals', approvals.filter((p) => p.status === 'pending').length);
  const accounts = await api('/api/accounts');
  set('#badge-portfolio', accounts.filter((a) => a.csm === user().name).reduce((n, a) => n + a.anomalies.length, 0));
}


// ---------- CS building blocks ----------
const RISK = { high: { label: 'High risk', tone: 'bad' }, medium: { label: 'Medium risk', tone: 'warn' }, low: { label: 'Healthy', tone: 'good' } };
const riskChip = (level, score) => (level ? `<span class="chip ${RISK[level].tone}"><span class="dot" aria-hidden="true"></span>${RISK[level].label}${score != null ? ` · ${score}` : ''}</span>` : '<span class="muted small">–</span>');
const trendText = (pct) => (pct == null ? '<span class="muted">too early</span>' : `<span class="${pct <= -10 ? 'tone-bad' : pct >= 5 ? 'tone-good' : ''}">${pct > 0 ? '↑' : pct < 0 ? '↓' : '→'} ${Math.abs(pct)}%</span>`);

// Single-series sparkline: 2px line, marker on the latest point, hover title per week.
function sparkline(values, { label = '', alert = false, w = 160, h = 40 } = {}) {
  if (!values?.length) return '';
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const x = (i) => 4 + (i * (w - 8)) / (values.length - 1);
  const y = (v) => h - 4 - ((v - min) / (max - min || 1)) * (h - 8);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values.length - 1;
  const weekOf = (i) => new Date(Date.now() - (last - i) * 7 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `<svg class="spark ${alert ? 'alert' : ''}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}: ${values.join(', ')} over the last ${values.length} weeks">
    <polyline points="${pts}" fill="none" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(last)}" cy="${y(values[last])}" r="4" class="last"/>
    ${values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="9" class="hit"><title>Week of ${weekOf(i)}: ${v.toLocaleString('en-US')}</title></circle>`).join('')}
  </svg>`;
}

const FR_FLOW = ['submitted', 'under_review', 'planned', 'in_progress', 'shipped'];
const frLabel = (id) => state.meta.frStatuses.find((x) => x.id === id)?.label ?? id;
function frStatus(status) {
  if (status === 'declined') return '<span class="chip">Declined</span>';
  const i = FR_FLOW.indexOf(status);
  return `<span class="fr-status" title="${esc(frLabel(status))}"><span class="fr-dots" aria-hidden="true">${FR_FLOW.map((_, k) => `<span class="${k <= i ? 'on' : ''} ${status === 'shipped' ? 'shipped' : ''}"></span>`).join('')}</span><span class="${status === 'shipped' ? 'tone-good' : ''}">${esc(frLabel(status))}</span></span>`;
}

// ---------- good morning ----------
function ctaButton(c, primary) {
  if (!c) return '';
  const cls = `btn sm ${primary ? 'primary' : ''}`;
  if (c.kind === 'link') return `<a class="${cls}" href="${esc(c.href)}">${esc(c.label)}</a>`;
  return `<button class="${cls}" data-endpoint="${esc(c.endpoint)}" data-body="${esc(c.body ? JSON.stringify(c.body) : '')}" data-confirm="${esc(c.confirm ?? '')}">${esc(c.label)}</button>`;
}

async function renderHome() {
  const d = await api('/api/home');
  const first = d.user.name.split(' ')[0];
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  view.innerHTML = `
    <section class="gm-hero">
      <div class="grow">
        <div class="muted small">${today}</div>
        <h1>Good morning, ${esc(first)} <span aria-hidden="true">☀</span></h1>
        <p class="gm-summary">${esc(d.summary)}</p>
      </div>
      <span class="chip gm-role">${esc(d.user.role)}</span>
    </section>

    <div class="kpis">
      ${d.kpis.map((k) => `<div class="card kpi"><div class="muted small">${esc(k.label)}</div><div class="v num ${k.tone ? `tone-${k.tone}` : ''}">${esc(k.value)}</div></div>`).join('')}
    </div>

    <div class="spread" style="margin-bottom:10px">
      <h2>Your next best actions <span class="muted" style="font-weight:500">· ${d.actions.length}</span></h2>
      ${ctaButton(d.footer)}
    </div>
    <div class="card">
      ${d.actions.map((a) => `
        <div class="gm-action p-${a.priority}">
          <span class="gm-ico" aria-hidden="true">${esc(a.icon)}</span>
          <div class="grow">
            <div class="gm-title">${esc(a.title)} ${a.badge ? segBadge(a.badge) : ''}</div>
            <div class="muted small">${esc(a.detail)}</div>
            ${a.tags.length ? `<div class="row" style="margin-top:6px;gap:4px">${a.tags.map((t) => `<span class="chip ${esc(t.tone)}">${esc(t.text)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="gm-ctas">${ctaButton(a.secondary)}${ctaButton(a.cta, true)}</div>
        </div>`).join('') || '<div class="empty">☕ Nothing needs you right now.</div>'}
    </div>`;

  $$('[data-endpoint]').forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.confirm === 'escalate' && !(await confirmEscalate())) return;
    run(b, async () => {
      await api(b.dataset.endpoint, { method: 'POST', body: b.dataset.body ? JSON.parse(b.dataset.body) : undefined });
      route({ keepScroll: true });
    });
  }));
}

// ---------- pipeline ----------
async function renderPipeline() {
  const accounts = await api('/api/accounts');
  const open = accounts.filter((a) => !['closedwon', 'closedlost'].includes(a.deal.stage));
  const cols = state.meta.stages.filter((s) => s.id !== 'closedlost');
  const pending = accounts.filter((a) => a.pendingApproval).length;
  const weighted = open.reduce((s, a) => s + a.deal.amount * (1 - (a.deal.discountPct || 0) / 100), 0);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Pipeline</h1><p class="muted">Every deal, synced with HubSpot. Move stages from the account page. Closing a deal starts onboarding automatically.</p></div>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="muted small">Open pipeline (ARR)</div><div class="v num">${moneyCompact(weighted)}</div></div>
      <div class="card kpi"><div class="muted small">Open deals</div><div class="v num">${open.length}</div></div>
      <div class="card kpi"><div class="muted small">Properties in pipeline</div><div class="v num">${open.reduce((s, a) => s + a.properties, 0)}</div></div>
      <div class="card kpi"><div class="muted small">Pending approvals</div><div class="v num" style="color:${pending ? 'var(--warn)' : 'inherit'}">${pending}</div></div>
    </div>
    <div class="board">
      ${cols.map((s) => {
        const items = accounts.filter((a) => a.deal.stage === s.id);
        return `<div class="col ${s.id === 'closedwon' ? 'won' : ''}">
          <div class="col-head"><span>${esc(s.label)}</span><span class="muted num">${items.length} · ${moneyCompact(items.reduce((x, a) => x + a.deal.amount, 0))}</span></div>
          ${items.map((a) => `
            <a class="deal" href="#/accounts/${a.id}">
              <div class="name">${esc(a.name)}</div>
              <div class="muted xs">${a.properties} ${a.properties === 1 ? 'property' : 'properties'} · ${esc(a.segment)}</div>
              <div class="spread"><span class="amt num">${money(a.deal.amount)}</span>
                ${a.pendingApproval ? '<span class="chip warn">Approval</span>' : a.deal.discountPct ? `<span class="chip">−${a.deal.discountPct}%</span>` : ''}</div>
            </a>`).join('') || '<div class="muted xs" style="padding:4px">No deals</div>'}
        </div>`;
      }).join('')}
    </div>`;
}

// ---------- accounts ----------
const ACCOUNT_COLS = [
  { id: 'name', label: 'Account', val: (a) => a.name.toLowerCase() },
  { id: 'status', label: 'Status', val: (a) => ['Live', 'Onboarding', 'Prospect'].indexOf(a.status) },
  { id: 'segment', label: 'Segment', val: (a) => a.segment, sm: true },
  { id: 'properties', label: 'Properties', val: (a) => a.properties, sm: true, num: true },
  { id: 'arr', label: 'ARR', val: (a) => a.deal.amount, sm: true, num: true },
  { id: 'spend', label: 'Spend via Reeco (30d)', val: (a) => a.usage?.spend30d ?? -1, sm: true, num: true },
  { id: 'health', label: 'Health', val: (a) => a.health ?? -1, num: true },
  { id: 'open', label: 'Open', val: (a) => a.openConversations + a.openTickets, sm: true, num: true },
];

async function renderAccounts() {
  const list = await api('/api/accounts');
  state.acctSort ??= { id: 'health', dir: 1 };
  const col = ACCOUNT_COLS.find((c) => c.id === state.acctSort.id);
  list.sort((x, y) => (col.val(x) > col.val(y) ? 1 : col.val(x) < col.val(y) ? -1 : 0) * state.acctSort.dir);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Accounts</h1><p class="muted">Hotel groups: CRM, product usage from Snowflake, and open work, in one row.</p></div>
      <input class="input" id="q" type="search" placeholder="Filter accounts…" aria-label="Filter accounts" style="max-width:260px" value="${esc(state.acctQ ?? '')}" />
    </div>
    <div class="card table-wrap">
      <table class="table">
        <thead><tr>${ACCOUNT_COLS.map((c) => {
          const on = c.id === state.acctSort.id;
          return `<th class="${c.sm ? 'hide-sm' : ''} ${c.num ? 'num-col' : ''}" aria-sort="${on ? (state.acctSort.dir === 1 ? 'ascending' : 'descending') : 'none'}"><button class="th-sort" data-sort="${c.id}">${esc(c.label)}<span class="sort-ind" aria-hidden="true">${on ? (state.acctSort.dir === 1 ? '▲' : '▼') : ''}</span></button></th>`;
        }).join('')}</tr></thead>
        <tbody>${list.map((a) => `
          <tr data-href="#/accounts/${a.id}" data-q="${esc(`${a.name} ${a.domain} ${a.segment} ${a.status}`.toLowerCase())}">
            <td><a class="row-link" href="#/accounts/${a.id}">${esc(a.name)}</a><div class="muted xs">${esc(a.domain)}</div></td>
            <td>${statusChip(a.status)}</td>
            <td class="hide-sm small">${esc(a.segment)}</td>
            <td class="hide-sm small num num-col">${a.usage ? `${a.usage.propertiesLive}/` : ''}${a.properties}</td>
            <td class="hide-sm num num-col">${money(a.deal.amount)}</td>
            <td class="hide-sm num num-col">${a.usage ? moneyCompact(a.usage.spend30d) : '<span class="muted">–</span>'}</td>
            <td>${healthBar(a.health)}</td>
            <td class="hide-sm small num-col">${a.openConversations + a.openTickets ? `${a.openConversations} conv · ${a.openTickets} tickets` : '<span class="muted">–</span>'}</td>
          </tr>`).join('')}</tbody>
      </table>
      <div class="empty" id="no-match" hidden>No accounts match your filter.</div>
    </div>`;
  $$('tbody tr').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a')) location.hash = tr.dataset.href; }));
  $$('[data-sort]').forEach((b) => b.addEventListener('click', () => {
    const same = state.acctSort.id === b.dataset.sort;
    state.acctSort = { id: b.dataset.sort, dir: same ? -state.acctSort.dir : 1 };
    renderAccounts();
  }));
  const filter = () => {
    const q = (state.acctQ = $('#q').value.trim().toLowerCase());
    let n = 0;
    $$('tbody tr').forEach((tr) => { tr.hidden = Boolean(q) && !tr.dataset.q.includes(q); n += tr.hidden ? 0 : 1; });
    $('#no-match').hidden = n > 0;
  };
  $('#q').addEventListener('input', filter);
  filter();
}

function conversationBlock(c) {
  return `
    <div class="thread">
      ${c.messages.map((m) => `<div class="msg ${m.from}"><div class="who">${esc(m.author)} · ${rel(m.at)}</div>${esc(m.text)}</div>`).join('')}
    </div>
    ${c.state === 'open' ? `
      <form class="reply" data-conv="${esc(c.id)}" data-reason="${esc(c.ai?.category ?? '')}">
        <textarea class="input" name="text" rows="2" placeholder="Reply to customer (sent via Intercom)…" required></textarea>
        <button class="btn primary" name="send">Send</button>
      </form>` : `<div class="empty">Closed${c.closeReason ? ` as “${esc(reasonLabel(c.closeReason))}”` : ''}${c.closedBy ? ` by ${esc(c.closedBy)}` : ''}</div>`}`;
}

const reasonLabel = (id) => state.meta.closeReasons.find((r) => r.id === id)?.label ?? id;

// Closing always asks why; Claude's suggested category is preselected when available.
function pickCloseReason(suggested, onPick) {
  openModal(`
    <h2>Why is this conversation closing?</h2>
    <div class="reasons" role="radiogroup" aria-label="Close reason">
      ${state.meta.closeReasons.map((r) => `
        <label class="reason"><input type="radio" name="reason" value="${r.id}" ${r.id === suggested ? 'checked' : ''} required />
          <span>${esc(r.label)}</span>${r.id === suggested ? '<span class="chip ai">✨ suggested</span>' : ''}</label>`).join('')}
    </div>
    <p class="muted small">Tagged in Intercom and logged to Snowflake, so we can see what drives support volume.</p>`,
    'Close conversation', async (data) => onPick(data.reason));
}

function bindReplies(root) {
  $$('form.reply', root).forEach((form) => form.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = e.submitter;
    const text = form.text.value;
    run(btn, async () => {
      await api(`/api/conversations/${form.dataset.conv}/reply`, { method: 'POST', body: { text } });
      form.reset();
      route({ keepScroll: true });
    });
  }));
}


// ---------- account tabs ----------
const ACCOUNT_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'health', label: 'Health & usage', live: true, count: (a) => a.anomalies.length || '' },
  { id: 'support', label: 'Support', count: (a) => a.support.open || '' },
  { id: 'requests', label: 'Feature requests', count: (a) => a.featureRequestList.length || '' },
];
const METRIC_TILES = [
  ['pos', 'Purchase orders / week'], ['invoicesAi', 'AI-processed invoices / week'], ['activeUsers', 'Active users'], ['syncErrors', 'ERP sync errors / week'],
];

function healthPanel(a) {
  const anomalyFor = (m) => a.anomalies.find((x) => x.metric === m);
  const partTone = (v) => (v >= 70 ? 'good' : v >= 50 ? 'warn' : 'bad');
  return `
    <div class="health-grid">
      <section class="card card-pad">
        <div class="muted small">Health score</div>
        <div class="hs-row"><span class="hs-num tone-${RISK[a.healthLevel].tone}">${a.health}</span>${riskChip(a.healthLevel)}</div>
        <div class="muted small">${a.renewalDate ? `Renewal ${new Date(a.renewalDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · in ${a.renewalDays} days` : ''}</div>
        <h3 class="sub">Why</h3>
        ${a.healthReasons.length ? `<ul class="reasons-list">${a.healthReasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '<p class="muted small">No warning signs. Keep doing what works.</p>'}
      </section>
      <section class="card card-pad">
        <div class="spread"><h2>What makes up the score</h2><span class="muted xs">Weighted</span></div>
        <div class="parts">
          ${a.healthParts.map((p) => `
            <div class="part">
              <div class="spread"><span class="small" style="font-weight:500">${esc(p.label)} <span class="muted xs">${Math.round(state.meta.healthWeights[p.id] * 100)}%</span></span><span class="num small tone-${partTone(p.score)}">${p.score}</span></div>
              <div class="bar"><span style="width:${p.score}%;background:var(--${partTone(p.score)})"></span></div>
              <div class="muted xs">${esc(p.detail)}</div>
            </div>`).join('')}
        </div>
      </section>
    </div>

    <section class="card" style="margin-top:16px">
      <div class="card-head">
        <div><h2>Weekly usage · last 12 weeks</h2><div class="muted small">From Snowflake. An anomaly is last week vs the 4 weeks before: a drop of 30%+ or an error spike.</div></div>
        <button class="btn sm" data-scan>❄ Check for anomalies</button>
      </div>
      <div class="metric-grid">
        ${METRIC_TILES.map(([m, label]) => {
          const vals = a.usageSeries?.[m] ?? [];
          const an = anomalyFor(m);
          return `<div class="metric ${an ? 'is-alert' : ''}">
            <div class="muted xs">${esc(label)}</div>
            <div class="spread"><span class="v num">${vals.length ? vals.at(-1).toLocaleString('en-US') : '–'}</span>${an ? `<span class="chip ${an.severity}"><svg class="ico"><use href="#i-alert"/></svg>Anomaly</span>` : ''}</div>
            ${sparkline(vals, { label, alert: Boolean(an) })}
          </div>`;
        }).join('')}
      </div>
    </section>

    <section class="card" style="margin-top:16px">
      <div class="card-head"><h2>Usage anomalies</h2>${src('snowflake')}</div>
      ${a.allAnomalies.length ? a.allAnomalies.map((x) => `
        <div class="list-item">
          <svg class="ico tone-${x.severity}" style="width:18px;height:18px"><use href="#i-alert"/></svg>
          <div class="grow"><div>${esc(x.text)}</div><div class="muted xs">Detected ${rel(x.detectedAt)}${x.reviewedBy ? ` · reviewed by ${esc(x.reviewedBy)}` : ''}</div></div>
          ${x.status === 'new' ? `<button class="btn sm" data-ack="${esc(x.id)}">Mark reviewed</button>` : '<span class="chip good">Reviewed</span>'}
        </div>`).join('') : '<div class="empty">No anomalies. Usage looks normal.</div>'}
    </section>`;
}

function supportPanel(a) {
  const open = a.conversationsView.filter((c) => c.state === 'open');
  const closed = a.conversationsView.filter((c) => c.state === 'closed');
  const bugs = a.tickets.filter((t) => t.status !== 'Done');
  return `
    <div class="kpis kpis-3">
      <div class="card kpi"><div class="muted small">Open conversations</div><div class="v num">${a.support.open}</div></div>
      <div class="card kpi"><div class="muted small">With engineering</div><div class="v num ${a.support.escalated ? 'tone-warn' : ''}">${a.support.escalated}</div></div>
      <div class="card kpi"><div class="muted small">Overdue replies</div><div class="v num ${a.support.overdue ? 'tone-bad' : ''}">${a.support.overdue}</div></div>
    </div>
    <div class="detail-grid">
      <section class="card">
        <div class="card-head"><h2>Open conversations</h2>${src('intercom')}</div>
        ${open.map((c) => `
          <a class="list-item link-row" href="#/inbox/${esc(c.id)}">
            <div class="grow">
              <div style="font-weight:500">${esc(c.subject)}</div>
              <div class="ii-facts">
                ${urgency(c) ? `<div class="fact ${urgency(c).tone}"><svg class="ico"><use href="#i-clock"/></svg>${urgency(c).text}</div>` : ''}
                <div class="fact"><svg class="ico"><use href="#i-tag"/></svg><span class="k">Classification:</span>${esc(c.classificationLabel)}${c.escalatedTo ? ` <span class="mono info-text">· ${esc(c.escalatedTo)}</span>` : ''}</div>
                <div class="fact ${c.assignee ? '' : 'warn'}"><svg class="ico"><use href="#i-user"/></svg><span class="k">Owner:</span>${c.assignee ? esc(c.assignee) : 'Unassigned'}</div>
              </div>
            </div>
            <svg class="ico muted"><use href="#i-arrow"/></svg>
          </a>`).join('') || '<div class="empty">No open conversations.</div>'}
        <div class="card-head" style="border-top:1px solid var(--border)"><h2>Past conversations</h2></div>
        ${closed.map((c) => `
          <a class="list-item link-row" href="#/inbox/${esc(c.id)}"><div class="grow"><div>${esc(c.subject)}</div><div class="muted xs">${esc(c.classificationLabel)} · closed as ${esc(reasonLabel(c.closeReason ?? ''))} · ${rel(c.updatedAt)}</div></div></a>`).join('') || '<div class="empty">None yet.</div>'}
      </section>
      <section class="card">
        <div class="card-head"><h2>Engineering tickets</h2>${src('jira')}</div>
        ${bugs.map((t) => `
          <div class="list-item">
            <span class="mono muted" style="min-width:74px">${esc(t.key)}</span>
            <div class="grow">${esc(t.summary)}<div class="muted xs">${rel(t.createdAt)}</div></div>
            ${ticketStatus(t.status)}
          </div>`).join('') || '<div class="empty">No open tickets.</div>'}
      </section>
    </div>`;
}

function requestsPanel(a) {
  const list = a.featureRequestList;
  return `
    <section class="card">
      <div class="card-head"><div><h2>Feature requests from ${esc(a.name)}</h2><div class="muted small">Tracked in Jira. You're notified in Slack whenever one moves.</div></div>${src('jira')}</div>
      ${list.map((f) => {
        const mine = f.accounts.find((r) => r.accountId === a.id);
        const others = f.accounts.filter((r) => r.accountId !== a.id);
        return `<div class="list-item fr-row">
          <div class="grow">
            <div style="font-weight:500">${esc(f.title)} <span class="mono muted xs">${esc(f.jiraKey)}</span></div>
            <div class="muted xs">Asked ${rel(mine.requestedAt)}${others.length ? ` · also asked by ${others.map((r) => esc(r.name)).join(', ')} (${moneyCompact(f.arr)} ARR in total)` : ''}</div>
          </div>
          ${frStatus(f.status)}
          ${f.status === 'shipped' ? (mine.notified ? '<span class="chip good">Customer told</span>' : `<button class="btn sm primary" data-tell="${esc(f.id)}" data-account="${esc(a.id)}">Tell the customer</button>`) : ''}
        </div>`;
      }).join('') || '<div class="empty">No feature requests yet. Support conversations closed as “Feature request” show up here automatically.</div>'}
    </section>`;
}

// Buttons shared by the account tabs, portfolio and requests pages.
function bindCsActions(root) {
  const go = (btn, path, body) => run(btn, async () => { await api(path, { method: 'POST', body }); route({ keepScroll: true }); });
  $$('[data-scan]', root).forEach((b) => b.addEventListener('click', () => go(b, '/api/anomalies/scan')));
  $$('[data-ack]', root).forEach((b) => b.addEventListener('click', () => go(b, `/api/anomalies/${b.dataset.ack}/ack`)));
  $$('[data-tell]', root).forEach((b) => b.addEventListener('click', () => go(b, `/api/feature-requests/${b.dataset.tell}/tell`, { accountId: b.dataset.account })));
  $$('[data-advance]', root).forEach((b) => b.addEventListener('click', () => go(b, `/api/feature-requests/${b.dataset.advance}/advance`)));
}

async function renderAccount(id, query = new URLSearchParams()) {
  const a = await api(`/api/accounts/${id}`);
  const stages = state.meta.stages;
  const idx = stages.findIndex((s) => s.id === a.deal.stage);
  const pending = a.approvals.find((p) => p.status === 'pending');
  const lastDecided = a.approvals.find((p) => p.status !== 'pending');
  const steps = state.meta.steps;
  const doneCount = a.onboarding ? steps.filter((s) => a.onboarding.steps[s.id].done).length : 0;
  const net = a.deal.amount * (1 - (a.deal.discountPct || 0) / 100);
  // CS lands on health; everyone else on the overview. ?tab= deep-links.
  const tab = query.get('tab') || (user().team === 'cs' && a.status !== 'Prospect' ? 'health' : 'overview');

  view.innerHTML = `
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/accounts">Accounts</a><span aria-hidden="true">/</span><span aria-current="page">${esc(a.name)}</span></nav>
    <div class="page-head">
      <div>
        <h1>${esc(a.name)}</h1>
        <div class="row" style="margin-top:8px">
          ${statusChip(a.status)}
          <span class="chip">${esc(a.segment)}</span>
          <span class="chip">${a.properties} ${a.properties === 1 ? 'property' : 'properties'} · ${esc(a.region)}</span>
          <span class="chip">AE ${esc(a.owner)} · CSM ${esc(a.csm)}</span>
          ${a.health != null ? riskChip(a.healthLevel, a.health) : ''}
          ${a.renewalDays != null ? `<span class="chip ${a.renewalDays <= 90 ? 'warn' : ''}">Renewal in ${a.renewalDays} days</span>` : ''}
        </div>
      </div>
      <div class="row">
        <button class="btn" id="add-note">＋ Note</button>
        <button class="btn" id="new-ticket">＋ Jira ticket</button>
      </div>
    </div>

    <div class="tabs" role="tablist" aria-label="Account sections">
      ${ACCOUNT_TABS.filter((t) => !t.live || a.status !== 'Prospect').map((t) => `<button role="tab" class="tab ${t.id === tab ? 'sel' : ''}" data-acct-tab="${t.id}" aria-selected="${t.id === tab}" aria-controls="panel-${t.id}">${esc(t.label)}${t.count ? ` <span class="num">${t.count(a)}</span>` : ''}</button>`).join('')}
    </div>

    <div class="tab-panel" id="panel-health" role="tabpanel" ${tab === 'health' ? '' : 'hidden'}>${a.status === 'Prospect' ? '' : healthPanel(a)}</div>
    <div class="tab-panel" id="panel-support" role="tabpanel" ${tab === 'support' ? '' : 'hidden'}>${supportPanel(a)}</div>
    <div class="tab-panel" id="panel-requests" role="tabpanel" ${tab === 'requests' ? '' : 'hidden'}>${requestsPanel(a)}</div>

    <div class="tab-panel detail-grid" id="panel-overview" role="tabpanel" ${tab === 'overview' ? '' : 'hidden'}>
      <div class="stack">
        <section class="card">
          <div class="card-head">
            <div><h2>${esc(a.deal.name)}</h2><div class="muted small">Click a stage to update HubSpot</div></div>
            ${src('hubspot', `Deal ${a.deal.id}`)}
          </div>
          ${pending ? `<div class="banner">⏳ ${pending.pct}% discount waiting for manager approval in Slack <span class="mono">#deal-desk</span>. <a class="link" href="#/approvals">View</a></div>` : ''}
          <div class="pipeline">
            ${stages.map((s, i) => `<button class="stage ${s.id === 'closedlost' ? 'lost' : ''} ${i === idx ? 'current' : i < idx && a.deal.stage !== 'closedlost' ? 'done' : ''}" data-stage="${s.id}">${esc(s.label)}</button>`).join('')}
          </div>
          <div class="deal-foot">
            <div class="row">
              <span style="font-weight:600" class="num">${money(net)} ARR</span>
              ${a.deal.discountPct ? `<span class="muted small">list ${money(a.deal.amount)} · −${a.deal.discountPct}%</span>` : ''}
              ${lastDecided && !pending ? `<span class="chip ${lastDecided.status === 'approved' ? 'good' : 'bad'}">${lastDecided.pct}% ${lastDecided.status} by ${esc(lastDecided.decidedBy)}</span>` : ''}
            </div>
            ${a.deal.stage !== 'closedwon' && !pending ? '<button class="btn sm" id="discount">Request discount</button>' : ''}
          </div>
        </section>

        ${a.onboarding ? `
        <section class="card">
          <div class="card-head">
            <div><h2>Onboarding · ${doneCount}/${steps.length}</h2>
              <div class="muted small">${a.onboarding.completedAt ? `Completed ${rel(a.onboarding.completedAt)}` : `Day ${days(a.onboarding.startedAt)}`} · Slack <span class="mono">${esc(a.onboarding.slackChannel)}</span> · Jira <span class="mono">${esc(a.onboarding.jiraEpic ?? '')}</span></div></div>
            <button class="btn sm" id="sync">❄ Sync from Snowflake</button>
          </div>
          <div class="steps">
            ${steps.map((s) => {
              const st = a.onboarding.steps[s.id];
              return `<div class="step ${st.done ? 'done' : ''}">
                <button class="check ${st.done ? 'on' : ''}" data-step="${s.id}" ${s.auto ? 'disabled' : ''} aria-label="${esc(s.label)}" title="${s.auto ? `Completed automatically: ${esc(s.hint)}` : 'Toggle'}">${st.done ? '✓' : ''}</button>
                <div class="grow"><span class="label">${esc(s.label)}</span>${st.done ? `<div class="muted xs">${esc(st.by)} · ${rel(st.at)}</div>` : ''}</div>
                ${s.auto ? `${src('snowflake', 'auto')}` : ''}
              </div>`;
            }).join('')}
          </div>
        </section>` : ''}

      </div>

      <div class="stack">
        <section class="card card-pad">
          <h2 style="margin-bottom:12px">Primary contact</h2>
          <dl class="kv">
            <dt>Name</dt><dd>${esc(a.contact.name)}</dd>
            <dt>Role</dt><dd>${esc(a.contact.role)}</dd>
            <dt>Email</dt><dd class="mono">${esc(a.contact.email)}</dd>
          </dl>
        </section>

        <section class="card card-pad">
          <div class="spread" style="margin-bottom:14px"><h2>Product usage</h2>${src('snowflake')}</div>
          ${a.usage ? `
            <div class="usage">
              <div><div class="muted xs">Properties live</div><div class="v num">${a.usage.propertiesLive} / ${a.properties}</div>
                <div class="bar" style="margin-top:5px"><span style="width:${Math.round((a.usage.propertiesLive / a.properties) * 100)}%"></span></div></div>
              <div><div class="muted xs">Active users</div><div class="v num">${compact(a.usage.activeUsers)}</div></div>
              <div><div class="muted xs">Purchase orders (30d)</div><div class="v num">${compact(a.usage.pos30d)}</div></div>
              <div><div class="muted xs">AI-processed invoices (30d)</div><div class="v num">${compact(a.usage.invoicesAi30d)}</div></div>
              <div><div class="muted xs">Spend via Reeco (30d)</div><div class="v num">${moneyCompact(a.usage.spend30d)}</div></div>
              <div><div class="muted xs">Vendors connected</div><div class="v num">${compact(a.usage.vendorsConnected)}</div></div>
            </div>
            <div class="spread" style="margin-top:14px"><span class="muted xs">Last active ${rel(a.usage.lastActive)}</span>
              ${a.onboarding ? '' : '<button class="btn sm" id="sync">❄ Refresh</button>'}</div>`
          : '<p class="muted small">Prospect: no product usage yet.</p>'}
        </section>

        <section class="card">
          <div class="card-head"><h2>Notes</h2>${src('hubspot')}</div>
          ${a.notes.length ? a.notes.map((n) => `<div class="note">${esc(n.text)}<div class="muted xs" style="margin-top:2px">${esc(n.author)} · ${rel(n.at)}</div></div>`).join('') : '<div class="empty">No notes yet.</div>'}
        </section>
      </div>
    </div>`;
  state.flashId = null;

  $$('[data-acct-tab]').forEach((b) => b.addEventListener('click', () => {
    history.replaceState(null, '', `#/accounts/${id}?tab=${b.dataset.acctTab}`);
    $$('[data-acct-tab]').forEach((x) => { const on = x === b; x.classList.toggle('sel', on); x.setAttribute('aria-selected', on); });
    $$('.tab-panel').forEach((p) => (p.hidden = p.id !== `panel-${b.dataset.acctTab}`));
  }));
  bindCsActions(view);

  $$('.stage').forEach((b) => b.addEventListener('click', () => {
    if (b.classList.contains('current')) return;
    const won = b.dataset.stage === 'closedwon';
    if (b.dataset.stage === 'closedlost') {
      confirmDialog({ title: `Mark ${a.name} as lost?`, body: '<p class="muted">The deal moves to Closed lost in HubSpot. You can move it back later.</p>', confirmLabel: 'Mark as lost', danger: true })
        .then((ok) => ok && run(b, async () => { await api(`/api/accounts/${id}/deal-stage`, { method: 'POST', body: { stage: 'closedlost' } }); route({ keepScroll: true }); }));
      return;
    }
    const go = () => run(b, async () => {
      await api(`/api/accounts/${id}/deal-stage`, { method: 'POST', body: { stage: b.dataset.stage } });
      route({ keepScroll: true });
    });
    if (!won) return go();
    openModal(`<h2>Close ${esc(a.name)} as won?</h2>
      <p class="muted" style="margin-bottom:10px">This will run the onboarding automation:</p>
      <ul class="small" style="margin:0 0 12px;padding-left:18px;display:flex;flex-direction:column;gap:4px">
        <li>HubSpot deal → <b>Closed won</b></li>
        <li>Slack: announce in <span class="mono">#deals</span>, create <span class="mono">#onb-${esc(a.id)}</span> with the checklist</li>
        <li>Jira: onboarding epic in <span class="mono">ONB</span></li>
        <li>Snowflake: log events for reporting</li>
      </ul>`, 'Close won', () => go());
  }));

  $('#discount')?.addEventListener('click', () => openModal(`
    <h2>Request a discount</h2>
    <div class="field"><label for="pct">Discount %</label><input class="input" id="pct" name="pct" type="number" min="1" max="50" value="10" required /></div>
    <div class="field"><label for="reason">Reason</label><textarea class="input" id="reason" name="reason" rows="3" placeholder="Why does this deal need it?"></textarea></div>
    <p class="muted small">Up to ${state.meta.config.discountApprovalThreshold}% is applied in HubSpot right away. Above that, a manager approves it in Slack <span class="mono">#deal-desk</span>.</p>`,
    'Submit', async (data) => {
      await api(`/api/accounts/${id}/discount`, { method: 'POST', body: data });
      route({ keepScroll: true });
    }));

  $$('.check[data-step]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
    await api(`/api/accounts/${id}/steps/${b.dataset.step}`, { method: 'POST' });
    route({ keepScroll: true });
  })));

  $('#sync')?.addEventListener('click', (e) => run(e.currentTarget, async () => {
    await api(`/api/accounts/${id}/sync-usage`, { method: 'POST' });
    route({ keepScroll: true });
  }));

  bindReplies(view);

  $('#new-ticket').addEventListener('click', () => openModal(`
    <h2>New Jira ticket · ${esc(a.name)}</h2>
    <div class="field"><label for="t-sum">Summary</label><input class="input" id="t-sum" name="summary" required /></div>
    <div class="field"><label for="t-desc">Description</label><textarea class="input" id="t-desc" name="description" rows="3"></textarea></div>
    <div class="field"><label for="t-pri">Priority</label><select class="input" id="t-pri" name="priority"><option>Low</option><option selected>Medium</option><option>High</option><option>Highest</option></select></div>`,
    'Create', (data) => api(`/api/accounts/${id}/tickets`, { method: 'POST', body: data }).then(() => route({ keepScroll: true }))));

  $('#add-note').addEventListener('click', () => openModal(`
    <h2>Note · ${esc(a.name)}</h2>
    <div class="field"><textarea class="input" name="text" rows="4" required placeholder="What should the team know?" aria-label="Note"></textarea></div>
    <p class="muted small">Saved as a note on the company in HubSpot.</p>`,
    'Save', (data) => api(`/api/accounts/${id}/notes`, { method: 'POST', body: data }).then(() => route({ keepScroll: true }))));
  if (query.get('note')) {
    history.replaceState(null, '', `#/accounts/${id}?tab=overview`);
    $('#add-note').click();
  }
}

// ---------- inbox ----------
const INBOUND_SAMPLES = [
  { label: 'Enterprise: angry about invoices', email: 'greg.walsh@meridiansuites.com', text: 'Invoices from US Foods are still broken after your fix. Unacceptable. We need someone on this today.' },
  { label: 'Onboarding: ERP question', email: 'priya@sableandpine.com', text: 'Our Sage Intacct sync is failing for resort #3 again. Can someone look?' },
  { label: 'Live: feature question', email: 'ana@coastalkeys.com', text: 'Can we set par levels per outlet for the pool bar?' },
];

const isSnoozed = (c) => c.snoozedUntil && new Date(c.snoozedUntil) > new Date();
const INBOX_TABS = [
  { id: 'mine', label: 'Mine', test: (c, me) => c.state === 'open' && !isSnoozed(c) && c.assignee === me },
  { id: 'unassigned', label: 'Unassigned', test: (c) => c.state === 'open' && !isSnoozed(c) && !c.assignee },
  { id: 'enterprise', label: 'Enterprise', test: (c) => c.state === 'open' && !isSnoozed(c) && c.account.segment === 'Enterprise' },
  { id: 'overdue', label: 'Overdue', test: (c) => c.state === 'open' && !isSnoozed(c) && c.slaDueAt && new Date(c.slaDueAt) < new Date() },
  { id: 'open', label: 'All open', test: (c) => c.state === 'open' && !isSnoozed(c) },
  { id: 'snoozed', label: 'Snoozed', test: (c) => c.state === 'open' && isSnoozed(c) },
  { id: 'closed', label: 'Closed', test: (c) => c.state === 'closed' },
];

function snoozeOptions() {
  const at = (h) => new Date(Date.now() + h * 3600_000);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  return [['1 hour', at(1)], ['4 hours', at(4)], ['Tomorrow 9:00', tomorrow]];
}

const SENTIMENT_TONE = { calm: 'good', confused: 'info', frustrated: 'warn', angry: 'bad' };

function aiCard(c) {
  if (c.state !== 'open') return '';
  if (!c.ai) {
    return `<div class="ai-card empty-ai"><span>✨ Get a summary, the customer's mood and a draft reply.</span>
      <button class="btn sm ai-btn" id="ai-run">✨ Summarize &amp; draft reply</button></div>`;
  }
  const stale = c.ai.forMessages !== c.messages.length;
  return `
    <div class="ai-card">
      <div class="spread">
        <div class="row"><strong>✨ AI assist</strong>
          <span class="chip ${SENTIMENT_TONE[c.ai.sentiment] ?? ''}">${esc(c.ai.sentiment)}</span>
          <span class="chip">Likely: ${esc(reasonLabel(c.ai.category))}</span>
          ${stale ? '<span class="chip warn">New messages since</span>' : ''}</div>
        <button class="btn sm ghost" id="ai-run" title="Regenerate">↻ ${stale ? 'Refresh' : 'Regenerate'}</button>
      </div>
      <p class="ai-summary">${esc(c.ai.summary)}</p>
      <p class="small"><b>Next step:</b> ${esc(c.ai.next_step)}</p>
      <div class="ai-draft">
        <div class="spread"><span class="small" style="font-weight:600">Suggested reply</span><button class="btn sm primary" id="ai-use">Use this reply</button></div>
        <pre class="draft">${esc(c.ai.suggested_reply)}</pre>
      </div>
      <div class="muted xs">${c.ai.mode === 'live' ? `Claude · ${esc(c.ai.model)}` : 'Mock mode: rules-based stand-in until ANTHROPIC_API_KEY is set'} · ${rel(c.ai.at)}</div>
    </div>`;
}

function snapshotPanel(a, currentId) {
  const p = a.platform;
  const tickets = a.tickets.filter((t) => t.status !== 'Done');
  const history = a.conversations.filter((c) => c.id !== currentId).slice(0, 4);
  const syncTone = { ok: 'good', degraded: 'warn', failing: 'bad' }[p?.syncStatus] ?? '';
  return `
    <div class="snap-head">
      <div class="spread"><h2>Account snapshot</h2><a class="link xs" href="#/accounts/${a.id}">Full account →</a></div>
      <div class="snap-name">${esc(a.name)}</div>
      <div class="row" style="gap:4px;margin-top:6px">${statusChip(a.status)}<span class="chip">${esc(a.segment)}</span><span class="chip">${money(a.deal.amount)} ARR</span></div>
      <div style="margin-top:10px">${healthBar(a.health)}</div>
      <div class="muted xs" style="margin-top:6px">CSM ${esc(a.csm)} · AE ${esc(a.owner)} · ${a.properties} properties</div>
    </div>
    <div class="snap-sec">
      <div class="spread"><h3>Platform</h3>${src('snowflake')}</div>
      ${p ? `<dl class="kv small">
          <dt>ERP</dt><dd>${esc(p.erp)}</dd>
          <dt>Sync</dt><dd><span class="chip ${syncTone}">${esc(p.syncStatus)}</span> <span class="muted xs">${rel(p.lastSyncAt)}</span></dd>
          <dt>Errors 24h</dt><dd class="num ${p.syncErrors24h ? 'tone-bad' : ''}">${p.syncErrors24h}</dd>
          <dt>Version</dt><dd class="mono">${esc(p.appVersion)}</dd>
          ${a.usage ? `<dt>Live</dt><dd>${a.usage.propertiesLive}/${a.properties} properties · ${compact(a.usage.activeUsers)} users</dd>` : ''}
        </dl>` : '<p class="muted small">Not live on the platform yet.</p>'}
    </div>
    <div class="snap-sec">
      <div class="spread"><h3>Open tickets · ${tickets.length}</h3>${src('jira')}</div>
      ${tickets.map((t) => `<div class="snap-row"><span class="mono muted">${esc(t.key)}</span><span class="grow ellipsis">${esc(t.summary)}</span>${ticketStatus(t.status)}</div>`).join('') || '<p class="muted small">None.</p>'}
    </div>
    <div class="snap-sec">
      <div class="spread"><h3>Past conversations</h3>${src('intercom')}</div>
      ${history.map((c) => `<a class="snap-row" href="#/inbox/${esc(c.id)}"><span class="grow ellipsis">${esc(c.subject)}</span><span class="chip ${c.state === 'open' ? 'warn' : ''}">${c.state === 'open' ? 'Open' : esc(reasonLabel(c.closeReason ?? '')) || 'Closed'}</span></a>`).join('') || '<p class="muted small">First conversation.</p>'}
    </div>
    ${a.onboarding && a.status === 'Onboarding' ? `<div class="snap-sec"><h3>Onboarding</h3><p class="small">Day ${days(a.onboarding.startedAt)} · ${Object.values(a.onboarding.steps).filter((x) => x.done).length}/${state.meta.steps.length} steps</p></div>` : ''}`;
}

async function renderInbox(selectedId) {
  const me = user();
  state.inboxTab ??= me.team === 'support' ? 'mine' : 'open';
  const [items, reasons] = await Promise.all([api('/api/inbox'), state.inboxTab === 'closed' ? api('/api/support/reasons') : null]);
  const tab = INBOX_TABS.find((t) => t.id === state.inboxTab) ?? INBOX_TABS[4];
  const list = items.filter((c) => tab.test(c, me.name));
  const sel = items.find((i) => i.id === selectedId) ?? list[0];
  const account = sel ? await api(`/api/accounts/${sel.account.id}`) : null;
  const agents = state.meta.users.filter((u) => u.team === 'support');
  const maxReason = reasons ? Math.max(1, ...reasons.map((r) => r.count)) : 1;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Inbox</h1><p class="muted">Intercom conversations with the customer's account and platform status alongside. Enterprise and angry messages are flagged to Slack.</p></div>
      <button class="btn" id="simulate" title="Demo: pretend a customer just wrote in through Intercom">⚡ Simulate a message</button>
    </div>
    <div class="tabs" role="tablist" aria-label="Queues">
      ${INBOX_TABS.map((t) => { const n = items.filter((c) => t.test(c, me.name)).length; return `<button role="tab" class="tab ${t.id === tab.id ? 'sel' : ''}" data-tab="${t.id}" aria-selected="${t.id === tab.id}">${esc(t.label)} <span class="num">${n}</span></button>`; }).join('')}
    </div>
    <div class="card inbox3">
      <div class="inbox-list">
        ${reasons ? `<div class="reasons-chart"><div class="muted xs" style="margin-bottom:6px">Why customers contacted us</div>
          ${reasons.filter((r) => r.count).sort((x, y) => y.count - x.count).map((r) => `<div class="rbar"><span class="xs ellipsis">${esc(r.label)}</span><div class="bar"><span style="width:${(r.count / maxReason) * 100}%"></span></div><span class="xs num">${r.count}</span></div>`).join('')}</div>` : ''}
        ${list.map((i) => `
          <a class="inbox-item u-${urgency(i)?.tone ?? 'none'} ${i.id === sel?.id ? 'active' : ''} ${i.id === state.flashId ? 'flash' : ''}" href="#/inbox/${esc(i.id)}">
            <div class="ii-top"><span class="ii-name ellipsis">${esc(i.account.name)}</span>${segBadge(i.account.segment)}</div>
            <div class="ii-top"><span class="ii-subject ellipsis">${esc(i.subject)}</span><span class="ii-time muted xs">${rel(i.updatedAt)}</span></div>
            <div class="preview">${i.ai && i.ai.forMessages === i.messages.length ? `✨ ${esc(i.ai.summary)}` : esc(i.messages.at(-1)?.text)}</div>
            <div class="ii-facts">
              ${i.state === 'closed' ? `<div class="fact muted"><svg class="ico"><use href="#i-done"/></svg>Closed: ${esc(reasonLabel(i.closeReason ?? '')) || 'no reason'}</div>`
                : isSnoozed(i) ? `<div class="fact info"><svg class="ico"><use href="#i-clock"/></svg>Snoozed until ${new Date(i.snoozedUntil).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>`
                : urgency(i) ? `<div class="fact ${urgency(i).tone}"><svg class="ico"><use href="#i-clock"/></svg>${urgency(i).text}</div>` : ''}
              <div class="fact"><svg class="ico"><use href="#i-tag"/></svg><span class="k">Classification:</span>${esc(i.classificationLabel)}${i.escalatedTo ? ` <span class="mono info-text">· ${esc(i.escalatedTo)}</span>` : ''}</div>
              <div class="fact ${i.assignee ? '' : 'warn'}"><svg class="ico"><use href="#i-user"/></svg><span class="k">Owner:</span>${i.assignee ? esc(i.assignee) : 'Unassigned'}</div>
            </div>
          </a>`).join('') || `<div class="empty">${tab.id === 'mine' ? 'Nothing assigned to you. Check <b>Unassigned</b>.' : 'Nothing here.'}</div>`}
      </div>

      <div class="inbox-thread">
        ${sel ? `
          <div class="card-head">
            <div class="grow"><h2>${esc(sel.subject)}</h2><div class="row" style="gap:6px;margin-top:2px"><a class="link small" href="#/accounts/${sel.account.id}">${esc(sel.account.name)} →</a>${segBadge(sel.account.segment)}</div></div>
            ${src('intercom', `#${sel.id}`)}
          </div>
          ${sel.state === 'open' ? `
          <div class="toolbar-row">
            <label class="xs muted" for="assignee">Owner</label>
            <select class="input sm" id="assignee">
              <option value="">Unassigned</option>
              ${agents.map((u) => `<option value="${esc(u.name)}" ${sel.assignee === u.name ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
            </select>
            ${me.team === 'support' && sel.assignee !== me.name ? '<button class="btn sm" id="take">Assign to me</button>' : ''}
            ${isSnoozed(sel) ? '<button class="btn sm" id="unsnooze">Unsnooze</button>'
              : `<select class="input sm" id="snooze" aria-label="Snooze"><option value="">Snooze…</option>${snoozeOptions().map(([l, d]) => `<option value="${d.toISOString()}">${l}</option>`).join('')}</select>`}
            <span class="grow"></span>
            <div class="decide">
              ${sel.escalatedTo ? `<span class="st info"><svg class="ico"><use href="#i-alert"/></svg>With engineering · ${esc(sel.escalatedTo)}</span>` : '<button class="btn sm btn-escalate" id="escalate"><svg class="ico"><use href="#i-alert"/></svg>Escalate to engineering</button>'}
              <span class="vr" aria-hidden="true"></span>
              <button class="btn sm btn-close" id="close"><svg class="ico"><use href="#i-done"/></svg>Close conversation</button>
            </div>
          </div>` : ''}
          <div class="ctx">
            ${urgency(sel) ? `<span class="st ${urgency(sel).tone}"><svg class="ico"><use href="#i-clock"/></svg>${urgency(sel).text}</span>` : ''}
            <label class="st calm" for="classify"><svg class="ico"><use href="#i-tag"/></svg>Classification</label>
            ${sel.state === 'open' ? `<select class="input sm" id="classify" title="Correct the classification if it's wrong">
              ${state.meta.classifications.map((k) => { const tool = k.id === 'integration' ? (sel.classification?.tool ?? sel.account.platformErp) : null; return `<option value="${k.id}" ${sel.classification?.id === k.id ? 'selected' : ''}>${esc(k.label)}${tool ? ` · ${esc(tool)}` : ''}</option>`; }).join('')}
            </select>` : `<span class="small">${esc(sel.classificationLabel)}</span>`}
            ${isSnoozed(sel) ? `<span class="chip info">Snoozed until ${new Date(sel.snoozedUntil).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })} (reply target still running)</span>` : ''}
          </div>
          ${aiCard(sel)}
          ${conversationBlock(sel)}` : '<div class="empty">Select a conversation.</div>'}
      </div>

      <aside class="snapshot" aria-label="Account snapshot">${account ? snapshotPanel(account, sel.id) : ''}</aside>
    </div>`;
  state.flashId = null;

  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => { state.inboxTab = b.dataset.tab; location.hash = '#/inbox'; route(); }));
  bindReplies(view);
  if (!sel) return;
  const act = (btn, path, body, msg) => run(btn, async () => {
    await api(`/api/conversations/${sel.id}/${path}`, { method: 'POST', body });
    route({ keepScroll: true });
  });
  $('#classify')?.addEventListener('change', (e) => act(e.target, 'classify', { id: e.target.value }));
  $('#assignee')?.addEventListener('change', (e) => act(e.target, 'assign', { assignee: e.target.value || null }));
  $('#take')?.addEventListener('click', (e) => act(e.currentTarget, 'assign', { assignee: me.name }, 'Assigned to you'));
  $('#snooze')?.addEventListener('change', (e) => e.target.value && act(e.target, 'snooze', { until: e.target.value }, 'Snoozed. It comes back when the time is up or the customer replies.'));
  $('#unsnooze')?.addEventListener('click', (e) => act(e.currentTarget, 'snooze', { until: null }));
  $('#escalate')?.addEventListener('click', async (e) => { const btn = e.currentTarget; if (await confirmEscalate()) act(btn, 'escalate'); });
  $('#close')?.addEventListener('click', (e) => { const btn = e.currentTarget; pickCloseReason(sel.suggestedCloseReason, (reason) => act(btn, 'close', { reason }, `Closed as “${reasonLabel(reason)}”`)); });
  $('#ai-run')?.addEventListener('click', (e) => act(e.currentTarget, 'ai'));
  $('#ai-use')?.addEventListener('click', () => {
    const ta = $('form.reply textarea');
    ta.value = sel.ai.suggested_reply;
    ta.focus();
    ta.style.height = `${Math.min(ta.scrollHeight + 4, 260)}px`;
  });

  $('#simulate').addEventListener('click', () => openModal(`
    <h2>Simulate a customer message</h2>
    <p class="muted small" style="margin-bottom:10px">Sends the hub the same notification Intercom sends when a customer writes in.</p>
    <div class="reasons">${INBOUND_SAMPLES.map((x, i) => `<label class="reason"><input type="radio" name="sample" value="${i}" ${i ? '' : 'checked'} required /><span>${esc(x.label)}<span class="muted xs" style="display:block">“${esc(x.text)}”</span></span></label>`).join('')}</div>`,
    'Send message', (data) => simulateInbound(INBOUND_SAMPLES[data.sample])));
}

// Sends the hub exactly what Intercom sends (conversation.user.created) when a customer writes in.
async function simulateInbound(x) {
  const res = await fetch('/webhooks/intercom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'notification_event', topic: 'conversation.user.created', data: { item: { type: 'conversation', id: String(215470000 + Math.floor(Math.random() * 99999)), source: { body: `<p>${x.text}</p>`, author: { type: 'user', email: x.email } } } } }),
  });
  const r = await res.json();
  if (!res.ok) throw new Error(r.error);
  state.inboxTab = 'unassigned';
  location.hash = `#/inbox/${r.conversationId}`;
}


// ---------- my portfolio (CS) ----------
async function renderPortfolio() {
  const me = user();
  state.pfScope ??= me.team === 'cs' ? 'mine' : 'all';
  const all = (await api('/api/accounts')).filter((a) => a.status !== 'Prospect');
  const list = all.filter((a) => state.pfScope === 'all' || a.csm === me.name);
  const rank = { high: 0, medium: 1, low: 2 };
  // Highest risk first; within a level, the sooner the renewal and the bigger the ARR, the higher.
  list.sort((x, y) => rank[x.healthLevel] - rank[y.healthLevel] || (x.renewalDays ?? 999) - (y.renewalDays ?? 999) || y.deal.amount - x.deal.amount);
  const atRisk = list.filter((a) => a.healthLevel !== 'low');
  const anoms = list.reduce((n, a) => n + a.anomalies.length, 0);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>My portfolio</h1><p class="muted">Your accounts, riskiest first. Health combines usage trend, adoption, support load, platform stability and sentiment.</p></div>
      <div class="row">
        <div class="seg seg-inline" role="group" aria-label="Scope">
          <button class="${state.pfScope === 'mine' ? 'sel' : ''}" data-scope="mine" aria-pressed="${state.pfScope === 'mine'}">My accounts</button>
          <button class="${state.pfScope === 'all' ? 'sel' : ''}" data-scope="all" aria-pressed="${state.pfScope === 'all'}">All accounts</button>
        </div>
        <button class="btn" data-scan>❄ Check for anomalies</button>
      </div>
    </div>
    <div class="kpis">
      <div class="card kpi"><div class="muted small">ARR at risk</div><div class="v num tone-warn">${moneyCompact(atRisk.reduce((n, a) => n + a.deal.amount, 0))}</div><div class="muted xs">${atRisk.length} of ${list.length} accounts</div></div>
      <div class="card kpi"><div class="muted small">High risk</div><div class="v num ${list.some((a) => a.healthLevel === 'high') ? 'tone-bad' : ''}">${list.filter((a) => a.healthLevel === 'high').length}</div></div>
      <div class="card kpi"><div class="muted small">Usage anomalies to review</div><div class="v num ${anoms ? 'tone-warn' : ''}">${anoms}</div></div>
      <div class="card kpi"><div class="muted small">Renewals in 90 days</div><div class="v num">${list.filter((a) => a.renewalDays != null && a.renewalDays <= 90).length}</div></div>
    </div>
    <div class="card table-wrap">
      <table class="table pf-table">
        <thead><tr><th>Account</th><th>Health</th><th>Why</th><th class="hide-sm">Usage (12 wks)</th><th class="hide-sm">Renewal</th><th class="hide-sm">Support</th><th class="hide-sm">Requests</th></tr></thead>
        <tbody>${list.map((a) => {
          const vol = a.usageSeries ? a.usageSeries.pos.map((v, i) => v + a.usageSeries.invoicesAi[i]) : null;
          return `<tr data-href="#/accounts/${a.id}?tab=health">
            <td><a class="row-link" href="#/accounts/${a.id}?tab=health">${esc(a.name)}</a> ${segBadge(a.segment)}<div class="muted xs">${esc(a.status)} · ${money(a.deal.amount)} ARR${state.pfScope === 'all' ? ` · CSM ${esc(a.csm)}` : ''}</div></td>
            <td>${riskChip(a.healthLevel, a.health)}</td>
            <td class="why">${a.anomalies.length ? `<div class="tone-warn small"><svg class="ico" style="width:14px;height:14px;vertical-align:-2px"><use href="#i-alert"/></svg> ${esc(a.anomalies[0].text)}</div>` : ''}${a.healthReasons.filter((r) => !r.startsWith('Usage anomaly')).slice(0, 2).map((r) => `<div class="muted small">${esc(r)}</div>`).join('') || (a.anomalies.length ? '' : '<span class="muted small">No warning signs</span>')}</td>
            <td class="hide-sm"><div class="row" style="gap:8px;flex-wrap:nowrap">${vol ? sparkline(vol, { label: 'POs + AI invoices per week', w: 110, h: 30 }) : ''}<span class="small">${trendText(a.usageTrendPct)}</span></div></td>
            <td class="hide-sm small">${a.renewalDays != null ? `<span class="${a.renewalDays <= 90 ? 'tone-warn' : ''}">in ${a.renewalDays} days</span>` : '–'}</td>
            <td class="hide-sm small">${a.support.open ? `${a.support.open} open${a.support.escalated ? ` · <span class="tone-warn">${a.support.escalated} escalated</span>` : ''}` : '<span class="muted">none</span>'}</td>
            <td class="hide-sm small">${a.featureRequests.toTell ? `<span class="tone-good">${a.featureRequests.toTell} shipped, tell them</span>` : a.featureRequests.open ? `${a.featureRequests.open} open` : '<span class="muted">–</span>'}</td>
          </tr>`;
        }).join('') || '<tr><td colspan="7" class="empty">No accounts in your portfolio.</td></tr>'}</tbody>
      </table>
    </div>`;
  $$('tbody tr[data-href]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a, button')) location.hash = tr.dataset.href; }));
  $$('[data-scope]').forEach((b) => b.addEventListener('click', () => { state.pfScope = b.dataset.scope; renderPortfolio(); }));
  bindCsActions(view);
}

// ---------- feature requests ----------
async function renderRequests() {
  const me = user();
  state.frScope ??= me.team === 'cs' ? 'mine' : 'all';
  state.frStatus ??= 'active';
  const all = await api('/api/feature-requests');
  const scoped = all.filter((f) => state.frScope === 'all' || f.accounts.some((r) => r.csm === me.name));
  const filters = [
    ['active', 'Open', (f) => !['shipped', 'declined'].includes(f.status)],
    ['shipped', 'Shipped', (f) => f.status === 'shipped'],
    ['declined', 'Declined', (f) => f.status === 'declined'],
    ['all', 'All', () => true],
  ];
  const test = filters.find((x) => x[0] === state.frStatus)[2];
  const list = scoped.filter(test).sort((x, y) => y.arr - x.arr);
  const toTell = scoped.flatMap((f) => (f.status === 'shipped' ? f.accounts.filter((r) => !r.notified && (state.frScope === 'all' || r.csm === me.name)) : []));

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Feature requests</h1><p class="muted">What customers asked for, where it stands in Jira, and who to tell when it ships. Ranked by the ARR asking.</p></div>
      <div class="seg seg-inline" role="group" aria-label="Scope">
        <button class="${state.frScope === 'mine' ? 'sel' : ''}" data-frscope="mine">My accounts</button>
        <button class="${state.frScope === 'all' ? 'sel' : ''}" data-frscope="all">All accounts</button>
      </div>
    </div>
    ${toTell.length ? `<div class="card callout"><svg class="ico"><use href="#i-bulb"/></svg><div class="grow"><b>${toTell.length} ${toTell.length === 1 ? 'customer is' : 'customers are'} waiting to hear</b> that their request shipped.</div><button class="btn sm" data-frfilter="shipped">Show shipped</button></div>` : ''}
    <div class="filters" style="margin-bottom:12px">${filters.map(([id, label, t]) => `<span class="chip ${state.frStatus === id ? 'sel' : ''}" role="button" tabindex="0" data-frfilter="${id}">${label} · ${scoped.filter(t).length}</span>`).join('')}</div>
    <div class="card">
      ${list.map((f) => `
        <div class="fr-item">
          <div class="spread" style="align-items:flex-start">
            <div class="grow">
              <div style="font-weight:600">${esc(f.title)} <span class="mono muted xs">${esc(f.jiraKey)}</span></div>
              <div class="muted xs">Updated ${rel(f.updatedAt)} · ${f.accounts.length} ${f.accounts.length === 1 ? 'account' : 'accounts'} · ${moneyCompact(f.arr)} ARR asking</div>
            </div>
            ${frStatus(f.status)}
          </div>
          <div class="fr-accounts">
            ${f.accounts.map((r) => `<span class="fr-acct">
              <a class="link small" href="#/accounts/${esc(r.accountId)}?tab=requests">${esc(r.name)}</a>${segBadge(r.segment)}
              ${f.status === 'shipped' ? (r.notified ? '<span class="chip good">Told</span>' : `<button class="btn sm primary" data-tell="${esc(f.id)}" data-account="${esc(r.accountId)}">Tell the customer</button>`) : ''}
            </span>`).join('')}
            ${f.next ? `<button class="btn sm ghost fr-sim" data-advance="${esc(f.id)}" title="Demo: behaves like Jira's webhook when the issue moves">Simulate Jira update → ${esc(frLabel(f.next))}</button>` : ''}
          </div>
        </div>`).join('') || '<div class="empty">Nothing here.</div>'}
    </div>`;
  $$('[data-frscope]').forEach((b) => b.addEventListener('click', () => { state.frScope = b.dataset.frscope; renderRequests(); }));
  $$('[data-frfilter]').forEach((b) => {
    const pick = () => { state.frStatus = b.dataset.frfilter; renderRequests(); };
    b.addEventListener('click', pick);
    b.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick()));
  });
  bindCsActions(view);
}

// ---------- onboarding ----------
async function renderOnboarding() {
  const list = (await api('/api/accounts')).filter((a) => a.onboarding);
  const active = list.filter((a) => a.status === 'Onboarding');
  const done = list.filter((a) => a.status !== 'Onboarding');
  const card = (a) => `
    <a class="card onb-card" href="#/accounts/${a.id}">
      <div class="spread"><strong>${esc(a.name)}</strong>${statusChip(a.status)}</div>
      <div class="pips">${Array.from({ length: a.onboarding.total }, (_, i) => `<span class="pip ${i < a.onboarding.done ? 'on' : ''}"></span>`).join('')}</div>
      <div class="spread small"><span>${a.onboarding.done}/${a.onboarding.total} steps</span>
        <span class="muted">${a.onboarding.completedAt ? `done in ${days(a.onboarding.startedAt) - days(a.onboarding.completedAt)}d` : `day ${days(a.onboarding.startedAt)}`}</span></div>
      <div class="row small muted"><span>${a.usage?.propertiesLive ?? 0}/${a.properties} properties live</span>·<span>CSM ${esc(a.csm)}</span></div>
    </a>`;
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Onboarding</h1><p class="muted">Go-live tracking per hotel group. Usage-based steps tick themselves off from Snowflake. Each customer gets a Slack channel and a Jira epic.</p></div>
      ${active.length ? '<button class="btn" id="sync-all">❄ Sync all from Snowflake</button>' : ''}
    </div>
    <h2 style="margin-bottom:10px">In progress · ${active.length}</h2>
    <div class="onb-grid" style="margin-bottom:26px">${active.map(card).join('') || '<div class="card empty">Nobody onboarding right now. Close a deal from the Pipeline to start one.</div>'}</div>
    <h2 style="margin-bottom:10px">Live · ${done.length}</h2>
    <div class="onb-grid">${done.map(card).join('')}</div>`;
  $('#sync-all')?.addEventListener('click', (e) => run(e.currentTarget, async () => {
    await api('/api/onboarding/sync', { method: 'POST' });
    route({ keepScroll: true });
  }));
}

// ---------- approvals ----------
async function renderApprovals() {
  const list = await api('/api/approvals');
  const me = user();
  const pending = list.filter((p) => p.status === 'pending');
  const decided = list.filter((p) => p.status !== 'pending');
  const row = (p) => `
    <div class="approval">
      <div>
        <div class="row"><a class="link" href="#/accounts/${p.accountId}" style="font-size:15px">${esc(p.account.name)}</a>
          <span class="chip ${p.status === 'pending' ? 'warn' : p.status === 'approved' ? 'good' : 'bad'}">${p.pct}% · ${esc(p.status)}</span></div>
        <div class="muted small num" style="margin-top:4px">${money(p.account.deal.amount)} → ${money(p.account.deal.amount * (1 - p.pct / 100))} ARR · requested by ${esc(p.requestedBy)} ${rel(p.requestedAt)}
          ${p.decidedBy ? ` · ${esc(p.status)} by ${esc(p.decidedBy)} ${p.via === 'slack' ? 'in Slack' : 'in the hub'}` : ''}</div>
        ${p.reason ? `<div class="quote">${esc(p.reason)}</div>` : ''}
      </div>
      ${p.status === 'pending' ? `
        <div class="row">
          <button class="btn primary sm" data-decide="approved" data-id="${p.id}" ${me.approver ? '' : 'disabled title="Only a Sales Manager can approve"'}>Approve</button>
          <button class="btn sm danger" data-decide="rejected" data-id="${p.id}" ${me.approver ? '' : 'disabled title="Only a Sales Manager can approve"'}>Reject</button>
          <button class="btn sm ghost" data-slack="${p.id}" title="Sends the same payload Slack would send when the manager clicks Approve">Simulate Slack click</button>
        </div>` : ''}
    </div>`;
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Approvals</h1><p class="muted">Discounts above ${state.meta.config.discountApprovalThreshold}% go to <span class="mono">#deal-desk</span> in Slack. The manager approves there or here, and HubSpot updates either way.</p></div>
    </div>
    ${!me.approver && pending.length ? `<div class="card card-pad small" style="margin-bottom:14px">You're signed in as <b>${esc(me.name)}</b> (${esc(me.role)}). Switch to <b>Eitan B. (Sales Manager)</b> at the bottom-left to approve, or use <b>Simulate Slack click</b>.</div>` : ''}
    <h2 style="margin-bottom:10px">Pending · ${pending.length}</h2>
    <div class="card" style="margin-bottom:24px">${pending.map(row).join('') || '<div class="empty">Nothing waiting.</div>'}</div>
    <h2 style="margin-bottom:10px">Decided · ${decided.length}</h2>
    <div class="card">${decided.map(row).join('') || '<div class="empty">No decisions yet.</div>'}</div>`;

  $$('[data-decide]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
    await api(`/api/approvals/${b.dataset.id}`, { method: 'POST', body: { decision: b.dataset.decide } });
    route({ keepScroll: true });
  })));
  $$('[data-slack]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
    // Slack interactivity posts form-encoded `payload` JSON
    const payload = { type: 'block_actions', user: { id: 'U0EITAN', name: 'Eitan B.' }, actions: [{ action_id: 'discount_approve', value: b.dataset.slack }] };
    const res = await fetch('/webhooks/slack', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ payload: JSON.stringify(payload) }) });
    if (!res.ok) throw new Error((await res.json()).error);
    route({ keepScroll: true });
  })));
}

// ---------- activity log ----------
state.openActs = new Set();

async function renderLog(query = new URLSearchParams()) {
  if (query.get('open')) { state.openActs.add(query.get('open')); history.replaceState(null, '', '#/log'); }
  const all = await api('/api/activity');
  const systemsOf = (a) => [...new Set(a.steps.map((x) => x.system))];
  const rows = all.filter((a) => !state.logFilter || systemsOf(a).includes(state.logFilter));
  const toneOf = (a) => (a.failed || a.steps.some((x) => !x.ok) ? 'bad' : a.tone);

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Activity log</h1><p class="muted">Everything the hub did for the team, in plain words. Open a row to see each step it took in HubSpot, Intercom, Jira, Slack, Snowflake or Claude.</p></div>
      <div class="filters">
        <span class="chip ${!state.logFilter ? 'sel' : ''}" data-f="" role="button" tabindex="0">All · ${all.length}</span>
        ${Object.entries(SYSTEMS).map(([k, x]) => { const n = all.filter((a) => systemsOf(a).includes(k)).length; return n ? `<span class="chip ${state.logFilter === k ? 'sel' : ''}" data-f="${k}" role="button" tabindex="0">${x.name} · ${n}</span>` : ''; }).join('')}
      </div>
    </div>
    <div class="card">
      ${rows.map((a) => `
        <details class="act" data-id="${a.id}" ${state.openActs.has(a.id) ? 'open' : ''}>
          <summary>
            <span class="act-ico t-${toneOf(a)}" aria-hidden="true">${esc(a.icon)}</span>
            <span class="grow">
              <span class="act-text">${esc(a.outcome)}</span>
              <span class="muted xs">${esc(a.actor)} · ${rel(a.ts)}${a.steps.length ? ` · ${a.steps.length} ${a.steps.length === 1 ? 'step' : 'steps'}` : ''}</span>
            </span>
            <span class="act-sys hide-sm">${systemsOf(a).map((k) => `<span class="sysdot" style="background:${SYSTEMS[k]?.color}" title="${esc(SYSTEMS[k]?.name)}"></span>`).join('')}</span>
          </summary>
          <ol class="act-steps">
            ${a.steps.map((x) => `
              <li>
                <span class="step-mark ${x.ok ? 'ok' : 'err'}" aria-label="${x.ok ? 'Done' : 'Failed'}">${x.ok ? '✓' : '✕'}</span>
                <div class="grow">
                  <div><b>${esc(SYSTEMS[x.system]?.name ?? x.system)}</b> · ${esc(x.summary)}</div>
                  <details class="tech"><summary class="xs muted">Technical details</summary>
                    <div class="xs muted" style="margin:6px 0">${x.mode === 'live' ? 'Live' : 'Mock mode (nothing left the server)'} · ${x.status} · ${x.durationMs} ms</div>
                    <div class="log-body">
                      <div><div class="muted xs" style="margin-bottom:4px">Sent</div><pre class="code">${esc(`${x.request.method} ${x.request.url}\n\n${JSON.stringify(x.request.body ?? null, null, 2)}`)}</pre></div>
                      <div><div class="muted xs" style="margin-bottom:4px">Received</div><pre class="code">${esc(JSON.stringify(x.response, null, 2))}</pre></div>
                    </div>
                  </details>
                </div>
              </li>`).join('') || '<li class="muted small">No outside systems were involved.</li>'}
          </ol>
        </details>`).join('') || '<div class="empty">Nothing yet. Try closing a deal or escalating a conversation.</div>'}
    </div>`;

  $$('details.act').forEach((d) => d.addEventListener('toggle', () => (d.open ? state.openActs.add(d.dataset.id) : state.openActs.delete(d.dataset.id))));
  $$('[data-f]').forEach((c) => {
    const pick = () => { state.logFilter = c.dataset.f || null; renderLog(); };
    c.addEventListener('click', pick);
    c.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick()));
  });
}

// ---------- connections ----------
function renderConnections() {
  const origin = location.origin;
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Connections</h1><p class="muted">Systems without credentials run in <b>mock</b> mode: every request is built exactly as the real API expects, but never leaves the server.</p></div>
      <button class="btn danger" id="reset">↺ Reset demo data</button>
    </div>
    <div class="conn-grid">
      ${state.meta.integrations.map((i) => `
        <div class="card conn">
          <div class="row"><span class="logo" style="background:${SYSTEMS[i.id].color}">${SYSTEMS[i.id].letter}</span>
            <div class="grow"><strong>${esc(i.name)}</strong><div class="muted xs">${esc(i.role)}</div></div>
            <span class="chip ${i.live ? 'good' : 'warn'}">${i.live ? 'Live' : 'Mock'}</span></div>
          <div class="mono muted xs">${i.env.map(esc).join('<br>')}</div>
        </div>`).join('')}
    </div>
    <div class="card card-pad" style="margin-top:16px">
      <h2 style="margin-bottom:6px">Inbound webhooks</h2>
      <p class="muted small" style="margin-bottom:10px">Point these at the hub. Signatures are verified when the secrets are set.</p>
      <pre class="code">POST ${esc(origin)}/webhooks/intercom   # Intercom: conversation.user.created, conversation.user.replied
POST ${esc(origin)}/webhooks/slack      # Slack app → Interactivity request URL (approval buttons)
POST ${esc(origin)}/webhooks/jira       # Jira: issue updated (feature request status)</pre>
    </div>`;
  $('#reset').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!(await confirmDialog({ title: 'Reset demo data?', body: '<p class="muted">Every account, conversation and approval goes back to the starting point for everyone using this link.</p>', confirmLabel: 'Reset', danger: true }))) return;
    run(btn, () => api('/api/reset', { method: 'POST' }));
  });
}

// ---------- modal ----------
function openModal(html, submitLabel, onSubmit) {
  const dlg = $('#modal');
  dlg.innerHTML = `<form method="dialog">${html}
    <div class="dialog-actions">${submitLabel ? `<button class="btn primary" value="ok">${esc(submitLabel)}</button>` : ''}<button class="btn" value="cancel" formnovalidate>${submitLabel ? 'Cancel' : 'Close'}</button></div></form>`;
  const form = $('form', dlg);
  form.addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    run(e.submitter, async () => { await onSubmit(data); dlg.close(); });
  });
  dlg.showModal();
  $('input, textarea', dlg)?.focus();
}

function openTour() {
  openModal(`<h2>Demo guide · 8 minutes</h2>
    <ol class="tour">
      <li><b>Good morning.</b> <a class="link" href="#/home">Start here</a>: each role lands on its own to-do list with one-click actions. Use <i>View as</i> to switch roles.</li>
      <li><b>Sales: close a deal.</b> <a class="link" href="#/accounts/harborline">Harborline</a> → <i>Closed won</i>. One click updates HubSpot, tells the team in Slack, opens a Jira epic and starts onboarding.</li>
      <li><b>Deal desk.</b> <a class="link" href="#/accounts/northgate">Northgate</a> → <i>Request discount</i> 20%. Then <a class="link" href="#/approvals">Approvals</a> → <i>Simulate Slack click</i>.</li>
      <li><b>Support.</b> As Ron, open the <a class="link" href="#/inbox">Inbox</a>: queues, the <i>Account snapshot</i>, <i>✨ Summarize &amp; draft reply</i>, then <i>Close</i> with a reason.</li>
      <li><b>Customer Success.</b> As Dana, open <a class="link" href="#/portfolio">My portfolio</a>: accounts by risk. Open Meridian's <i>Health &amp; usage</i> tab, then <i>Check for anomalies</i>, and <a class="link" href="#/requests">Feature requests</a> → <i>Tell the customer</i>.</li>
      <li><b>Onboarding.</b> <a class="link" href="#/onboarding">Onboarding</a> → <i>Sync all from Snowflake</i>. Usage-based steps tick themselves off.</li>
      <li><b>Under the hood.</b> The <a class="link" href="#/log">Activity log</a> tells the story of every action in plain words.</li>
    </ol>`, null, null);
  $$('#modal a').forEach((a) => a.addEventListener('click', () => $('#modal').close()));
}

// Promise-based confirmation for irreversible or high-impact actions.
function confirmDialog({ title, body = '', confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('#modal');
    dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${body}
      <div class="dialog-actions"><button class="btn ${danger ? 'danger-fill' : 'primary'}" value="ok">${esc(confirmLabel)}</button><button class="btn" value="cancel">Cancel</button></div></form>`;
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
    $('button[value=ok]', dlg).focus();
  });
}

// ---------- help & keyboard shortcuts ----------
const SHORTCUTS = [
  ['Ctrl K', 'Search accounts, conversations and pages'],
  ['/', 'Search'],
  ['G then H', 'Good morning'], ['G then P', 'Pipeline'], ['G then I', 'Inbox'], ['G then M', 'My portfolio'], ['G then O', 'Onboarding'], ['G then R', 'Feature requests'], ['G then A', 'Accounts'], ['G then L', 'Activity log'],
  ['J / K', 'Next / previous conversation (Inbox)'],
  ['?', 'This help'],
];

function openHelp() {
  openModal(`<h2>Keyboard shortcuts</h2>
    <dl class="shortcuts">${SHORTCUTS.map(([k, d]) => `<dt>${k.split(' ').map((x) => (x === 'then' || x === '/' && k.length > 1 ? `<span class="muted xs">${x}</span>` : `<kbd>${esc(x)}</kbd>`)).join(' ')}</dt><dd>${esc(d)}</dd>`).join('')}</dl>
    <button class="btn sm" type="button" id="help-tour"><svg class="ico"><use href="#i-play"/></svg>Open the demo guide</button>`, null, null);
  $('#help-tour').addEventListener('click', () => { $('#modal').close(); openTour(); });
}

// ---------- user menu ----------
const initials = (name) => name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();

function renderUserChip() {
  const u = user();
  $('#user-avatar').textContent = initials(u.name);
  $('#user-name').textContent = u.name;
  $('#user-role').textContent = u.role;
}

function getTheme() { try { return localStorage.getItem('reeco-hub-theme') || 'system'; } catch { return 'system'; } }
function setTheme(t) {
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { localStorage.setItem('reeco-hub-theme', t); } catch {}
}

function toggleUserMenu(open) {
  const menu = $('#user-menu');
  const btn = $('#user-btn');
  open ??= menu.hidden;
  if (!open) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); return; }
  const me = user();
  const theme = getTheme();
  menu.innerHTML = `
    <div class="menu-label">Switch user (demo)</div>
    ${state.meta.users.map((u) => `<button role="menuitemradio" aria-checked="${u.id === me.id}" class="menu-item ${u.id === me.id ? 'sel' : ''}" data-user="${u.id}">
      <span class="avatar sm" aria-hidden="true">${initials(u.name)}</span><span class="grow">${esc(u.name)}<span class="muted xs"> · ${esc(u.role)}</span></span></button>`).join('')}
    <div class="menu-sep"></div>
    <div class="menu-label">Theme</div>
    <div class="seg" role="group" aria-label="Theme">
      ${[['system', 'i-monitor', 'System'], ['light', 'i-sun', 'Light'], ['dark', 'i-moon', 'Dark']].map(([v, i, l]) => `<button class="${theme === v ? 'sel' : ''}" data-theme-set="${v}" aria-pressed="${theme === v}"><svg class="ico"><use href="#${i}"/></svg>${l}</button>`).join('')}
    </div>
    <div class="menu-sep"></div>
    <button role="menuitem" class="menu-item" data-menu="tour"><svg class="ico"><use href="#i-play"/></svg><span class="grow">Demo guide</span></button>
    <button role="menuitem" class="menu-item" data-menu="help"><svg class="ico"><use href="#i-help"/></svg><span class="grow">Keyboard shortcuts</span><kbd>?</kbd></button>
    <button role="menuitem" class="menu-item" data-menu="reset"><svg class="ico"><use href="#i-reset"/></svg><span class="grow">Reset demo data</span></button>`;
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  $('.menu-item', menu).focus();

  $$('[data-user]', menu).forEach((b) => b.addEventListener('click', () => {
    $('#user').value = b.dataset.user;
    $('#user').dispatchEvent(new Event('change'));
    toggleUserMenu(false);
  }));
  $$('[data-theme-set]', menu).forEach((b) => b.addEventListener('click', () => { setTheme(b.dataset.themeSet); toggleUserMenu(true); }));
  $('[data-menu=tour]', menu).addEventListener('click', () => { toggleUserMenu(false); openTour(); });
  $('[data-menu=help]', menu).addEventListener('click', () => { toggleUserMenu(false); openHelp(); });
  $('[data-menu=reset]', menu).addEventListener('click', async () => {
    toggleUserMenu(false);
    if (await confirmDialog({ title: 'Reset demo data?', body: '<p class="muted">Every account, conversation and approval goes back to the starting point for everyone using this link.</p>', confirmLabel: 'Reset', danger: true })) {
      await run(null, () => api('/api/reset', { method: 'POST' }));
    }
  });
}

// ---------- search (command palette) ----------
const PAGES = [
  ['Good morning', '#/home', 'i-sun'], ['Pipeline', '#/pipeline', 'i-board'], ['Approvals', '#/approvals', 'i-check'], ['Inbox', '#/inbox', 'i-inbox'],
  ['My portfolio', '#/portfolio', 'i-heart'], ['Onboarding', '#/onboarding', 'i-flag'], ['Feature requests', '#/requests', 'i-bulb'], ['Accounts', '#/accounts', 'i-building'], ['Activity log', '#/log', 'i-activity'], ['Connections', '#/connections', 'i-plug'],
];

async function openPalette() {
  const dlg = $('#palette');
  if (dlg.open) return;
  const [accounts, convs] = await Promise.all([api('/api/accounts'), api('/api/inbox')]);
  const items = [
    ...PAGES.map(([label, href, icon]) => ({ group: 'Pages', label, href, icon, hint: '' })),
    ...accounts.map((a) => ({ group: 'Accounts', label: a.name, href: `#/accounts/${a.id}`, icon: 'i-building', hint: `${a.status} · ${a.segment}`, q: `${a.domain} ${a.contact?.name ?? ''}` })),
    ...convs.filter((c) => c.state === 'open').map((c) => ({ group: 'Open conversations', label: c.subject, href: `#/inbox/${c.id}`, icon: 'i-inbox', hint: c.account.name, q: c.messages.map((m) => m.author).join(' ') })),
  ];
  dlg.innerHTML = `
    <div class="pal-input"><svg class="ico"><use href="#i-search"/></svg><input id="pal-q" placeholder="Search accounts, conversations, pages…" aria-label="Search" autocomplete="off" /><kbd>Esc</kbd></div>
    <div class="pal-list" id="pal-list" role="listbox"></div>`;
  let sel = 0;
  let shown = [];
  const draw = () => {
    const q = $('#pal-q', dlg).value.trim().toLowerCase();
    shown = items.filter((x) => !q || `${x.label} ${x.hint} ${x.q ?? ''}`.toLowerCase().includes(q)).slice(0, 12);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    let group = '';
    $('#pal-list', dlg).innerHTML = shown.map((x, i) => {
      const head = x.group !== group ? `<div class="pal-group">${esc((group = x.group))}</div>` : '';
      return `${head}<a role="option" aria-selected="${i === sel}" class="pal-item ${i === sel ? 'sel' : ''}" href="${esc(x.href)}" data-i="${i}">
        <svg class="ico"><use href="#${x.icon}"/></svg><span class="grow ellipsis">${esc(x.label)}</span><span class="muted xs">${esc(x.hint)}</span></a>`;
    }).join('') || '<div class="empty">No matches.</div>';
    $('.pal-item.sel', dlg)?.scrollIntoView({ block: 'nearest' });
  };
  const go = (x) => { if (!x) return; dlg.close(); location.hash = x.href; };
  $('#pal-q', dlg).addEventListener('input', () => { sel = 0; draw(); });
  $('#pal-q', dlg).addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); draw(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    if (e.key === 'Enter') { e.preventDefault(); go(shown[sel]); }
  });
  $('#pal-list', dlg).addEventListener('click', (e) => { const a = e.target.closest('.pal-item'); if (a) { e.preventDefault(); go(shown[a.dataset.i]); } });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // click outside
  draw();
  dlg.showModal();
  $('#pal-q', dlg).focus();
}

// ---------- keyboard ----------
let gPending = 0;
function onKey(e) {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || $('#modal').open || $('#palette').open) return;
  if (e.key === '/') { e.preventDefault(); openPalette(); return; }
  if (e.key === '?') { e.preventDefault(); openHelp(); return; }
  if (e.key === 'Escape' && !$('#user-menu').hidden) { toggleUserMenu(false); $('#user-btn').focus(); return; }
  if (e.key.toLowerCase() === 'g') { gPending = Date.now(); return; }
  if (Date.now() - gPending < 1200) {
    const dest = { h: '#/home', p: '#/pipeline', i: '#/inbox', o: '#/onboarding', a: '#/accounts', l: '#/log', c: '#/connections', m: '#/portfolio', r: '#/requests' }[e.key.toLowerCase()];
    gPending = 0;
    if (dest) { location.hash = dest; return; }
  }
  if (location.hash.startsWith('#/inbox') && (e.key === 'j' || e.key === 'k')) {
    const items = $$('.inbox-item');
    const idx = items.findIndex((x) => x.classList.contains('active'));
    const next = items[Math.min(Math.max(idx + (e.key === 'j' ? 1 : -1), 0), items.length - 1)];
    if (next) location.hash = next.getAttribute('href');
  }
}

// ---------- router ----------
const TITLES = { home: 'Good morning', pipeline: 'Pipeline', approvals: 'Approvals', inbox: 'Inbox', onboarding: 'Onboarding', portfolio: 'My portfolio', requests: 'Feature requests', accounts: 'Accounts', log: 'Activity log', connections: 'Connections' };
let lastSection = null;

async function route({ keepScroll = false } = {}) {
  const [path, qs = ''] = (location.hash || '#/home').split('?');
  const [, section = 'home', id] = path.split('/');
  const query = new URLSearchParams(qs);
  const nav = section === 'accounts' && id ? 'accounts' : section;
  $$('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === nav;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.title = `${TITLES[section] ?? 'Reeco Hub'} · Reeco Hub`;
  const y = scrollY;
  const navigated = !keepScroll && lastSection !== `${section}/${id ?? ''}`;
  lastSection = `${section}/${id ?? ''}`;
  // Show a skeleton only if loading is noticeable, so fast pages don't flicker.
  const skel = navigated ? setTimeout(() => { view.innerHTML = SKELETON; }, 150) : null;
  try {
    if (section === 'home') await renderHome();
    else if (section === 'accounts' && id) await renderAccount(id, query);
    else if (section === 'accounts') await renderAccounts();
    else if (section === 'inbox') await renderInbox(id);
    else if (section === 'onboarding') await renderOnboarding();
    else if (section === 'portfolio') await renderPortfolio();
    else if (section === 'requests') await renderRequests();
    else if (section === 'approvals') await renderApprovals();
    else if (section === 'log') await renderLog(query);
    else if (section === 'connections') renderConnections();
    else if (section === 'pipeline') await renderPipeline();
    else await renderHome();
  } catch (err) {
    view.innerHTML = `<div class="card empty-state"><h2>Couldn't load this page</h2><p class="muted">${esc(err.message)}</p><button class="btn" onclick="location.reload()">Try again</button></div>`;
  } finally {
    clearTimeout(skel);
  }
  if (keepScroll) scrollTo(0, y);
  else if (navigated) { scrollTo(0, 0); view.focus({ preventScroll: true }); }
}

const SKELETON = `<div class="skel" aria-busy="true" aria-label="Loading"><div class="sk sk-title"></div><div class="sk sk-line"></div>
  <div class="kpis">${'<div class="sk sk-card"></div>'.repeat(4)}</div><div class="sk sk-block"></div></div>`;

async function init() {
  state.meta = await fetch('/api/meta').then((r) => r.json());
  const sel = $('#user');
  sel.innerHTML = state.meta.users.map((u) => `<option value="${u.id}">${esc(u.name)} · ${esc(u.role)}</option>`).join('');
  try { const saved = localStorage.getItem('reeco-hub-user'); if (saved && state.meta.users.some((u) => u.id === saved)) sel.value = saved; } catch {}
  sel.addEventListener('change', () => { try { localStorage.setItem('reeco-hub-user', sel.value); } catch {} renderUserChip(); refreshBadges(); route({ keepScroll: true }); });
  renderUserChip();
  if (!/Mac|iPhone|iPad/.test(navigator.platform)) $('#kbd-k').textContent = 'Ctrl K'; else $('#kbd-k').textContent = '⌘K';

  $('#user-btn').addEventListener('click', () => toggleUserMenu());
  document.addEventListener('click', (e) => { if (!$('#user-menu').hidden && !e.target.closest('.sidebar-foot')) toggleUserMenu(false); });
  $('#search-btn').addEventListener('click', openPalette);
  document.addEventListener('keydown', onKey);
  addEventListener('hashchange', () => { route(); });
  setInterval(() => { if (/^#\/(inbox|accounts\/)/.test(location.hash)) scheduleRender(); }, 60_000); // reply-due countdowns
  connectEvents();
  refreshBadges();
  await route();
}

init();
