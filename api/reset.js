/**
 * api/reset.js
 * ------------
 * GET  /api/reset?store=<store_id>  → HTML confirmation page (browser-friendly)
 * POST /api/reset?store=<store_id>  → JSON response (used by app.js / Odoo)
 *
 * Clears only the specified store's session in Redis.
 * Omit ?store= to reset the "default" store.
 */

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

/** Build a namespaced Redis key per store (mirrors order.js). */
function sessionKey(storeId) {
  const safe = String(storeId || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `pos_session_${safe}`;
}

/** Minimal HTML confirmation page returned for GET requests. */
function confirmationPage(storeId, message, isSuccess) {
  const color = isSuccess ? "#00C853" : "#E1251B";
  const icon  = isSuccess ? "✓" : "✗";
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
          padding:48px 56px;text-align:center;max-width:440px;width:90%;
          box-shadow:0 16px 48px rgba(0,0,0,.4)}
    .icon{width:72px;height:72px;border-radius:50%;background:${color};
          display:flex;align-items:center;justify-content:center;
          font-size:2rem;margin:0 auto 24px;
          box-shadow:0 0 32px ${color}55}
    h1{font-size:1.4rem;font-weight:700;margin-bottom:10px}
    p{color:#adb5bd;font-size:.92rem;line-height:1.6;margin-bottom:28px}
    .store-chip{display:inline-block;padding:4px 14px;border-radius:999px;
                background:rgba(79,195,247,.12);border:1px solid rgba(79,195,247,.3);
                color:#4FC3F7;font-size:.78rem;font-weight:600;margin-bottom:20px}
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
    <div class="store-chip">Store: ${storeId}</div>
    <h1>${isSuccess ? "Display Reset!" : "Reset Failed"}</h1>
    <p>${message}</p>
    <a href="/api/reset?store=${storeId}">Reset Again</a>
    <p class="sub">Only the display for store <strong>${storeId}</strong> was reset.</p>
  </div>
</body>
</html>`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  // Resolve store from query param (GET or POST)
  const queryStore = req.query.store;
  const bodyStore  = req.body?.store_id;
  const storeId    = queryStore || bodyStore;

  try {
    if (!storeId || storeId === "all" || storeId === "pos_default") {
      // Clear all POS sessions so reset clears any stuck sessions across all stores
      try {
        const keys = await redis.keys("pos_session_*");
        if (Array.isArray(keys) && keys.length > 0) {
          await Promise.all(keys.map((k) => redis.del(k)));
        }
      } catch (e) {
        console.warn("[reset] keys scan error:", e.message);
      }
      await redis.del("pos_session_pos_default");
      console.log(`[reset] Cleared ALL pos_session_* keys`);
    } else {
      const key = sessionKey(storeId);
      await redis.del(key);
      console.log(`[reset] Cleared store=${storeId} (key=${key})`);
    }

    if (req.method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(
        confirmationPage(storeId || "All Stores", "The Customer Display has been reset to the Welcome screen successfully.", true)
      );
    }

    return res.status(200).json({
      success:  true,
      message:  "Session reset. Display is now IDLE.",
      store_id: storeId || "all",
    });
  } catch (err) {
    console.error("[reset] Error:", err);
    if (req.method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(500).send(
        confirmationPage(storeId || "default", "Something went wrong while resetting. Please try again.", false)
      );
    }
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
