// Intercom REST API. Docs: https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations
import { send } from './http.js';

const BASE = 'https://api.intercom.io';
export const isLive = () => Boolean(process.env.INTERCOM_TOKEN && process.env.INTERCOM_ADMIN_ID);
const headers = () => ({ Authorization: `Bearer ${process.env.INTERCOM_TOKEN}`, 'Intercom-Version': '2.11' });
const adminId = () => process.env.INTERCOM_ADMIN_ID || 'ADMIN_ID';

function part(conversationId, action, body, state, summary) {
  return send({
    system: 'intercom',
    action,
    summary,
    method: 'POST',
    url: `${BASE}/conversations/${conversationId}/${body.message_type === 'close' ? 'parts' : 'reply'}`,
    headers: headers(),
    body,
    live: isLive(),
    mockResponse: { type: 'conversation', id: conversationId, state },
  });
}

export const reply = (id, text) =>
  part(id, 'Reply to customer', { message_type: 'comment', type: 'admin', admin_id: adminId(), body: text }, 'open', 'Sent the reply to the customer');

// Internal note: visible to the team inside Intercom, not to the customer
export const note = (id, text) =>
  part(id, 'Add internal note', { message_type: 'note', type: 'admin', admin_id: adminId(), body: text }, 'open', 'Left an internal note for the team');

// Admin-initiated in-app message to a customer (e.g. "the feature you asked for is live").
export function message(email, name, text) {
  return send({
    system: 'intercom',
    action: 'Message customer',
    summary: `Sent ${name} an in-app message`,
    method: 'POST',
    url: `${BASE}/messages`,
    headers: headers(),
    body: { message_type: 'inapp', body: text, from: { type: 'admin', id: adminId() }, to: { type: 'user', email } },
    live: isLive(),
    mockResponse: () => ({ type: 'admin_message', id: String(Math.floor(Math.random() * 1e9)), message_type: 'inapp' }),
  });
}

export const close = (id) =>
  part(id, 'Close conversation', { message_type: 'close', type: 'admin', admin_id: adminId() }, 'closed', 'Closed the conversation');

// POST /conversations/{id}/parts handles assignment, snooze and reopen as well.
function manage(id, action, body, mock, summary) {
  return send({
    system: 'intercom',
    action,
    summary,
    method: 'POST',
    url: `${BASE}/conversations/${id}/parts`,
    headers: headers(),
    body: { type: 'admin', admin_id: adminId(), ...body },
    live: isLive(),
    mockResponse: { type: 'conversation', id, ...mock },
  });
}

export const assign = (id, assigneeId, name) =>
  manage(id, assigneeId ? 'Assign conversation' : 'Unassign conversation', { message_type: 'assignment', assignee_id: assigneeId ?? '0' }, { admin_assignee_id: assigneeId ?? null },
    assigneeId ? `Assigned the conversation to ${name}` : 'Moved the conversation back to the unassigned queue');

export const snooze = (id, untilIso) =>
  manage(id, 'Snooze conversation', { message_type: 'snoozed', snoozed_until: Math.floor(new Date(untilIso) / 1000) }, { state: 'snoozed' }, 'Snoozed the conversation');

export const reopen = (id) => manage(id, 'Reopen conversation', { message_type: 'open' }, { state: 'open' }, 'Brought the conversation back from snooze');

// Tags must exist in Intercom; map reason → tag id via INTERCOM_TAG_IDS (JSON), e.g. {"bug_fixed":"7351002"}
export function tag(id, reasonId, label) {
  let ids = {};
  try { ids = JSON.parse(process.env.INTERCOM_TAG_IDS || '{}'); } catch {}
  return send({
    system: 'intercom',
    action: `Tag conversation: ${label}`,
    summary: `Tagged the conversation “${label}”`,
    method: 'POST',
    url: `${BASE}/conversations/${id}/tags`,
    headers: headers(),
    body: { id: ids[reasonId] ?? `TAG_${reasonId}`, admin_id: adminId() },
    live: isLive(),
    mockResponse: { type: 'tag', id: ids[reasonId] ?? `mock_${reasonId}`, name: label },
  });
}
