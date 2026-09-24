/**
 * api/callback.js
 * ---------------
 * POST /api/callback
 *
 * Receives ABA PayWay payment notification.
 * When payment is confirmed (status == '00' or 'SUCCESS'),
 * updates the Redis session status to 'SUCCESS'.
 *
 * ABA PayWay sends form-encoded or JSON POST data.
 * This handler supports both content types.
 *
 * ABA PayWay success indicators:
 *   - Field "status" === "00"       (numeric success code)
 *   - Field "status" === "SUCCESS"  (string variant)
 */

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const SESSION_KEY = "current_pos_session";

/** Normalise status values from ABA PayWay to a boolean. */
function isPaymentSuccessful(status) {
  if (!status) return false;
  const s = String(status).trim().toUpperCase();
  return s === "00" || s === "SUCCESS";
}

export default async function handler(req, res) {
  // Handle CORS pre-flight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // ABA PayWay may send application/x-www-form-urlencoded or application/json
    const body = req.body;

    // Extract status — ABA PayWay uses "status" field
    const paymentStatus = body?.status ?? body?.tran_status ?? null;

    if (!isPaymentSuccessful(paymentStatus)) {
      // Non-success or unknown status — acknowledge receipt but do not update state
      console.warn(
        `[callback] Non-success payment status received: "${paymentStatus}"`
      );
      return res.status(200).json({
        success: false,
        message: "Payment not confirmed. State unchanged.",
        received_status: paymentStatus,
      });
    }

    // Fetch the current session from Redis
    const raw = await redis.get(SESSION_KEY);

    if (!raw) {
      // No active session — still return 200 so ABA PayWay does not retry
      console.warn("[callback] SUCCESS callback received but no active session found.");
      return res.status(200).json({
        success: false,
        message: "No active session to update.",
      });
    }

    const session =
      typeof raw === "string" ? JSON.parse(raw) : raw;

    // Update status and preserve TTL by re-setting with remaining time
    // (Simpler: reset with another full hour — payment just completed)
    const updatedSession = {
      ...session,
      status: "SUCCESS",
      paid_at: new Date().toISOString(),
    };

    await redis.set(SESSION_KEY, JSON.stringify(updatedSession), {
      ex: 300, // Keep SUCCESS state for 5 minutes max, then TTL cleans up
    });

    console.log(
      `[callback] Payment SUCCESS recorded → reference=${session.reference}`
    );

    return res.status(200).json({
      success: true,
      message: "Payment confirmed. Session updated to SUCCESS.",
    });
  } catch (err) {
    console.error("[callback] Error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
