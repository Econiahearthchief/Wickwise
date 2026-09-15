// netlify/functions/create-checkout-session.js
//
// Replaces the static Stripe Payment Links with a dynamically created
// Checkout Session so we can attach the seller's name + shop URL as
// metadata. That metadata is what lets the webhook auto-write the
// verified_sellers Firestore doc with no manual admin.html step.
//
// DESIGN NOTE: the original flow was two separate Payment Links chained
// together ($0.99 one-time -> redirect -> $2.99/mo recurring). Stripe
// Checkout supports mixing one one-time price and one recurring price in
// a SINGLE `mode: "subscription"` session, so this combines both charges
// into one checkout instead of two. Same total cost to the seller, one
// less redirect/step for them, and it's more reliable for the webhook
// (one event to listen for instead of stitching two sessions together).
// If you'd rather keep the original two-step chain, say so and this can
// be split back into two functions.

const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// TODO: replace with your real Stripe Price IDs (Dashboard -> Product ->
// pricing -> the price's ID, starts with "price_"). These are NOT the
// same as the old Payment Link URLs.
const PRICE_VERIFICATION_ONE_TIME = process.env.STRIPE_PRICE_VERIFICATION; // $0.99 one-time
const PRICE_SELLER_RECURRING = process.env.STRIPE_PRICE_SELLER_MONTHLY;   // $2.99/mo recurring

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  let name, shopUrl;
  try {
    ({ name, shopUrl } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  name = (name || "").trim();
  shopUrl = (shopUrl || "").trim();

  if (!name || !shopUrl) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Both name and shopUrl are required." }),
    };
  }

  // Basic sanity check on the URL so we don't store garbage.
  try {
    const parsed = new URL(shopUrl);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("bad protocol");
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "shopUrl must be a valid http(s) URL." }),
    };
  }

  if (!PRICE_VERIFICATION_ONE_TIME || !PRICE_SELLER_RECURRING) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Server misconfigured: missing Stripe price ID env vars.",
      }),
    };
  }

  const siteUrl = process.env.URL || "https://wickwise.shop";

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        { price: PRICE_VERIFICATION_ONE_TIME, quantity: 1 },
        { price: PRICE_SELLER_RECURRING, quantity: 1 },
      ],
      metadata: { name, shopUrl },
      // Copied onto the Subscription object too, so later events like
      // subscription.deleted still carry this without a second lookup.
      subscription_data: {
        metadata: { name, shopUrl },
      },
      success_url: `${siteUrl}/gallery.html?verified=1`,
      cancel_url: `${siteUrl}/gallery.html?verified=cancelled`,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error("Stripe checkout session error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Could not start checkout. Try again." }),
    };
  }
};
