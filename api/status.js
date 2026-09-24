/**
 * api/status.js
 * -------------
 * GET /api/status?store=<store_id>
 *
 * Returns the current POS session state for a specific store.
 * The frontend customer display polls this endpoint every ~1.1 s.
 *
 * Query Parameters:
 *   ?store=store_a   → reads pos_session_store_a from Redis
 *   (omitted)        → reads pos_session_default
 *
 * Possible responses:
 *   { status: 'IDLE' }
 *   { status: 'PENDING', store_id, reference, amount_total, currency, items, qr_string, ... }
 *   { status: 'SUCCESS', store_id, reference, paid_at, ... }
 */

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

/** Build a namespaced Redis key per store (mirrors order.js). */
function sessionKey(storeId) {
  const safe = String(storeId || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `pos_session_${safe}`;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const storeId = req.query.store || "default";
    const key     = sessionKey(storeId);
    const raw     = await redis.get(key);

    if (!raw) {
      return res.status(200).json({ status: "IDLE", store_id: storeId });
    }

    const session = typeof raw === "string" ? JSON.parse(raw) : raw;

    return res.status(200).json({
      status:       session.status      || "IDLE",
      store_id:     session.store_id    || storeId,
      reference:    session.reference   || null,
      amount_total: session.amount_total ?? null,
      currency:     session.currency    || "USD",
      items:        Array.isArray(session.items) ? session.items : [],
      qr_string:    session.qr_string   || null,
      created_at:   session.created_at  || null,
      paid_at:      session.paid_at     || null,
    });
  } catch (err) {
    console.error("[status] Error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
