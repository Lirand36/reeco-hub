// Slack Web API. Docs: https://api.slack.com/methods
import { send } from './http.js';

const BASE = 'https://slack.com/api';
export const isLive = () => Boolean(process.env.SLACK_BOT_TOKEN);
const auth = () => ({ Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` });

// Channel IDs are preferred in production; names keep the demo readable.
export const channels = () => ({
  deals: process.env.SLACK_CHANNEL_DEALS || '#deals',
  support: process.env.SLACK_CHANNEL_SUPPORT || '#support-escalations',
  dealDesk: process.env.SLACK_CHANNEL_DEAL_DESK || '#deal-desk',
});

const fakeTs = () => `${Math.floor(Date.now() / 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;

// `where` is a readable channel name for the activity log when `channel` is an ID.
export function postMessage(channel, text, blocks, action = 'Post message', where = channel) {
  return send({
    system: 'slack',
    action: `${action} → ${where}`,
    summary: `Posted in ${where}: “${text}”`,
    method: 'POST',
    url: `${BASE}/chat.postMessage`,
    headers: auth(),
    body: { channel, text, ...(blocks ? { blocks } : {}) },
    live: isLive(),
    mockResponse: () => ({ ok: true, channel: channel.startsWith('#') ? 'C0' + Math.random().toString(36).slice(2, 10).toUpperCase() : channel, ts: fakeTs() }),
  });
}

export function updateMessage(channel, ts, text, blocks) {
  return send({
    system: 'slack',
    action: 'Update message',
    summary: `Updated the Slack message: “${text}”`,
    method: 'POST',
    url: `${BASE}/chat.update`,
    headers: auth(),
    body: { channel, ts, text, ...(blocks ? { blocks } : {}) },
    live: isLive(),
    mockResponse: { ok: true, channel, ts },
  });
}

export function createChannel(name) {
  return send({
    system: 'slack',
    action: `Create channel #${name}`,
    summary: `Created the Slack channel #${name}`,
    method: 'POST',
    url: `${BASE}/conversations.create`,
    headers: auth(),
    body: { name, is_private: false },
    live: isLive(),
    mockResponse: () => ({ ok: true, channel: { id: 'C0' + Math.random().toString(36).slice(2, 10).toUpperCase(), name } }),
  });
}

// Block Kit helpers
export const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
export const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
export const buttons = (items) => ({
  type: 'actions',
  elements: items.map((b) => ({ type: 'button', text: { type: 'plain_text', text: b.text }, action_id: b.actionId, value: b.value, ...(b.style ? { style: b.style } : {}) })),
});
