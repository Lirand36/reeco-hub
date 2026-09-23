// Claude (Anthropic API) for support assist: summary, sentiment, likely close reason and a draft reply.
// Docs: https://docs.claude.com/en/api/messages
import Anthropic from '@anthropic-ai/sdk';
import { record } from './http.js';

export const isLive = () => Boolean(process.env.ANTHROPIC_API_KEY);
const MODEL = () => process.env.CLAUDE_MODEL || 'claude-opus-5';

let client;
const getClient = () => (client ??= new Anthropic());

const SYSTEM = `You help support agents at Reeco, an AI procure-to-pay platform for hotels (purchasing, receiving, inventory, AP automation, ERP sync to NetSuite / Sage Intacct / QuickBooks).
Support's job is resolving problems customers hit on the Reeco platform.
Given one customer conversation plus account context, return:
- summary: at most two sentences an agent can read in five seconds. State the problem and what the customer wants.
- sentiment: the customer's current mood.
- category: the most likely reason code if this conversation were closed now.
- next_step: one short internal recommendation for the agent (for example, escalate to engineering, check sync logs, send the how-to link).
- suggested_reply: a reply the agent could send as-is. Warm, specific, plain text, under 90 words, signed with the agent's first name. Never promise a fix date. If there is an open engineering ticket, reference it.`;

// Structured outputs guarantee the response matches this schema.
const SCHEMA = (categories) => ({
  type: 'object',
  properties: {
    summary: { type: 'string' },
    sentiment: { type: 'string', enum: ['calm', 'confused', 'frustrated', 'angry'] },
    category: { type: 'string', enum: categories },
    next_step: { type: 'string' },
    suggested_reply: { type: 'string' },
  },
  required: ['summary', 'sentiment', 'category', 'next_step', 'suggested_reply'],
  additionalProperties: false,
});

export async function assist({ context, transcript, agentName, categories, mock }) {
  const params = {
    model: MODEL(),
    max_tokens: 2000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA(categories) } },
    // Server-side fallback: if the model declines, Anthropic re-runs on its recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: `Agent: ${agentName}\n\nAccount context:\n${context}\n\nConversation:\n${transcript}` }],
  };

  const entry = await record({
    system: 'claude',
    action: 'Summarize & draft reply',
    summary: 'Read the conversation and drafted a reply',
    live: isLive(),
    request: { method: 'POST', url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': '••••••', 'anthropic-beta': params.betas.join(',') }, body: { ...params, system: SYSTEM.slice(0, 120) + '…' } },
    run: async () => {
      const res = await getClient().beta.messages.create(params);
      if (res.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined this request'), { status: 200 });
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return { model: res.model, stop_reason: res.stop_reason, usage: res.usage, output: JSON.parse(text) };
    },
    mockResponse: () => ({ model: MODEL(), stop_reason: 'end_turn', output: mock() }),
  });

  if (!entry.ok) {
    const e = new Error(`Claude: ${entry.response.error}`);
    e.status = 502;
    throw e;
  }
  return { ...entry.response.output, model: entry.response.model, mode: entry.mode };
}
