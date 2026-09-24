/**
 * api/status.js
 * -------------
 * GET /api/status
 *
 * Returns the current POS session state from Upstash Redis.
 * The frontend customer display polls this endpoint every ~1 second.
 *
 * Possible responses:
 *   { status: 'IDLE' }                            — no active order
 *   { status: 'PENDING', reference, amount_total, currency, items, qr_string, ... }
 *   { status: 'SUCCESS', reference, paid_at, ... }
 */

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const SESSION_KEY = "current_pos_session";

export default async function handler(req, res) {
  // Handle CORS pre-flight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const raw = await redis.get(SESSION_KEY);

    if (!raw) {
      return res.status(200).json({ status: "IDLE" });
    }

    const session =
      typeof raw === "string" ? JSON.parse(raw) : raw;

    // Ensure we always expose a clean, predictable shape
    return res.status(200).json({
      status: session.status || "IDLE",
      reference: session.reference || null,
      amount_total: session.amount_total ?? null,
      currency: session.currency || "USD",
      items: Array.isArray(session.items) ? session.items : [],
      qr_string: session.qr_string || null,
      created_at: session.created_at || null,
      paid_at: session.paid_at || null,
    });
  } catch (err) {
    console.error("[status] Error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
