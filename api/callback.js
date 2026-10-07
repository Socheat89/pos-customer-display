/**
 * api/callback.js
 * ---------------
 * Receives payment confirmations from ABA PayWay or test calls.
 * Supports BOTH GET and POST requests.
 *
 * Examples:
 *   POST /api/callback?store=pos_18  { "status": 0, "tran_id": "..." }
 *   GET  /api/callback?store=pos_18&status=00
 *   GET  /api/callback?store=pos_18&status=SUCCESS
 */

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

/** Normalise any status value from ABA PayWay or test call to a boolean. */
function isPaymentSuccessful(status) {
  if (status === undefined || status === null) return false;
  const s = String(status).trim().toUpperCase();
  return (
    s === "0" ||
    s === "00" ||
    s === "SUCCESS" ||
    s === "APPROVED" ||
    s === "PAID" ||
    s === "OK" ||
    s === "TRUE" ||
    s === "1"
  );
}

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed. Use GET or POST." });
  }

  try {
    // Parse body safely
    let body = {};
    if (typeof req.body === "object" && req.body !== null) {
      body = req.body;
    } else if (typeof req.body === "string" && req.body.length > 0) {
      try {
        body = JSON.parse(req.body);
      } catch (_) {
        try {
          body = Object.fromEntries(new URLSearchParams(req.body));
        } catch (_) {}
      }
    }

    const query = req.query || {};

    // Extract transaction identifiers
    const tranId    = query.tran_id || body.tran_id || query.tranId || body.tranId || null;
    const reference = query.reference || body.reference || query.ref || body.ref || null;

    // Resolve storeId
    let storeId = query.store || query.store_id || body.store_id || body.store || body.pos_id || null;

    // Lookup storeId by tranId in Redis if not directly provided
    if (!storeId && tranId) {
      try {
        const mapped = await redis.get(`payway_tran_${tranId}`);
        if (mapped) storeId = String(mapped);
      } catch (_) {}
    }

    // Lookup storeId by reference in Redis if still missing
    if (!storeId && reference) {
      try {
        const mapped = await redis.get(`payway_ref_${reference}`);
        if (mapped) storeId = String(mapped);
      } catch (_) {}
    }

    // If still missing, check if any active/pending session exists in Redis
    if (!storeId) {
      try {
        const keys = await redis.keys("pos_session_*");
        for (const k of keys || []) {
          if (k === "pos_session_pos_default") continue;
          const val = await redis.get(k);
          if (val) {
            const parsed = typeof val === "string" ? JSON.parse(val) : val;
            if (parsed && (parsed.status === "ACTIVE" || parsed.status === "PENDING")) {
              storeId = k.replace("pos_session_", "");
              break;
            }
          }
        }
      } catch (_) {}
    }

    if (!storeId) {
      storeId = "pos_default";
    }

    // Extract payment status
    const rawStatus =
      query.status ??
      body.status ??
      query.tran_status ??
      body.tran_status ??
      query.code ??
      body.code ??
      query.payment_status ??
      body.payment_status ??
      null;

    // Check if status is a success or if user explicitly requested a test confirmation
    const isSuccess =
      isPaymentSuccessful(rawStatus) ||
      query.set_success === "true" ||
      query.test === "true" ||
      query.force === "true";

    // If no status provided at all and no test flag on a GET request without query, return info
    if (rawStatus === null && !isSuccess && req.method === "GET" && !query.store) {
      return res.status(200).json({
        success: true,
        message: "ABA PayWay Callback endpoint is online. Call with ?store=<id>&status=00 to confirm payment.",
        supported_methods: ["GET", "POST"]
      });
    }

    if (!isSuccess) {
      console.warn(`[callback] Non-success status "${rawStatus}" for store=${storeId}`);
      return res.status(200).json({
        success: false,
        message: "Payment status is not confirmed. Session unchanged.",
        received_status: rawStatus,
        store_id: storeId,
      });
    }

    // Update Redis session
    const key = `pos_session_${storeId}`;
    const raw = await redis.get(key);

    let session = {};
    if (raw) {
      session = typeof raw === "string" ? JSON.parse(raw) : raw;
    }

    const updatedSession = {
      ...session,
      status: "SUCCESS",
      paid_at: new Date().toISOString(),
      updated_at: Date.now(),
      paid_tran_id: tranId || session.tran_id || null,
    };

    // Save to Redis key per store (TTL 300s)
    await redis.set(key, JSON.stringify(updatedSession), { ex: 300 });

    // Also mirror to pos_default
    if (storeId !== "pos_default") {
      await redis.set("pos_session_pos_default", JSON.stringify(updatedSession), { ex: 300 });
    }

    console.log(`[callback] Payment SUCCESS confirmed! store=${storeId}, ref=${session.reference || tranId}`);

    return res.status(200).json({
      success: true,
      status: "SUCCESS",
      message: "Payment confirmed. Customer display updated to SUCCESS.",
      store_id: storeId,
      reference: session.reference || tranId,
    });
  } catch (err) {
    console.error("[callback] Error:", err);
    return res.status(500).json({ error: "Internal Server Error", message: err.message });
  }
}
