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
