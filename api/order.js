/**
 * api/order.js
 * -----------
 * POST /api/order
 *
 * Receives the Odoo POS order webhook payload and persists the
 * session state to Upstash Redis with a 1-hour TTL.
 *
 * Multi-Session Support:
 *   Each store uses its own Redis key: pos_session_<store_id>
 *   Include "store_id" (or "pos_id") in the payload from Odoo.
 *
 * Expected JSON body:
 * {
 *   "store_id"     : "store_a",              // required for multi-store
 *   "name"         : "Order 00001-001-0001", // pos_reference
 *   "amount_total" : 12.50,
 *   "currency"     : "USD",
 *   "items"        : [{ "name": "Item A", "qty": 2, "price": 5.00, "uom": "កញ្ជប់" }],
 *   "qr_string"    : "00020101..."           // optional KHQR string
 * }
 */

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const SESSION_TTL_SECONDS = 3600; // 1 hour

/** Build a namespaced Redis key per store. */
function sessionKey(storeId) {
  // Sanitise: only allow alphanumeric, dash, underscore
  const safe = String(storeId || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `pos_session_${safe}`;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const body = req.body;

    // Optional webhook secret validation
    const secret = process.env.WEBHOOK_SECRET;
    if (secret) {
      const auth = req.headers["authorization"] || "";
      if (auth !== `Bearer ${secret}`) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    // Support both key names coming from Odoo Studio
    const reference = body.name || body.pos_reference;
    if (!reference) {
      return res.status(400).json({ error: "Missing required field: name or pos_reference" });
    }
    if (body.amount_total === undefined || body.amount_total === null) {
      return res.status(400).json({ error: "Missing required field: amount_total" });
    }

    // Resolve store identity — support multiple field names
    const storeId = body.store_id || body.pos_id || body.shop_id || "default";
    const key     = sessionKey(storeId);

    const sessionData = {
      status:       "PENDING",
      store_id:     storeId,
      reference:    String(reference).trim(),
      amount_total: Number(body.amount_total),
      currency:     String(body.currency || "USD").toUpperCase(),
      items:        Array.isArray(body.items) ? body.items : [],
      qr_string:    body.qr_string || null,
      created_at:   new Date().toISOString(),
    };

    await redis.set(key, JSON.stringify(sessionData), { ex: SESSION_TTL_SECONDS });

    console.log(`[order] Session set → key=${key}, reference=${sessionData.reference}`);

    return res.status(200).json({
      success:   true,
      message:   "Order received. Awaiting payment.",
      store_id:  storeId,
      reference: sessionData.reference,
    });
  } catch (err) {
    console.error("[order] Error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
