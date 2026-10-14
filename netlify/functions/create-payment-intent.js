// netlify/functions/create-payment-intent.js
//
// Backend for the WickWise Candles shop multi-step checkout
// (wickwise-candles-shop.netlify.app/checkout.html).
//
// Creates a Stripe PaymentIntent with automatic payment methods enabled,
// so the buyer gets cards, Apple Pay, Google Pay, Cash App Pay, and Link
// without per-method integration.
//
// SECURITY: the server-side price list below is authoritative. Client-sent
// prices are never trusted — unknown item ids or quantities are rejected.

const Stripe = require("stripe");

const PRICES = {
  flagship1: 1499, // Flagship Nº 1 — First Batch (cents)
  // wicktool: 499, // Wood-wick centering tool — enable when it launches
};
const SHIPPING_FLAT = 595; // cents — buyer pays shipping, flat rate

const ALLOWED_ORIGINS = [
  "https://wickwise-candles-shop.netlify.app",
  "http://localhost:8000",
];

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";
  const cors = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const headers = {
    "Access-Control-Allow-Origin": cors,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let items, email, shipping;
  try {
    ({ items, email, shipping } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  if (!Array.isArray(items) || items.length === 0)
    return { statusCode: 400, headers, body: JSON.stringify({ error: "No items" }) };

  let amount = 0;
  const lineItems = [];
  for (const it of items) {
    const price = PRICES[it.id];
    const qty = Math.floor(Number(it.qty));
    if (!price || !(qty > 0) || qty > 99)
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid item" }) };
    amount += price * qty;
    lineItems.push(`${qty}x ${it.id}`);
  }
  amount += SHIPPING_FLAT;

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  try {
    const pi = await stripe.paymentIntents.create({
      amount,
      currency: "usd",
      receipt_email: typeof email === "string" && email.includes("@") ? email : undefined,
      automatic_payment_methods: { enabled: true, allow_redirects: "always" },
      metadata: {
        source: "wickwise-candles-shop",
        items: lineItems.join(", "),
        ship_to: typeof shipping === "object" && shipping ? JSON.stringify(shipping).slice(0, 400) : "",
      },
    });
    return { statusCode: 200, headers, body: JSON.stringify({ clientSecret: pi.client_secret }) };
  } catch (e) {
    console.error("PaymentIntent failed:", e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Payment setup failed" }) };
  }
};
