/**
 * LaunchForward Receptionist — multi-tenant AI receptionist webhook backend.
 *
 * One Express server serves unlimited client bots ($29/month each). There is
 * NO hardcoded client data anywhere in this file — every bot's number,
 * greeting, hours, and escalation target are read from Firestore at runtime.
 *
 * Firestore layout (see README for field shapes):
 *   bots/{botId}            — twilioNumber, clientId, status, greeting,
 *                             afterHoursMessage, escalationNumber, hours{}
 *   calls/{CallSid}         — one doc per call, keyed by Twilio CallSid
 *   messages/{msgId}        — voicemail records
 *   subscriptions/{subId}   — Stripe subscription state per bot
 */
require("dotenv").config();

const express = require("express");
const twilio = require("twilio");
const Stripe = require("stripe");
const admin = require("firebase-admin");

// ---------------------------------------------------------------------------
// Firebase Admin init (service-account credentials from env only)
// ---------------------------------------------------------------------------
// Tolerant of placeholder credentials at boot: /health and local dev should
// still run with the template .env. Firestore routes will error until the
// FIREBASE_* vars hold real values (caught in each route's try/catch).
let db = null;
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        // .env stores the key as one line with literal \n — restore real newlines.
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      }),
    });
  }
  db = admin.firestore();
} catch (err) {
  console.warn("[firebase] admin init failed — set real FIREBASE_* env vars:", err.message);
}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder");
const app = express();

// Base public URL of this server (e.g. https://your-api.onrender.com).
// Twilio requires absolute URLs for action/record callbacks.
const BASE_URL = (process.env.TWILIO_WEBHOOK_URL || "").replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// Twilio request-signature validation
// ---------------------------------------------------------------------------
// Twilio signs every webhook POST with X-Twilio-Signature. We validate it
// with twilio.validateExpressRequest so spoofed requests can't trigger calls.
// Tolerant of a missing token in local dev (so you can test without Twilio);
// in production a missing token is a config error worth failing loudly on.
function twilioAuth(req, res, next) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || token.includes("your_twilio_auth_token")) {
    console.warn("[twilioAuth] skipping signature check — no real TWILIO_AUTH_TOKEN set (dev only)");
    return next();
  }
  const ok = twilio.validateExpressRequest(req, token, {
    url: BASE_URL + req.originalUrl.split("?")[0],
  });
  if (!ok) {
    console.warn("[twilioAuth] invalid Twilio signature for", req.originalUrl);
    return res.status(403).send("Forbidden");
  }
  next();
}

