# Reeco Hub

> All companies, people and numbers in the demo data are fictional.

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

Everything runs in **mock mode** by default: each request is built exactly as the real API expects, shown in the Activity log (under "Technical details"), and answered with a realistic fake response. To connect a real sandbox, copy `.env.example` to `.env` and fill in that system's credentials. Each system goes live on its own.

## Deploy to Render (shareable link)

1. Render dashboard → **New** → **Blueprint** → select this repo (it uses `render.yaml`).
2. Set `PUBLIC_URL` to the service URL once Render assigns it, e.g. `https://reeco-hub.onrender.com`.
3. Share the link. Demo data lives in memory: it resets on restart, and anyone can reset it from **Connections → Reset demo data**.

On Render's free plan the service sleeps after about 15 minutes idle, and the first visit after that takes around 30 seconds to wake it.

## Demo script (6 minutes)

The same steps, with links, are in the app under the user menu (bottom-left) → **Demo guide**, or press **?**.

0. **Good morning.** Everyone lands on a role-specific dashboard: a short summary, four KPIs, and a ranked list of next best actions, each with a call to action. Many actions complete in one click (approve a discount, escalate a conversation, mark an onboarding step done, sync usage). Switch between Account Executive, Sales Manager, Support and Customer Success from the user menu at the bottom-left.
1. **Sales pipeline.** Sign in as *Maya K. (Account Executive)* and open **Pipeline**: open deals only, as a **Board** (drag between stages) or a **Table** (sortable, stage menu per row). Each rep's choice is remembered. **My deals / Team** switches scope.
   - **Next suggested action** on every deal: one card that says what to do and why ("Follow up with Hannah · No reply in 16 days"); the whole card is the button. **+N more** opens the deal's other suggestions as identical cards; Good morning lists the day's top actions across deals. Signals: prospects who've gone quiet (no reply in 7+ days, high priority at 14) with a drafted follow-up that's logged in HubSpot; close dates that have passed; deals stuck in a stage; missing deal info; and **a colleague won a similar deal** (same segment and ERP, similar size, shared modules), with the business value and what worked, plus **Ask in Slack** to DM that colleague.
   - **Stage gates:** moving a deal forward asks for what the stage needs, prefilled from HubSpot and saved back to it. Qualified: pain, properties, ERP, decision maker. Demo: date, Solutions Engineer, what to show, attendees; the SE gets the details in a Slack DM. Champion: champion and business value. Contract: signer, close date, legal contact. Closed lost: reason (and competitor).
   - Try it: drag *Northgate Inns* to **Demo**, or use **Follow up** on *Lakeview Lodges*.
   - **Close a deal:** mark *Harborline Hotel Group* **Closed won**. One click updates HubSpot, announces in `#deals`, creates `#onb-harborline` with the checklist, opens a Jira onboarding epic and logs to Snowflake.
