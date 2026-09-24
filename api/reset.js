/**
 * api/reset.js
 * ------------
 * POST /api/reset
 *
 * Clears the current POS session in Redis, returning the display
 * to the IDLE / Welcome state. Call this from the POS backend or
 * manually when needed.
 */

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const SESSION_KEY = "current_pos_session";

export default async function handler(req, res) {
  // Handle CORS pre-flight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    await redis.del(SESSION_KEY);

    console.log("[reset] Session cleared. Display returning to IDLE.");

    return res.status(200).json({
      success: true,
      message: "Session reset. Display is now IDLE.",
    });
  } catch (err) {
    console.error("[reset] Error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
