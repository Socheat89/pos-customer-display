/**
 * api/callback.js
 * ---------------
 * POST /api/callback?store=<store_id>
 *
 * Receives ABA PayWay payment notification.
 * When payment is confirmed (status == '00' or 'SUCCESS'),
 * updates the Redis session status for the specific store to 'SUCCESS'.
 *
 * Configure ABA PayWay IPN URL as:
 *   https://your-app.vercel.app/api/callback?store=store_a
 *
 * ABA PayWay success indicators:
 *   - Field "status" === "00"       (numeric success code)
 *   - Field "status" === "SUCCESS"  (string variant)
 */

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

/** Build a namespaced Redis key per store (mirrors order.js). */
function sessionKey(storeId) {
  const safe = String(storeId || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `pos_session_${safe}`;
}

/** Normalise status values from ABA PayWay to a boolean. */
function isPaymentSuccessful(status) {
  if (!status) return false;
  const s = String(status).trim().toUpperCase();
  return s === "00" || s === "SUCCESS";
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const body = req.body;

    // Resolve store — prefer query param, fallback to body field
    const storeId = req.query.store || body?.store_id || body?.pos_id || "default";
    const key     = sessionKey(storeId);

    // Extract payment status from ABA PayWay
    const paymentStatus = body?.status ?? body?.tran_status ?? null;

    if (!isPaymentSuccessful(paymentStatus)) {
      console.warn(`[callback] Non-success status "${paymentStatus}" for store=${storeId}`);
      return res.status(200).json({
        success:          false,
        message:          "Payment not confirmed. State unchanged.",
        received_status:  paymentStatus,
        store_id:         storeId,
      });
    }

    // Fetch the current session for this store
    const raw = await redis.get(key);

    if (!raw) {
      console.warn(`[callback] SUCCESS received but no active session for store=${storeId}`);
      return res.status(200).json({
        success:  false,
        message:  "No active session to update.",
        store_id: storeId,
      });
    }

    const session = typeof raw === "string" ? JSON.parse(raw) : raw;

    const updatedSession = {
      ...session,
      status:   "SUCCESS",
      paid_at:  new Date().toISOString(),
    };

    // Keep SUCCESS visible for 5 minutes, then TTL auto-cleans
    await redis.set(key, JSON.stringify(updatedSession), { ex: 300 });

    console.log(`[callback] Payment SUCCESS → store=${storeId}, reference=${session.reference}`);

    return res.status(200).json({
      success:  true,
      message:  "Payment confirmed. Session updated to SUCCESS.",
      store_id: storeId,
    });
  } catch (err) {
    console.error("[callback] Error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
