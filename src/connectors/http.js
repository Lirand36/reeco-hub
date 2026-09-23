// Single outbound gateway. Every call to an external system goes through here so it is
// logged, timed and streamed to the UI. In mock mode the request is built identically
// but never leaves the server; a fake response is returned instead.

import { randomUUID } from 'node:crypto';
import { bus } from '../bus.js';
import { current } from '../activity.js';

const MAX_LOG = 300;
let log = [];

const SECRET_HEADERS = ['authorization', 'x-api-key'];

function redact(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) =>
      SECRET_HEADERS.includes(k.toLowerCase()) ? [k, String(v).split(' ')[0] + ' ••••••'] : [k, v]
    )
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function send({ system, action, summary, method, url, headers = {}, body, live, mockResponse }) {
  const entry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    system,
    action,
    mode: live ? 'live' : 'mock',
    request: { method, url, headers: redact(headers), body },
    activityId: current()?.id,
  };
  const started = Date.now();

  if (live) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      entry.status = res.status;
      try { entry.response = JSON.parse(text); } catch { entry.response = text.slice(0, 2000); }
      // Slack answers HTTP 200 with { ok: false } on errors
      entry.ok = res.ok && entry.response?.ok !== false;
    } catch (err) {
      entry.status = 0;
      entry.ok = false;
      entry.response = { error: err.message };
    }
  } else {
    await sleep(120 + Math.random() * 280);
    entry.status = 200;
    entry.ok = true;
    entry.response = typeof mockResponse === 'function' ? mockResponse() : mockResponse ?? { ok: true };
  }

  finish(entry, started, summary);
  return entry;
}

// Plain-language line for the activity log, e.g. "Opened ticket SUP-2311". May depend on the response.
function finish(entry, started, summary) {
  entry.durationMs = Date.now() - started;
  const text = typeof summary === 'function' ? (entry.ok ? summary(entry.response) : null) : summary;
  entry.summary = entry.ok ? (text ?? entry.action) : `Couldn't complete: ${text ?? entry.action}`;
  log.unshift(entry);
  if (log.length > MAX_LOG) log.pop();
  bus.emit('integration', { id: entry.id, activityId: entry.activityId });
}

// For integrations called through an SDK rather than fetch: same logging, timing and streaming.
export async function record({ system, action, summary, request, live, run, mockResponse }) {
  const entry = { id: randomUUID(), ts: new Date().toISOString(), system, action, mode: live ? 'live' : 'mock', request, activityId: current()?.id };
  const started = Date.now();
  try {
    if (live) {
      entry.response = await run();
    } else {
      await sleep(600 + Math.random() * 700);
      entry.response = typeof mockResponse === 'function' ? mockResponse() : mockResponse;
    }
    entry.status = 200;
    entry.ok = true;
  } catch (err) {
    entry.status = err.status ?? 0;
    entry.ok = false;
    entry.response = { error: err.message };
  }
  finish(entry, started, summary);
  return entry;
}

export const getLog = () => log;
export const clearLog = () => { log = []; };
