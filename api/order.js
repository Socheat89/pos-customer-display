/**
 * api/order.js
 * -----------
 * POST /api/order
 *
 * Receives the Odoo POS order webhook payload and persists the
 * session state to Upstash Redis with a 1-hour TTL.
 *
 * Expected JSON body:
 * {
 *   "name"         : "Order 00001-001-0001",   // pos_reference (also accepts pos_reference key)
 *   "amount_total" : 12.50,
 *   "currency"     : "USD",
 *   "items"        : [{ "name": "Item A", "qty": 2, "price": 5.00 }],
 *   "qr_string"    : "00020101..."              // optional KHQR string
 * }
 */

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const SESSION_KEY = "current_pos_session";
const SESSION_TTL_SECONDS = 3600; // 1 hour

export default async function handler(req, res) {
  // Handle CORS pre-flight
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const body = req.body;

    // Support both key names coming from Odoo Studio
    const reference = body.name || body.pos_reference;

    if (!reference) {
      return res
        .status(400)
        .json({ error: "Missing required field: name or pos_reference" });
    }

    if (body.amount_total === undefined || body.amount_total === null) {
      return res
        .status(400)
        .json({ error: "Missing required field: amount_total" });
    }

    const sessionData = {
      status: "PENDING",
      reference: String(reference).trim(),
      amount_total: Number(body.amount_total),
      currency: String(body.currency || "USD").toUpperCase(),
      items: Array.isArray(body.items) ? body.items : [],
      qr_string: body.qr_string || null,
      created_at: new Date().toISOString(),
    };

    // Persist to Redis with TTL
    await redis.set(SESSION_KEY, JSON.stringify(sessionData), {
      ex: SESSION_TTL_SECONDS,
    });

    console.log(`[order] Session set → reference=${sessionData.reference}`);

    return res.status(200).json({
      success: true,
      message: "Order received. Awaiting payment.",
      reference: sessionData.reference,
    });
  } catch (err) {
    console.error("[order] Error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
