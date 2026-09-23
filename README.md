# Reeco Hub (concept)

> A concept prototype, **not an official Reeco product**. All companies, people and numbers in the demo are fictional.

Reeco Hub is one internal workspace for Reeco's Sales, Support and Customer Success teams. Reps work in a single UI built around Reeco's world (hotel groups, properties, purchase orders, AI-processed invoices). Behind it, the hub works through the tools Reeco already runs, so nobody has to switch between them:

| System | What the hub does with it |
|---|---|
| **HubSpot** | Moves deal stages, applies discounts, writes notes |
| **Intercom** | Receives customer messages (webhook), replies, closes, adds internal notes |
| **Jira** | Opens escalation bugs (`SUP`) and onboarding epics (`ONB`) |
| **Slack** | Posts deal wins, escalations and SLA breaches, runs discount approvals with buttons, creates a channel per onboarding customer |
| **Snowflake** | Reads product usage and platform status (ERP sync, errors, app version); writes every hub action to `GTM.HUB_EVENTS` |
| **Claude** | AI assist in the inbox: summary, customer mood, likely category, next step and a draft reply (structured output) |

## Run locally

```bash
npm install         # one dependency: the Anthropic SDK
npm start           # Node 22+
# → http://localhost:3000
```

Everything runs in **mock mode** by default: each request is built exactly as the real API expects, shown in the Integration log, and answered with a realistic fake response. To connect a real sandbox, copy `.env.example` to `.env` and fill in that system's credentials. Each system goes live on its own.

## Deploy to Render (shareable link)

1. Render dashboard → **New** → **Blueprint** → select this repo (it uses `render.yaml`).
2. Set `PUBLIC_URL` to the service URL once Render assigns it, e.g. `https://reeco-hub-concept.onrender.com`.
3. Share the link. Demo data lives in memory: it resets on restart, and anyone can reset it from **Connections → Reset demo data**.

On Render's free plan the service sleeps after about 15 minutes idle, and the first visit after that takes around 30 seconds to wake it.

## Demo script (6 minutes)

The **▶ Demo guide** button in the app has the same steps with links.

0. **Good morning.** Everyone lands on a role-specific dashboard: a short summary, four KPIs, and a ranked list of next best actions, each with a call to action. Many actions complete in one click (approve a discount, escalate a conversation, mark an onboarding step done, sync usage). Use **View as** to switch between Account Executive, Sales Manager, Support and Customer Success.
1. **Close a deal.** Open *Harborline Hotel Group* → click **Closed won**. One click updates HubSpot, announces in `#deals`, creates `#onb-harborline` with the checklist, opens a Jira onboarding epic and logs to Snowflake.
2. **Deal desk.** *Northgate Inns* → **Request discount** 20% (the approval threshold is 15%). The request goes to `#deal-desk` with Approve/Reject buttons. Approve it from **Approvals**, either as *Eitan B. (Sales Manager)* or with **Simulate Slack click**.
3. **Support.** Sign in as *Ron A. (Support)* and open **Inbox**.
   - **Queues:** Mine / Unassigned / Enterprise / Overdue / All open / Snoozed / Closed. **Assign to me**, change owner, or **Snooze** (1h, 4h, tomorrow). A snoozed conversation wakes up when the customer replies. Every change syncs to Intercom.
   - **Account snapshot** (right panel): health, ARR, CSM and AE, platform status from Snowflake (ERP, sync status, errors in 24h, app version), open Jira tickets, and past conversations with their close reasons.
   - **✨ AI assist:** one click gives a summary, the customer's mood, the likely category, a next step and a draft reply (Claude via the Anthropic API, or a rules-based stand-in in mock mode). **Use this reply** puts the draft in the reply box.
   - **Close with a reason:** closing always asks why (the AI's suggested category is preselected). The reason is tagged in Intercom and logged to Snowflake. The **Closed** tab charts why customers contact support.
   - **Simulate inbound** (Enterprise, angry) is auto-flagged to `#support-escalations`; **Escalate** opens a Jira bug with an Intercom internal note and a Slack alert. SLA countdowns are 1h for Enterprise and 4h for everyone else, and a breach alerts Slack once.
4. **Onboarding.** **Onboarding** → **Sync all from Snowflake**. Usage-based steps (vendors connected, first PO, first AI invoice) tick themselves off; the CSM ticks manual steps. When all six are done, go-live is announced.
5. **Under the hood.** **Integration log** shows every exact request and response.

## Rules (in `src/store.js → CONFIG`)

- Discounts above **15%** need Sales Manager approval.
- Close reasons: Platform bug (fixed / workaround), ERP / integration, How-to, Feature request, Account / billing, No response.
- SLA: **Enterprise 1h**, Mid-market and Independent **4h**.
- Auto-flag to Slack: any Enterprise message, or negative-sentiment keywords.
- Onboarding steps: vendors connected (auto), catalog & pricing, accounting/ERP integration, staff trained, first PO (auto), first AI-processed invoice (auto).

## Architecture

```
Browser (vanilla JS, no build)
   │  REST + Server-Sent Events (live toasts, multi-user refresh)
   ▼
home.js ────── Good morning dashboard: per-role KPIs and next best actions
server.js ──── inbound webhooks: /webhooks/intercom, /webhooks/slack (signature-verified)
   │
services.js ── business actions & automations ("what happens when a deal closes")
   │
connectors/ ── hubspot · intercom · jira · slack · snowflake · claude
   │
http.js ────── single outbound gateway: logging, timing, secret redaction, mock/live switch
```

To add a system (e.g. NetSuite, Sage Intacct, Gong), add a file in `src/connectors/` and call it from `services.js`.

## From concept to production

- **Live reads and sync.** Seed data lives in `src/store.js`. Production would back it with Postgres, kept current by HubSpot, Jira and Intercom webhooks plus scheduled Snowflake pulls.
- **Auth.** Google or Okta SSO with roles (Sales, Support, CS, Manager). Today the user is picked from a dropdown.
- **Reliability.** A job queue with retries and idempotency keys for outbound calls; SLA checks in a scheduler instead of `setInterval`.
- **Secrets.** Keep credentials in a secret manager rather than environment files.

## Branding

Brand color `#28C888`, with `#F1FBF7`, `#E9E6EB`, `#DBDDE2`, `#71DBAE` and `#F8F8F8`, all defined as tokens at the top of `public/styles.css`. Text on the green fill uses a dark ink for contrast. The wordmark is currently text; drop a logo into `public/` and swap the `.brand` block in `index.html` to use it.
