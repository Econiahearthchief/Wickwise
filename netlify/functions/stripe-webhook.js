// netlify/functions/stripe-webhook.js
//
// Listens for Stripe events and keeps the `verified_sellers` Firestore
// collection in sync automatically — no manual admin.html entry needed.
//
//   checkout.session.completed   -> add seller (badge live)
//   customer.subscription.deleted -> remove seller (cancelled)
//   invoice.payment_failed        -> remove seller (card/renewal failed)
//
// The Firestore doc ID is the Stripe subscription ID. That's deterministic
// and means we don't need to carry name/shopUrl metadata through every
// later event — we just look up the doc by subscription ID and delete it.

const Stripe = require("stripe");
const admin = require("firebase-admin");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

if (!admin.apps.length) {
  // FIREBASE_SERVICE_ACCOUNT_KEY = the full JSON key from Firebase Console
  // -> Project Settings -> Service Accounts -> Generate new private key,
  // stored as ONE-LINE JSON in a Netlify env var.
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const sig = event.headers["stripe-signature"];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SIGNING_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  try {
    switch (stripeEvent.type) {
      case "checkout.session.completed": {
        const session = stripeEvent.data.object;

        // Only handle subscription-mode sessions (our verified-seller flow).
        if (session.mode !== "subscription" || !session.subscription) break;

        const name = session.metadata?.name;
        const shopUrl = session.metadata?.shopUrl;
        if (!name || !shopUrl) {
          console.warn("checkout.session.completed missing name/shopUrl metadata", session.id);
          break;
        }

        await db.collection("verified_sellers").doc(session.subscription).set({
          name,
          shopUrl,
          status: "active",
          stripeCustomerId: session.customer || null,
          stripeSubscriptionId: session.subscription,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = stripeEvent.data.object;
        await db.collection("verified_sellers").doc(subscription.id).delete();
        break;
      }

      case "invoice.payment_failed": {
        const invoice = stripeEvent.data.object;
        const subscriptionId = invoice.subscription;
        if (subscriptionId) {
          await db.collection("verified_sellers").doc(subscriptionId).delete();
        }
        break;
      }

      default:
        // Ignore everything else.
        break;
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error("Webhook handler error:", err);
    // Return 500 so Stripe retries.
    return { statusCode: 500, body: "Webhook handler failed" };
  }
};
