# LaunchForward Receptionist — Webhook Server

Multi-tenant AI receptionist backend: **one Express server serves unlimited client bots at $29/month each.** There is no hardcoded client data anywhere — every bot's number, greeting, hours, and escalation target are read from Firestore at runtime.

## Firestore data layout

**`bots/{botId}`** — one doc per client bot:

```json
{
  "twilioNumber": "+15551234567",
  "clientId": "client-abc",
  "status": "active",
  "greeting": "Hi, thanks for calling Acme Plumbing!",
  "afterHoursMessage": "Sorry, we're closed right now. Leave a message and we'll call you back.",
  "escalationNumber": "+15557654321",
  "hours": {
    "timezone": "America/New_York",
    "mo": { "open": "09:00", "close": "17:00" },
    "tu": { "open": "09:00", "close": "17:00" },
    "we": { "open": "09:00", "close": "17:00" },
    "th": { "open": "09:00", "close": "17:00" },
    "fr": { "open": "09:00", "close": "17:00" },
    "sa": "closed",
    "su": "closed"
  }
}
```

**`calls/{CallSid}`** — one doc per call, keyed by Twilio's CallSid (idempotent):
`botId, clientId, from, to, direction: "inbound", startedAt, outcome
("in-progress" | "voicemail" | "completed" | ...), durationSec, endedAt`.

**`messages/{msgId}`** — voicemail records: `botId, callId, from, recordingUrl, createdAt`.

**`subscriptions/{stripeSubscriptionId}`** — Stripe subscription state per bot:
`stripeCustomerId, stripeSubscriptionId, botId, status, currentPeriodEnd, updatedAt`.

## Install

```bash
cd server
npm install
cp .env.example .env   # then fill in real values — never commit .env
```

Requires **Node 18+**.

## Configure env

See `.env.example`. The values you need from free accounts:

| Variable | Where to get it |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | twilio.com/console (free trial works) |
| `TWILIO_WEBHOOK_URL` | your public base URL, e.g. `https://your-api.onrender.com`. **On Netlify Functions, include the `/api` prefix**: `https://your-site.netlify.app/api` |
| `FIREBASE_*` | Firebase console → Project settings → Service accounts (generate a key) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | dashboard.stripe.com (test mode while developing) |
| `ADMIN_API_KEY` | make up a long random string |

Twilio trial numbers can call verified numbers only — fine for testing.

## Run locally

```bash
npm start        # listens on :3000 (or $PORT)
```

Verify: `curl http://localhost:3000/health` → `{"ok":true}`.

To test Twilio webhooks locally, expose the port (e.g. `ngrok http 3000`), set
`TWILIO_WEBHOOK_URL=https://<your-ngrok-url>` in `.env`, and point a Twilio
number at it (below). Twilio signature validation is skipped automatically when
no real `TWILIO_AUTH_TOKEN` is set — set the real token before going live.

## Deploy to Render (recommended — simpler)

1. Push this folder to a Git repo.
2. Render dashboard → **New → Web Service** → connect the repo.
3. Build command: `npm install` · Start command: `node server.js`.
4. Add all `.env` variables in the Render dashboard (Environment tab).
5. Your URL is `https://<name>.onrender.com` — use it as `TWILIO_WEBHOOK_URL`.

## Deploy to Netlify Functions

1. Push this folder (repo root = `server/`) to a Git repo.
2. Netlify dashboard → **Add new site → Import an existing project** → set the
   base directory to `server`.
3. Build command: `npm install` (no publish dir needed for functions-only).
4. Add all `.env` variables in Site settings → Environment variables.
5. Routes are served under `/api/*` (see `netlify.toml`), so set
   `TWILIO_WEBHOOK_URL=https://<your-site>.netlify.app/api`.

Netlify Functions cold-start on first call, adding a second or two to the first
call of the day — Render keeps the server warm, which is why it's recommended.

## Point a Twilio number at it

For each client's Twilio number (Twilio console → Phone Numbers → select number):

- **A CALL COMES IN**: `POST {TWILIO_WEBHOOK_URL}/voice`
- **Status callback**: `POST {TWILIO_WEBHOOK_URL}/voice/status` (check "call completed")

Then create the matching `bots` doc in Firestore with `twilioNumber` set to the
number in E.164 (`+15551234567`) and `status: "active"`.

## Stripe billing flow

1. Create a $29/mo recurring product in the Stripe dashboard (test mode first).
2. When a client pays, the admin dashboard creates the Stripe Checkout session
   with `metadata: { botId }` and sends the client the payment link.
3. `POST /stripe-webhook` handles the rest: `checkout.session.completed` →
   subscription doc created + bot set `active`; `customer.subscription.updated`
   → statuses synced; `customer.subscription.deleted` → bot `suspended`;
   `invoice.payment_failed` → subscription marked `past_due`.
4. Register the webhook endpoint in Stripe (Developers → Webhooks):
   `POST {TWILIO_WEBHOOK_URL}/stripe-webhook`, events as above.

Note: the webhook only flips statuses — actually provisioning a new bot
(number purchase, Firestore bot doc) is still done in the admin dashboard.