2. **Deal desk.** *Northgate Inns* → **Request discount** 20% (the approval threshold is 15%). The request goes to `#deal-desk` with Approve/Reject buttons. **Approvals** is a table (pending / decided / all) with the discount, the ARR after it, the reason and the decision; approve as *Eitan B. (Sales Manager)*, or as an AE use **Approve as Eitan in Slack** to simulate the Slack click.
3. **Support.** Sign in as *Ron A. (Support)* and open **Inbox**.
   - **Queue:** a table of conversations (customer, subject, classification, reply due, owner, last message), most urgent first and sortable by any column, in tabs: Mine / Unassigned / Enterprise / Overdue / All open / Snoozed / Closed. Click a row, or use `J` / `K` and `Enter`, to open it.
   - **Conversation:** one conversation at a time, with **Previous / Next** through the queue. **Assign to me**, change owner, or **Snooze** (1h, 4h, tomorrow). A snoozed conversation wakes up when the customer replies. Closing or snoozing moves on to the next one. Every change syncs to Intercom.
   - **Classification:** every conversation is classified when it arrives: How-to, Reeco technical issue, Integration (naming the tool: NetSuite, Sage Intacct, QuickBooks…), Feature request, or Account / billing. Agents can correct it from the conversation; AI assist refines it. Each card shows three lines: reply due, classification, owner.
   - **Account snapshot:** a one-line strip above the conversation (health, ARR, ERP sync status, open tickets, CSM). Click it for the full snapshot in a side panel: platform status from Snowflake (ERP, sync status, errors in 24h, app version), open Jira tickets, and past conversations with their close reasons.
   - **✨ AI assist:** one click gives a summary, the customer's mood, the likely category, a next step and a draft reply (Claude via the Anthropic API, or a rules-based stand-in in mock mode). **Use this reply** puts the draft in the reply box.
   - **Close with a reason:** closing always asks why (the AI's suggested category is preselected). The reason is tagged in Intercom and logged to Snowflake. The **Closed** tab charts why customers contact support.
   - **Simulate inbound** (Enterprise, angry) is auto-flagged to `#support-escalations`; **Escalate to engineering** (red, and it asks first) opens a Jira bug with an Intercom internal note and a Slack alert; **Close conversation** is a separate button and always asks for a reason. The reply box only sends. SLA countdowns are 1h for Enterprise and 4h for everyone else, and a breach alerts Slack once.
4. **Customer Success.** Sign in as *Dana S. (Customer Success)*.
   - **My portfolio:** a table of her accounts, riskiest first: health, one line on what's going on, the 12-week usage trend, the renewal date, and a **Next suggested action** card per account (the same cards as the Pipeline): *Look into the sync errors*, *Start a save plan*, *Tell Priya it shipped*, *Complete "Accounting / ERP integration"*. **+N more** opens the rest. **Mine / Team** switches scope.
   - **Health score (0–100), explainable:** usage trend 30%, adoption 15%, support load 20%, platform stability 15%, sentiment 20%. Each part shows its score and the reason; a renewal within 90 days amplifies other warning signs. High risk < 50, medium < 70. The Health tab starts with the account's suggested actions.
   - **Usage anomalies (Snowflake):** last week vs the 4 weeks before; a 30%+ drop in POs, AI invoices or active users, or an ERP sync-error spike, is an anomaly. **Check usage now** (also every 30 minutes automatically) DMs the CSM in Slack; **Review** saves what she found to HubSpot.
   - **Save plan:** for an at-risk account, one pop-up with a drafted plan; it's saved to HubSpot and the AE gets it in Slack.
   - **Support on her accounts:** each account's Support tab lists open conversations (reply due, classification, owner), engineering tickets and past conversations. Escalations and flagged messages DM the CSM in Slack.
   - **Feature requests:** closing a support conversation as "Feature request" logs it in Jira (`PROD`) or adds the account to a matching existing request. Status changes arrive from Jira (`/webhooks/jira`, or the demo arrow next to a status) and DM the CSMs of every account that asked. When it ships, **Tell the customer** sends an Intercom message and a HubSpot note.
5. **Onboarding.** A table of every hotel group from kickoff to go-live (In progress / Live / All), with progress, the next manual step as a suggested action, and the timeline. **Refresh usage** ticks off usage-based steps (vendors connected, first PO, first AI invoice); the CSM marks manual steps done. When all six are done, go-live is announced.
6. **Under the hood.** The **Activity log** tells the story of every action in plain words (for example "Ticket SUP-2311 escalated to engineering, and Moshe L. (VP Support) was notified"). Open a row to see each step, and "Technical details" for the exact request and response.

## Roles and access

Each role sees only its own work. Switch user from the menu at the bottom-left to see the workspace change.

| Role | Sees |
|---|---|
| **Account Executive** (Maya, Noa, Daniel) | Good morning, Accounts, Pipeline (own deals), Approvals (own requests) |
| **Sales Manager** (Eitan) | The same for the whole team, and approves discounts |
| **Support** (Ron, Tal) | Good morning, Accounts, Inbox, Feature requests (view) |
| **Customer Success** (Dana) | Good morning, Accounts, My portfolio, Onboarding, Feature requests |
| **Admin** (Alex, RevOps) | Everything, including the Activity log and Connections |

- The account page shows each role the tabs it needs (Support lands on Support, CS on Health, Sales on the deal). Other teams' information is read-only; Support still sees ARR and segment for prioritising.
- Search, keyboard shortcuts and live notifications follow the same rules, and a link to another team's page shows a friendly "not part of your workspace" page.
- **The server enforces it.** The rules live in `src/access.js`; every API call is checked against them (a guard table in `server.js`), and AEs can only change their own deals. In production, roles come from SSO groups (Google / Okta) and records are scoped by HubSpot owner.

## Working in the hub

- **Search:** `Ctrl K` / `⌘K` or `/` jumps to any account, open conversation or page.
- **Keyboard:** `G` then `H` / `P` / `I` / `O` / `A` / `L` to switch pages, `J` / `K` to move through the inbox (`Enter` opens), `?` for all shortcuts.
- **User menu** (bottom-left): switch demo user, light / dark / system theme, demo guide, reset demo data.
- Irreversible actions (mark a deal lost, reset data) ask for confirmation; hovering a notification keeps it open.
- The account page shows the deal's next suggested actions (same cards as the Pipeline); finished onboarding folds into one line.

## Rules (in `src/store.js → CONFIG`)

- Discounts above **15%** need Sales Manager approval.
- A prospect is **quiet** after 7 days without a reply (high priority from 14). A deal is **stuck** after 14 days in Discovery, Qualified or Champion, or 10 in Demo or Contract sent.
- Close reasons: Platform bug (fixed / workaround), ERP / integration, How-to, Feature request, Account / billing, No response.
- SLA: **Enterprise 1h**, Mid-market and Independent **4h**.
- Auto-flag to Slack: any Enterprise message, or an upset customer (keyword match). The flag drives the Slack alert; the inbox shows the classification instead.
- Onboarding steps: vendors connected (auto), catalog & pricing, accounting/ERP integration, staff trained, first PO (auto), first AI-processed invoice (auto).

## Architecture

```
Browser (vanilla JS, no build)
   │  REST + Server-Sent Events (live toasts, multi-user refresh)
   ▼
home.js ────── Good morning dashboard: per-role KPIs and next best actions
deals.js ───── sales signals: quiet prospects, stuck deals, stage gates, similar wins
server.js ──── inbound webhooks: /webhooks/intercom, /webhooks/slack (signature-verified)
   │
services.js ── business actions & automations ("what happens when a deal closes")
   │
connectors/ ── hubspot · intercom · jira · slack · snowflake · claude
   │
http.js ────── single outbound gateway: logging, timing, secret redaction, mock/live switch
activity.js ── groups each user action's calls and writes the one plain-language outcome users see
access.js ──── roles: what each role can see and do (enforced by the server, mirrored by the UI)
```

To add a system (e.g. NetSuite, Sage Intacct, Gong), add a file in `src/connectors/` and call it from `services.js`.

## From prototype to production

- **Live reads and sync.** Seed data lives in `src/store.js`. Production would back it with Postgres, kept current by HubSpot, Jira and Intercom webhooks plus scheduled Snowflake pulls.
- **Auth.** Google or Okta SSO with roles (Sales, Support, CS, Manager). Today the user is picked from a dropdown.
- **Reliability.** A job queue with retries and idempotency keys for outbound calls; SLA checks in a scheduler instead of `setInterval`.
- **Secrets.** Keep credentials in a secret manager rather than environment files.

## Branding

Brand color `#28C888`, with `#F1FBF7`, `#E9E6EB`, `#DBDDE2`, `#71DBAE` and `#F8F8F8`, all defined as tokens at the top of `public/styles.css`. Text on the green fill uses a dark ink for contrast. The wordmark is currently text; drop a logo into `public/` and swap the `.brand` block in `index.html` to use it.
