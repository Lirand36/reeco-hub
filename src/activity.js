// Groups everything one user action causes (a Jira ticket, a Slack post, a Snowflake event…)
// under a single activity with a plain-language outcome. The UI shows the outcome as a toast
// and the activity log lists each activity with its steps; raw requests stay behind "details".

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { bus } from './bus.js';

const als = new AsyncLocalStorage();
const MAX = 150;
let activities = [];

export function withActivity(actor, fn) {
  const act = { id: randomUUID(), ts: new Date().toISOString(), actor, outcome: null, icon: 'i-done', tone: '' };
  return als.run(act, async () => {
    try {
      return await fn();
    } catch (err) {
      // Validation mistakes (4xx) aren't worth logging; a system failing is.
      if (!err.status || err.status >= 500) Object.assign(act, { outcome: err.message, icon: 'i-alert', tone: 'bad', failed: true });
      throw err; // the person who clicked sees the error from the response
    } finally {
      if (act.outcome) {
        activities.unshift(act);
        if (activities.length > MAX) activities.pop();
        // One friendly message per action, sent to everyone who has the hub open
        if (!act.failed) bus.emit('activity', { id: act.id, actor: act.actor, text: act.outcome, icon: act.icon, tone: act.tone, accountId: act.accountId });
      }
    }
  });
}

export const current = () => als.getStore();

// For webhooks, where we only learn who acted after reading the payload (e.g. the manager who clicked in Slack).
export function setActor(name) {
  const act = current();
  if (act && name) act.actor = name;
}

// The one sentence a user sees. Later calls in the same action replace earlier ones
// (e.g. "deal moved" → "deal won, onboarding started").
export function announce(text, { icon = 'i-done', tone = 'good', accountId } = {}) {
  const act = current();
  if (!act) return;
  Object.assign(act, { outcome: text, icon, tone, accountId: accountId ?? act.accountId });
}

export const getActivities = () => activities;
export const clearActivities = () => { activities = []; };
