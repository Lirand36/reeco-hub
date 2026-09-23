// Intercom REST API. Docs: https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations
import { send } from './http.js';

const BASE = 'https://api.intercom.io';
export const isLive = () => Boolean(process.env.INTERCOM_TOKEN && process.env.INTERCOM_ADMIN_ID);
const headers = () => ({ Authorization: `Bearer ${process.env.INTERCOM_TOKEN}`, 'Intercom-Version': '2.11' });
const adminId = () => process.env.INTERCOM_ADMIN_ID || 'ADMIN_ID';

function part(conversationId, action, body, state) {
  return send({
    system: 'intercom',
    action,
    method: 'POST',
    url: `${BASE}/conversations/${conversationId}/${body.message_type === 'close' ? 'parts' : 'reply'}`,
    headers: headers(),
    body,
    live: isLive(),
    mockResponse: { type: 'conversation', id: conversationId, state },
  });
}

export const reply = (id, text) =>
  part(id, 'Reply to customer', { message_type: 'comment', type: 'admin', admin_id: adminId(), body: text }, 'open');

// Internal note: visible to the team inside Intercom, not to the customer
export const note = (id, text) =>
  part(id, 'Add internal note', { message_type: 'note', type: 'admin', admin_id: adminId(), body: text }, 'open');

export const close = (id) =>
  part(id, 'Close conversation', { message_type: 'close', type: 'admin', admin_id: adminId() }, 'closed');

// POST /conversations/{id}/parts handles assignment, snooze and reopen as well.
function manage(id, action, body, mock) {
  return send({
    system: 'intercom',
    action,
    method: 'POST',
    url: `${BASE}/conversations/${id}/parts`,
    headers: headers(),
    body: { type: 'admin', admin_id: adminId(), ...body },
    live: isLive(),
    mockResponse: { type: 'conversation', id, ...mock },
  });
}

export const assign = (id, assigneeId) =>
  manage(id, assigneeId ? 'Assign conversation' : 'Unassign conversation', { message_type: 'assignment', assignee_id: assigneeId ?? '0' }, { admin_assignee_id: assigneeId ?? null });

export const snooze = (id, untilIso) =>
  manage(id, 'Snooze conversation', { message_type: 'snoozed', snoozed_until: Math.floor(new Date(untilIso) / 1000) }, { state: 'snoozed' });

export const reopen = (id) => manage(id, 'Reopen conversation', { message_type: 'open' }, { state: 'open' });

// Tags must exist in Intercom; map reason → tag id via INTERCOM_TAG_IDS (JSON), e.g. {"bug_fixed":"7351002"}
export function tag(id, reasonId, label) {
  let ids = {};
  try { ids = JSON.parse(process.env.INTERCOM_TAG_IDS || '{}'); } catch {}
  return send({
    system: 'intercom',
    action: `Tag conversation: ${label}`,
    method: 'POST',
    url: `${BASE}/conversations/${id}/tags`,
    headers: headers(),
    body: { id: ids[reasonId] ?? `TAG_${reasonId}`, admin_id: adminId() },
    live: isLive(),
    mockResponse: { type: 'tag', id: ids[reasonId] ?? `mock_${reasonId}`, name: label },
  });
}