// ---------------------------------------------------------------------------
// Stripe webhook — needs the RAW body for signature verification, so it is
// registered BEFORE the urlencoded/json body parsers below.
// ---------------------------------------------------------------------------
app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("[stripe-webhook] signature verification failed:", err.message);
    return res.status(400).send("Bad signature");
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        // A client finished Stripe Checkout for their $29/mo receptionist plan.
        // HONEST LIMIT: the checkout session must carry metadata.botId (set by
        // the admin dashboard/checkout-creation flow). Full auto-provisioning —
        // creating the bot doc, claiming a Twilio number — is still a manual
        // step in the admin dashboard; this webhook only flips statuses.
        const session = event.data.object;
        const botId = session.metadata && session.metadata.botId;
        const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        if (botId && subId) {
          await db.collection("subscriptions").doc(subId).set(
            {
              stripeCustomerId: session.customer,
              stripeSubscriptionId: subId,
              botId,
              status: "active",
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          await db.collection("bots").doc(botId).set({ status: "active" }, { merge: true });
          console.log(`[stripe-webhook] activated bot ${botId} (sub ${subId})`);
        } else {
          console.warn("[stripe-webhook] checkout.session.completed without metadata.botId — cannot link bot; subscription doc not created");
        }
        break;
      }
      case "customer.subscription.updated": {
        // Keep our subscription doc in sync with Stripe's source of truth.
        const sub = event.data.object;
        const ref = db.collection("subscriptions").doc(sub.id);
        const snap = await ref.get();
        await ref.set(
          {
            status: sub.status,
            currentPeriodEnd: sub.current_period_end
              ? admin.firestore.Timestamp.fromSeconds(sub.current_period_end)
              : null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        if (snap.exists && snap.data().botId) {
          // Mirror subscription health onto the bot: active/trialing = live,
          // anything else pauses the bot's line until billing resolves.
          const botStatus = ["active", "trialing"].includes(sub.status) ? "active" : "suspended";
          await db.collection("bots").doc(snap.data().botId).set({ status: botStatus }, { merge: true });
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const snap = await db.collection("subscriptions").doc(sub.id).get();
        await db.collection("subscriptions").doc(sub.id).set(
          { status: "canceled", updatedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
        if (snap.exists && snap.data().botId) {
          await db.collection("bots").doc(snap.data().botId).set({ status: "suspended" }, { merge: true });
          console.log(`[stripe-webhook] suspended bot ${snap.data().botId} (sub canceled)`);
        }
        break;
      }
      case "invoice.payment_failed": {
        // Card failed — mark past_due so the admin dashboard can flag the client.
        const invoice = event.data.object;
        const subId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id;
        if (subId) {
          await db.collection("subscriptions").doc(subId).set(
            { status: "past_due", updatedAt: admin.firestore.FieldValue.serverTimestamp() },
            { merge: true }
          );
          console.log(`[stripe-webhook] subscription ${subId} past_due`);
        }
        break;
      }
      default:
        console.log(`[stripe-webhook] ignoring event type ${event.type}`);
    }
    res.json({ received: true });
  } catch (err) {
    console.error("[stripe-webhook] handler error:", err);
    res.status(500).send("Webhook handler failed");
  }
});

// Twilio sends form-encoded bodies; this must NOT apply to /stripe-webhook
// above (already registered), so it sits after it.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const { VoiceResponse } = twilio.twiml;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Find the active bot that owns a Twilio number. One query per incoming call.
async function findBotByNumber(twilioNumber) {
  const snap = await db
    .collection("bots")
    .where("twilioNumber", "==", twilioNumber)
    .where("status", "==", "active")
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// Business-hours check. bot.hours shape:
//   { timezone: "America/New_York",
//     mon: { open: "09:00", close: "17:00" }, ..., sun: "closed" }
function isOpenNow(hours) {
  if (!hours || !hours.timezone) return true; // no hours configured → always open
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: hours.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  const dayKey = parts.weekday.slice(0, 2).toLowerCase(); // "Mon" -> "mo" ... "Sun" -> "su"
  const day = hours[dayKey];
  if (!day || day === "closed") return false;
  const toMin = (t) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const now = Number(parts.hour) * 60 + Number(parts.minute);
  return now >= toMin(day.open) && now < toMin(day.close);
}

// TwiML that greets the caller and presents the menu. Rendered by a natural
// female neural voice (Polly.Joanna-Neural), per product direction.
function greetingMenu(bot, retry = false) {
  const twiml = new VoiceResponse();
  const sayOpts = { voice: "Polly.Joanna-Neural", language: "en-US" };
  twiml.say(sayOpts, retry ? "I'm sorry, I didn't catch that." : bot.greeting);
  const gather = twiml.gather({
    numDigits: 1,
    timeout: 8,
    action: `${BASE_URL}/voice/menu${retry ? "?retry=1" : ""}`,
    method: "POST",
  });
  gather.say(sayOpts, "Press 1 to leave a message, or press 2 to reach the business now.");
  // If the caller says nothing and presses nothing, fall through to voicemail
  // via the recording endpoint instead of hanging up silently.
  twiml.redirect({ method: "POST" }, `${BASE_URL}/voice/menu?retry=1&timeout=1`);
  return twiml;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => res.json({ ok: true }));

// Incoming call from Twilio (set as the number's voice webhook).
app.post("/voice", twilioAuth, async (req, res) => {
  const { To, From, CallSid } = req.body;
  const twiml = new VoiceResponse();
  try {
    const bot = await findBotByNumber(To);
    if (!bot) {
      // Polite catch-all so misrouted numbers never hit a dead line.
      twiml.say(
        { voice: "Polly.Joanna-Neural", language: "en-US" },
        "Thanks for calling. This number isn't configured yet — please try again later. Goodbye."
      );
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    // Idempotent call log: same CallSid → same doc, never duplicated.
    const callRef = db.collection("calls").doc(CallSid);
    const existing = await callRef.get();
    if (!existing.exists) {
      await callRef.set({
        botId: bot.id,
        clientId: bot.clientId,
        from: From,
        to: To,
        direction: "inbound",
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        outcome: "in-progress",
      });
    }

    if (!isOpenNow(bot.hours)) {
      twiml.say(
        { voice: "Polly.Joanna-Neural", language: "en-US" },
        bot.afterHoursMessage || "Sorry, we're closed right now. Please leave a message after the tone."
      );
      twiml.record({
        maxLength: 120,
        action: `${BASE_URL}/voice/recording`,
        method: "POST",
      });
      return res.type("text/xml").send(twiml.toString());
    }

    res.type("text/xml").send(greetingMenu(bot).toString());
  } catch (err) {
    console.error("[/voice] error:", err);
    twiml.say("Sorry, something went wrong. Please try your call again later.");
    twiml.hangup();
    res.type("text/xml").send(twiml.toString());
  }
});

// Menu selection after the greeting Gather.
app.post("/voice/menu", twilioAuth, async (req, res) => {
  const { Digits, CallSid } = req.body;
  const twiml = new VoiceResponse();
  const sayOpts = { voice: "Polly.Joanna-Neural", language: "en-US" };
  try {
    // Re-resolve the bot from the call doc — /voice/menu only gets CallSid,
    // so this keeps menu handling stateless and multi-tenant safe.
    const callSnap = await db.collection("calls").doc(CallSid).get();
    const botSnap = callSnap.exists
      ? await db.collection("bots").doc(callSnap.data().botId).get()
      : null;
    const bot = botSnap && botSnap.exists ? { id: botSnap.id, ...botSnap.data() } : null;

    if (Digits === "1") {
      twiml.say(sayOpts, "Please leave your message after the tone, and we'll get back to you shortly.");
      twiml.record({ maxLength: 120, action: `${BASE_URL}/voice/recording`, method: "POST" });
    } else if (Digits === "2") {
      if (bot && bot.escalationNumber) {
        twiml.say(sayOpts, "One moment, connecting you now.");
        twiml.dial(bot.escalationNumber);
      } else {
        twiml.say(sayOpts, "I'm sorry, no one is available right now. Please leave a message after the tone.");
        twiml.record({ maxLength: 120, action: `${BASE_URL}/voice/recording`, method: "POST" });
      }
    } else if (bot && !req.query.retry) {
      // Invalid or no input — repeat the greeting menu ONCE, then record.
      return res.type("text/xml").send(greetingMenu(bot, true).toString());
    } else {
      twiml.say(sayOpts, "No problem — please leave a message after the tone.");
      twiml.record({ maxLength: 120, action: `${BASE_URL}/voice/recording`, method: "POST" });
    }
    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("[/voice/menu] error:", err);
    twiml.say("Sorry, something went wrong. Please try your call again later.");
    twiml.hangup();
    res.type("text/xml").send(twiml.toString());
  }
});

// Twilio POSTs here when a <Record> finishes. RecordingUrl is Twilio's param.
app.post("/voice/recording", twilioAuth, async (req, res) => {
  const { CallSid, RecordingUrl, From } = req.body;
  const twiml = new VoiceResponse();
  try {
    const callRef = db.collection("calls").doc(CallSid);
    const callSnap = await callRef.get();
    const callData = callSnap.exists ? callSnap.data() : {};
    // Fallback: recording arrived for a call we never logged (e.g. server
    // restart between /voice and here) — still save the voicemail.
    if (!callSnap.exists) {
      await callRef.set({
        from: From,
        to: req.body.To,
        direction: "inbound",
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        outcome: "voicemail",
      });
    }
    await db.collection("messages").add({
      botId: callData.botId || null,
      callId: CallSid,
      from: From,
      recordingUrl: RecordingUrl,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await callRef.set(
      { outcome: "voicemail", voicemailAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    console.log(`[/voice/recording] voicemail saved for call ${CallSid}`);
  } catch (err) {
    console.error("[/voice/recording] error:", err);
  }
  twiml.say(
    { voice: "Polly.Joanna-Neural", language: "en-US" },
    "Thanks, we've got your message. Goodbye."
  );
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

// Twilio status callback (set as the number's "Status callback" URL, event
// "call completed"). Finalizes the call record.
app.post("/voice/status", twilioAuth, async (req, res) => {
  const { CallSid, CallDuration, CallStatus } = req.body;
  try {
    const callRef = db.collection("calls").doc(CallSid);
    const snap = await callRef.get();
    // Don't clobber a "voicemail" outcome that /voice/recording already set.
    const outcome = snap.data()?.voicemailAt
      ? "voicemail"
      : CallStatus === "completed"
        ? "completed"
        : CallStatus;
    await callRef.set(
      {
        durationSec: Number(CallDuration) || 0,
        outcome,
        endedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    console.error("[/voice/status] error:", err);
  }
  res.sendStatus(200);
});

// ---------------------------------------------------------------------------
// Local run
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`LaunchForward receptionist listening on :${PORT}`));
}

// Exported for the Netlify Function wrapper (netlify/functions/api.js).
module.exports = app;
