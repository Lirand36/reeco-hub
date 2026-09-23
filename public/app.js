// Reeco Hub (concept): front end. Plain JS, no build step: hash routing + template strings.

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
function rel(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
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
  if (mins < 0) return `<span class="chip bad">SLA breached ${fmtMins(-mins)}</span>`;
  return `<span class="chip ${mins <= 30 ? 'warn' : ''}">SLA ${fmtMins(mins)}</span>`;
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

function toast(html, { system, error, ms = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${system ?? ''} ${error ? 'error' : ''}`;
  el.innerHTML = html;
  const box = $('#toasts');
  box.append(el);
  while (box.children.length > 5) box.firstChild.remove();
  setTimeout(() => el.remove(), ms);
}

// Runs an action with the button disabled; errors become a toast.
async function run(btn, fn) {
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  try { return await fn(); }
  catch (err) { toast(`<strong>Couldn't complete:</strong> ${esc(err.message)}`, { error: true }); }
  finally { if (btn) { btn.disabled = false; btn.classList.remove('busy'); } }
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
  es.addEventListener('integration', (e) => {
    const x = JSON.parse(e.data);
    state.log.unshift(x);
    toast(`<div class="spread"><strong>${esc(SYSTEMS[x.system]?.name)}</strong><span class="mono ${x.ok ? 'ok' : 'err'}">${x.status} · ${x.durationMs}ms</span></div>
      <div class="ellipsis">${esc(x.action)}</div>
      <div class="mono muted ellipsis">${esc(x.request.method)} ${esc(new URL(x.request.url).pathname)}</div>`, { system: x.system });
  });
  es.addEventListener('inbound', (e) => {
    const x = JSON.parse(e.data);
    state.flashId = x.conversation.id;
    toast(`<strong>New message</strong> from ${esc(x.accountName)}${x.flagged.length ? ` <span class="chip bad">${esc(x.flagged.join(' + '))}</span>` : ''}
      <div class="muted">${esc(x.conversation.messages.at(-1).text)}</div>`, { system: 'intercom', ms: 7000 });
  });
  es.addEventListener('changed', (e) => {
    if (JSON.parse(e.data).reset) state.log = [];
    refreshBadges();
    scheduleRender();
  });
}

async function refreshBadges() {
  const [inbox, approvals] = await Promise.all([api('/api/inbox'), api('/api/approvals')]);
  const set = (id, n) => { const b = $(id); b.hidden = !n; b.textContent = n; };
  set('#badge-inbox', inbox.filter((c) => c.state === 'open').length);
  set('#badge-approvals', approvals.filter((p) => p.status === 'pending').length);
}

// ---------- good morning ----------
function ctaButton(c, primary) {
  if (!c) return '';
  const cls = `btn sm ${primary ? 'primary' : ''}`;
  if (c.kind === 'link') return `<a class="${cls}" href="${esc(c.href)}">${esc(c.label)}</a>`;
  return `<button class="${cls}" data-endpoint="${esc(c.endpoint)}" data-body="${esc(c.body ? JSON.stringify(c.body) : '')}" data-done="${esc(c.done ?? '')}">${esc(c.label)}</button>`;
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
      <div class="gm-switch" role="group" aria-label="View as">
        <span class="muted xs">View as</span>
        ${state.meta.users.map((u) => `<button class="chip ${u.id === d.user.id ? 'sel' : ''}" data-as="${u.id}" aria-pressed="${u.id === d.user.id}">${esc(u.name.split(' ')[0])} · ${esc(u.role)}</button>`).join('')}
      </div>
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
            <div class="gm-title">${esc(a.title)}</div>
            <div class="muted small">${esc(a.detail)}</div>
            ${a.tags.length ? `<div class="row" style="margin-top:6px;gap:4px">${a.tags.map((t) => `<span class="chip ${esc(t.tone)}">${esc(t.text)}</span>`).join('')}</div>` : ''}
          </div>
          <div class="gm-ctas">${ctaButton(a.secondary)}${ctaButton(a.cta, true)}</div>
        </div>`).join('') || '<div class="empty">☕ Nothing needs you right now.</div>'}
    </div>`;

  $$('[data-as]').forEach((b) => b.addEventListener('click', () => {
    $('#user').value = b.dataset.as;
    $('#user').dispatchEvent(new Event('change'));
  }));
  $$('[data-endpoint]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
    await api(b.dataset.endpoint, { method: 'POST', body: b.dataset.body ? JSON.parse(b.dataset.body) : undefined });
    if (b.dataset.done) toast(esc(b.dataset.done));
    route({ keepScroll: true });
  })));
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
async function renderAccounts() {
  const list = await api('/api/accounts');
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Accounts</h1><p class="muted">Hotel groups: CRM, product usage from Snowflake, and open work, in one row.</p></div>
      <input class="input" id="q" placeholder="Search accounts…" style="max-width:260px" />
    </div>
    <div class="card table-wrap">
      <table class="table">
        <thead><tr><th>Account</th><th>Status</th><th class="hide-sm">Segment</th><th class="hide-sm">Properties</th><th class="hide-sm">ARR</th><th class="hide-sm">Spend via Reeco (30d)</th><th>Health</th><th class="hide-sm">Open</th></tr></thead>
        <tbody>${list.map((a) => `
          <tr data-href="#/accounts/${a.id}" data-q="${esc(`${a.name} ${a.domain} ${a.segment} ${a.status}`.toLowerCase())}">
            <td><div style="font-weight:600">${esc(a.name)}</div><div class="muted xs">${esc(a.domain)}</div></td>
            <td>${statusChip(a.status)}</td>
            <td class="hide-sm small">${esc(a.segment)}</td>
            <td class="hide-sm small num">${a.usage ? `${a.usage.propertiesLive}/` : ''}${a.properties}</td>
            <td class="hide-sm num">${money(a.deal.amount)}</td>
            <td class="hide-sm num">${a.usage ? moneyCompact(a.usage.spend30d) : '<span class="muted">n/a</span>'}</td>
            <td>${healthBar(a.health)}</td>
            <td class="hide-sm small">${a.openConversations} convos · ${a.openTickets} tickets</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;
  $$('tbody tr').forEach((tr) => tr.addEventListener('click', () => (location.hash = tr.dataset.href)));
  $('#q').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$('tbody tr').forEach((tr) => (tr.hidden = q && !tr.dataset.q.includes(q)));
  });
}

function conversationBlock(c) {
  return `
    <div class="thread">
      ${c.messages.map((m) => `<div class="msg ${m.from}"><div class="who">${esc(m.author)} · ${rel(m.at)}</div>${esc(m.text)}</div>`).join('')}
    </div>
    ${c.state === 'open' ? `
      <form class="reply" data-conv="${esc(c.id)}" data-reason="${esc(c.ai?.category ?? '')}">
        <textarea class="input" name="text" rows="2" placeholder="Reply to customer (sent via Intercom)…" required></textarea>
        <div class="actions">
          <button class="btn primary sm" name="send">Send</button>
          <button class="btn sm" name="close">Send &amp; close</button>
        </div>
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
    const send = (reason) => run(btn, async () => {
      await api(`/api/conversations/${form.dataset.conv}/reply`, { method: 'POST', body: { text, close: Boolean(reason), reason } });
      form.reset();
      route({ keepScroll: true });
    });
    if (btn?.name === 'close') pickCloseReason(form.dataset.reason, (reason) => send(reason));
    else send();
  }));
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

  view.innerHTML = `
    <a class="back" href="#/accounts">← Accounts</a>
    <div class="page-head">
      <div>
        <h1>${esc(a.name)}</h1>
        <div class="row" style="margin-top:8px">
          ${statusChip(a.status)}
          <span class="chip">${esc(a.segment)}</span>
          <span class="chip">${a.properties} ${a.properties === 1 ? 'property' : 'properties'} · ${esc(a.region)}</span>
          <span class="chip">AE ${esc(a.owner)} · CSM ${esc(a.csm)}</span>
          ${a.health != null ? `<span class="chip ${a.health >= 75 ? 'good' : a.health >= 50 ? 'warn' : 'bad'}">Health ${a.health}</span>` : ''}
        </div>
      </div>
      <div class="row">
        <button class="btn" id="add-note">＋ Note</button>
        <button class="btn" id="new-ticket">＋ Jira ticket</button>
      </div>
    </div>

    <div class="detail-grid">
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

        <section class="card">
          <div class="card-head"><h2>Conversations</h2>${src('intercom')}</div>
          ${a.conversations.length ? a.conversations.map((c) => `
            <div class="${c.id === state.flashId ? 'flash' : ''}" style="border-bottom:1px solid var(--border)">
              <div class="list-item" style="border:0;padding-bottom:0">
                <a class="grow link" href="#/inbox/${esc(c.id)}">${esc(c.subject)}</a>
                ${slaChip(c)} ${c.escalatedTo ? `<span class="chip info">${esc(c.escalatedTo)}</span>` : ''}
                <span class="chip ${c.state === 'open' ? 'warn' : 'good'}">${c.state === 'open' ? 'Open' : 'Closed'}</span>
              </div>
              ${conversationBlock(c)}
            </div>`).join('') : '<div class="empty">No conversations.</div>'}
        </section>

        <section class="card">
          <div class="card-head"><h2>Tickets</h2>${src('jira')}</div>
          ${a.tickets.length ? a.tickets.map((t) => `
            <div class="list-item">
              <span class="mono muted" style="min-width:74px">${esc(t.key)}</span>
              <div class="grow">${esc(t.summary)}<div class="muted xs">${rel(t.createdAt)}</div></div>
              ${priorityChip(t.priority)} ${ticketStatus(t.status)}
            </div>`).join('') : '<div class="empty">No tickets.</div>'}
        </section>
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

  $$('.stage').forEach((b) => b.addEventListener('click', () => {
    if (b.classList.contains('current')) return;
    const won = b.dataset.stage === 'closedwon';
    const go = () => run(b, async () => {
      await api(`/api/accounts/${id}/deal-stage`, { method: 'POST', body: { stage: b.dataset.stage } });
      if (won) toast('<strong>Automation ran:</strong> #deals announcement, onboarding Slack channel, Jira epic, Snowflake events.', { ms: 7000 });
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
      const r = await api(`/api/accounts/${id}/discount`, { method: 'POST', body: data });
      toast(r.approvalNeeded ? 'Sent to <span class="mono">#deal-desk</span> for approval' : `Discount applied in HubSpot`);
      route({ keepScroll: true });
    }));

  $$('.check[data-step]').forEach((b) => b.addEventListener('click', () => run(b, async () => {
    await api(`/api/accounts/${id}/steps/${b.dataset.step}`, { method: 'POST' });
    route({ keepScroll: true });
  })));

  $('#sync')?.addEventListener('click', (e) => run(e.currentTarget, async () => {
    const r = await api(`/api/accounts/${id}/sync-usage`, { method: 'POST' });
    toast(r.ticked.length ? `<strong>Auto-completed:</strong> ${esc(r.ticked.join(', '))}` : 'Usage refreshed from Snowflake', { system: 'snowflake' });
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
    history.replaceState(null, '', `#/accounts/${id}`);
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
      <div class="row">
        <select class="input" id="sample" style="width:auto" aria-label="Inbound scenario">${INBOUND_SAMPLES.map((x, i) => `<option value="${i}">${esc(x.label)}</option>`).join('')}</select>
        <button class="btn" id="simulate">⚡ Simulate inbound</button>
      </div>
    </div>
    <div class="tabs" role="tablist" aria-label="Queues">
      ${INBOX_TABS.map((t) => { const n = items.filter((c) => t.test(c, me.name)).length; return `<button role="tab" class="tab ${t.id === tab.id ? 'sel' : ''}" data-tab="${t.id}" aria-selected="${t.id === tab.id}">${esc(t.label)} <span class="num">${n}</span></button>`; }).join('')}
    </div>
    <div class="card inbox3">
      <div class="inbox-list">
        ${reasons ? `<div class="reasons-chart"><div class="muted xs" style="margin-bottom:6px">Why customers contacted us</div>
          ${reasons.filter((r) => r.count).sort((x, y) => y.count - x.count).map((r) => `<div class="rbar"><span class="xs ellipsis">${esc(r.label)}</span><div class="bar"><span style="width:${(r.count / maxReason) * 100}%"></span></div><span class="xs num">${r.count}</span></div>`).join('')}</div>` : ''}
        ${list.map((i) => `
          <a class="inbox-item ${i.id === sel?.id ? 'active' : ''} ${i.id === state.flashId ? 'flash' : ''}" href="#/inbox/${esc(i.id)}">
            <div class="spread"><strong class="ellipsis">${esc(i.account.name)}</strong><span class="muted xs" style="flex:none">${rel(i.updatedAt)}</span></div>
            <div class="small ellipsis">${esc(i.subject)}</div>
            <div class="preview">${i.ai && i.ai.forMessages === i.messages.length ? `✨ ${esc(i.ai.summary)}` : esc(i.messages.at(-1)?.text)}</div>
            <div class="row" style="margin-top:6px;gap:4px">
              ${i.state === 'closed' ? `<span class="chip">${esc(reasonLabel(i.closeReason ?? '')) || 'Closed'}</span>` : ''}
              ${isSnoozed(i) ? `<span class="chip info">Snoozed until ${new Date(i.snoozedUntil).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>` : ''}
              ${slaChip(i)}
              <span class="chip ${i.assignee ? '' : 'warn'}">${i.assignee ? esc(i.assignee.split(' ')[0]) : 'Unassigned'}</span>
              ${i.account.segment === 'Enterprise' ? '<span class="chip brand">Enterprise</span>' : ''}
              ${i.flagged?.length && i.state === 'open' ? '<span class="chip bad">Flagged</span>' : ''}
              ${i.escalatedTo ? `<span class="chip info">${esc(i.escalatedTo)}</span>` : ''}
            </div>
          </a>`).join('') || `<div class="empty">${tab.id === 'mine' ? 'Nothing assigned to you. Check <b>Unassigned</b>.' : 'Nothing here.'}</div>`}
      </div>

      <div class="inbox-thread">
        ${sel ? `
          <div class="card-head">
            <div class="grow"><h2>${esc(sel.subject)}</h2><a class="link small" href="#/accounts/${sel.account.id}">${esc(sel.account.name)} →</a></div>
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
            ${sel.escalatedTo ? `<span class="chip info">Escalated · ${esc(sel.escalatedTo)}</span>` : '<button class="btn sm" id="escalate">🚨 Escalate</button>'}
            <button class="btn sm" id="close">✓ Close</button>
          </div>` : ''}
          <div class="ctx">
            ${slaChip(sel)}
            ${isSnoozed(sel) ? `<span class="chip info">Snoozed until ${new Date(sel.snoozedUntil).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })} (SLA still running)</span>` : ''}
            ${(sel.flagged ?? []).map((f) => `<span class="chip bad">${esc(f)}</span>`).join('')}
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
    if (msg) toast(msg);
    route({ keepScroll: true });
  });
  $('#assignee')?.addEventListener('change', (e) => act(e.target, 'assign', { assignee: e.target.value || null }));
  $('#take')?.addEventListener('click', (e) => act(e.currentTarget, 'assign', { assignee: me.name }, 'Assigned to you'));
  $('#snooze')?.addEventListener('change', (e) => e.target.value && act(e.target, 'snooze', { until: e.target.value }, 'Snoozed. It comes back when the time is up or the customer replies.'));
  $('#unsnooze')?.addEventListener('click', (e) => act(e.currentTarget, 'snooze', { until: null }));
  $('#escalate')?.addEventListener('click', (e) => act(e.currentTarget, 'escalate', null, 'Escalated: Jira bug, Slack #support-escalations, Intercom note'));
  $('#close')?.addEventListener('click', (e) => pickCloseReason(sel.ai?.category, (reason) => act(e.currentTarget, 'close', { reason }, `Closed as “${reasonLabel(reason)}”`)));
  $('#ai-run')?.addEventListener('click', (e) => act(e.currentTarget, 'ai'));
  $('#ai-use')?.addEventListener('click', () => {
    const ta = $('form.reply textarea');
    ta.value = sel.ai.suggested_reply;
    ta.focus();
    ta.style.height = `${Math.min(ta.scrollHeight + 4, 260)}px`;
  });

  $('#simulate').addEventListener('click', (e) => run(e.currentTarget, async () => {
    const x = INBOUND_SAMPLES[$('#sample').value];
    // Same shape as Intercom's conversation.user.created webhook
    const res = await fetch('/webhooks/intercom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'notification_event', topic: 'conversation.user.created', data: { item: { type: 'conversation', id: String(215470000 + Math.floor(Math.random() * 99999)), source: { body: `<p>${x.text}</p>`, author: { type: 'user', email: x.email } } } } }),
    });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error);
    state.inboxTab = 'unassigned';
    location.hash = `#/inbox/${r.conversationId}`;
  }));
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
    const results = await Promise.all(active.map((a) => api(`/api/accounts/${a.id}/sync-usage`, { method: 'POST' })));
    const ticked = results.flatMap((r) => r.ticked.map((t) => `${r.account.name}: ${t}`));
    toast(ticked.length ? `<strong>Auto-completed</strong><br>${ticked.map(esc).join('<br>')}` : 'Usage refreshed, no new milestones', { system: 'snowflake', ms: 7000 });
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
    toast('Approved from Slack. HubSpot updated.', { system: 'slack' });
    route({ keepScroll: true });
  })));
}

// ---------- integration log ----------
function renderLog() {
  const rows = state.log.filter((r) => !state.logFilter || r.system === state.logFilter);
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Integration log</h1><p class="muted">Every call the hub made to external systems: exact request, response, status, latency. Secrets are redacted.</p></div>
      <div class="filters">
        <span class="chip ${!state.logFilter ? 'sel' : ''}" data-f="" role="button" tabindex="0">All · ${state.log.length}</span>
        ${Object.entries(SYSTEMS).map(([k, s]) => `<span class="chip ${state.logFilter === k ? 'sel' : ''}" data-f="${k}" role="button" tabindex="0">${s.name} · ${state.log.filter((r) => r.system === k).length}</span>`).join('')}
      </div>
    </div>
    <div class="card">
      ${rows.map((r) => `
        <details class="log-row">
          <summary>
            <span class="xs muted num hide-sm">${new Date(r.ts).toLocaleTimeString('en-US', { hour12: false })}</span>
            ${src(r.system)}
            <span class="small ellipsis"><strong>${esc(r.action)}</strong> <span class="mono muted">${esc(r.request.method)} ${esc(r.request.url)}</span></span>
            <span class="chip hide-sm">${r.mode === 'live' ? 'LIVE' : 'MOCK'}</span>
            <span class="mono ${r.ok ? 'ok' : 'err'}">${r.status}</span>
            <span class="mono muted hide-sm">${r.durationMs}ms</span>
          </summary>
          <div class="log-body">
            <div><div class="muted xs" style="margin-bottom:4px">Request</div><pre class="code">${esc(`${r.request.method} ${r.request.url}\n${JSON.stringify(r.request.headers, null, 2)}\n\n${JSON.stringify(r.request.body ?? null, null, 2)}`)}</pre></div>
            <div><div class="muted xs" style="margin-bottom:4px">Response</div><pre class="code">${esc(JSON.stringify(r.response, null, 2))}</pre></div>
          </div>
        </details>`).join('') || '<div class="empty">No calls yet. Try closing a deal or escalating a conversation.</div>'}
    </div>`;
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
POST ${esc(origin)}/webhooks/slack      # Slack app → Interactivity request URL (approval buttons)</pre>
    </div>`;
  $('#reset').addEventListener('click', (e) => run(e.currentTarget, async () => {
    await api('/api/reset', { method: 'POST' });
    toast('Demo data reset');
  }));
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
  openModal(`<h2>Demo guide · 6 minutes</h2>
    <ol class="tour">
      <li><b>Good morning.</b> <a class="link" href="#/home">Start here</a>: each role lands on its own to-do list with one-click actions. Use <i>View as</i> to switch roles.</li>
      <li><b>Sales: close a deal.</b> Pipeline → <a class="link" href="#/accounts/harborline">Harborline</a> → click <i>Closed won</i>. Watch HubSpot, Slack, Jira and Snowflake fire in the corner.</li>
      <li><b>Deal desk.</b> <a class="link" href="#/accounts/northgate">Northgate</a> → <i>Request discount</i> 20%. Then <a class="link" href="#/approvals">Approvals</a> → <i>Simulate Slack click</i>.</li>
      <li><b>Support.</b> As Ron, open the <a class="link" href="#/inbox">Inbox</a>: <i>Mine</i> / <i>Unassigned</i> queues, and the <i>Account snapshot</i> on the right (platform, ERP sync, tickets, history). Click <i>✨ Summarize &amp; draft reply</i>, use the draft, then <i>Close</i> and pick a reason. The <i>Closed</i> tab shows why customers contact support.</li>
      <li><b>Onboarding.</b> <a class="link" href="#/onboarding">Onboarding</a> → <i>Sync all from Snowflake</i>. Usage-based steps tick themselves off, and a go-live gets announced.</li>
      <li><b>Under the hood.</b> <a class="link" href="#/log">Integration log</a> shows every exact API request and response.</li>
    </ol>`, null, null);
  $$('#modal a').forEach((a) => a.addEventListener('click', () => $('#modal').close()));
}

// ---------- router ----------
async function route({ keepScroll = false } = {}) {
  const [path, qs = ''] = (location.hash || '#/home').split('?');
  const [, section = 'home', id] = path.split('/');
  const query = new URLSearchParams(qs);
  const nav = section === 'accounts' && id ? 'accounts' : section;
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
  const y = scrollY;
  try {
    if (section === 'home') await renderHome();
    else if (section === 'accounts' && id) await renderAccount(id, query);
    else if (section === 'accounts') await renderAccounts();
    else if (section === 'inbox') await renderInbox(id);
    else if (section === 'onboarding') await renderOnboarding();
    else if (section === 'approvals') await renderApprovals();
    else if (section === 'log') renderLog();
    else if (section === 'connections') renderConnections();
    else if (section === 'pipeline') await renderPipeline();
    else await renderHome();
  } catch (err) {
    view.innerHTML = `<div class="card empty">Couldn't load this page: ${esc(err.message)}</div>`;
  }
  if (keepScroll) scrollTo(0, y);
}

async function init() {
  [state.meta, state.log] = await Promise.all([fetch('/api/meta').then((r) => r.json()), fetch('/api/log').then((r) => r.json())]);
  const sel = $('#user');
  sel.innerHTML = state.meta.users.map((u) => `<option value="${u.id}">${esc(u.name)} · ${esc(u.role)}</option>`).join('');
  try { const saved = localStorage.getItem('reeco-hub-user'); if (saved && state.meta.users.some((u) => u.id === saved)) sel.value = saved; } catch {}
  sel.addEventListener('change', () => { try { localStorage.setItem('reeco-hub-user', sel.value); } catch {} route({ keepScroll: true }); });
  $('#tour-btn').addEventListener('click', openTour);
  addEventListener('hashchange', () => { route(); });
  setInterval(() => { if (/^#\/(inbox|accounts\/)/.test(location.hash)) scheduleRender(); }, 60_000); // SLA countdowns
  connectEvents();
  refreshBadges();
  await route();
  try { if (!localStorage.getItem('reeco-hub-toured')) { localStorage.setItem('reeco-hub-toured', '1'); openTour(); } } catch {}
}

init();
