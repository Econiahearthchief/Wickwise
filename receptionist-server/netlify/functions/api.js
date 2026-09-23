// Netlify Function wrapper for the LaunchForward receptionist Express app.
//
// NOTE: Render.com is the simpler alternative — it just runs `node server.js`
// (a persistent server), so Twilio webhooks hit it directly with no cold
// starts. Netlify Functions work too, but add cold-start latency and a path
// prefix to every route (see netlify.toml), so prefer Render if it's
// available. Spend: $0 on both free tiers.
const serverless = require("serverless-http");
const app = require("../../server");

module.exports.handler = serverless(app);
