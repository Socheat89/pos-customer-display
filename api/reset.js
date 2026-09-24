/**
 * api/reset.js
 * ------------
 * GET  /api/reset  → Shows a confirmation page in the browser
 * POST /api/reset  → Performs the reset (used by Odoo / app.js)
 *
 * Clears the current POS session in Redis, returning the display
 * to the IDLE / Welcome state.
 */

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const SESSION_KEY = "current_pos_session";

/** Minimal HTML confirmation page returned for GET requests. */
function confirmationPage(message, isSuccess) {
  const color  = isSuccess ? "#00C853" : "#E1251B";
  const icon   = isSuccess ? "✓" : "✗";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>POS Reset — SK Cosmetic</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;
         background:#0D1B2A;font-family:'Segoe UI',sans-serif;color:#fff}
    .card{background:#162235;border:1px solid rgba(255,255,255,.08);border-radius:20px;
          padding:48px 56px;text-align:center;max-width:420px;width:90%;
          box-shadow:0 16px 48px rgba(0,0,0,.4)}
    .icon{width:72px;height:72px;border-radius:50%;background:${color};
          display:flex;align-items:center;justify-content:center;
          font-size:2rem;margin:0 auto 24px;
          box-shadow:0 0 32px ${color}55}
    h1{font-size:1.4rem;font-weight:700;margin-bottom:10px}
    p{color:#adb5bd;font-size:.92rem;line-height:1.6;margin-bottom:28px}
    a{display:inline-block;padding:10px 28px;border-radius:999px;
      background:${color};color:#fff;text-decoration:none;
      font-weight:600;font-size:.88rem}
    a:hover{opacity:.88}
    .sub{margin-top:14px;font-size:.78rem;color:#6c757d}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${isSuccess ? "Display Reset!" : "Reset Failed"}</h1>
    <p>${message}</p>
    <a href="/api/reset">Reset Again</a>
    <p class="sub">This page resets the Customer Display to the Welcome screen.</p>
  </div>
</body>
</html>`;
}

export default async function handler(req, res) {
  // Handle CORS pre-flight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // ── GET: perform reset and return an HTML confirmation page ──
  if (req.method === "GET") {
    try {
      await redis.del(SESSION_KEY);
      console.log("[reset] Session cleared via GET. Display returning to IDLE.");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(
        confirmationPage("The Customer Display has been reset to the Welcome screen successfully.", true)
      );
    } catch (err) {
      console.error("[reset] GET Error:", err);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(500).send(
        confirmationPage("Something went wrong while resetting. Please try again.", false)
      );
    }
  }

  // ── POST: perform reset and return JSON (used by app.js / Odoo) ──
  if (req.method === "POST") {
    try {
      await redis.del(SESSION_KEY);
      console.log("[reset] Session cleared via POST. Display returning to IDLE.");
      return res.status(200).json({
        success: true,
        message: "Session reset. Display is now IDLE.",
      });
    } catch (err) {
      console.error("[reset] POST Error:", err);
      return res.status(500).json({ error: "Internal Server Error" });
    }
  }

  // Any other method
  return res.status(405).json({ error: "Method Not Allowed" });
}
