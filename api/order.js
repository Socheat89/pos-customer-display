/**
 * api/order.js
 * -----------
 * POST /api/order?store=<store_id>
 *
 * Accepts BOTH payload formats:
 *
 * ── Format A: Odoo Studio native webhook (Send Webhook Notification) ──
 * {
 *   "pos_reference" : "2648-18-000001",
 *   "amount_total"  : 2.18,
 *   "currency_id"   : 1,               ← integer ID
 *   "lines"         : [238583, 238584], ← IDs only (no detail)
 *   "order_lines"   : [{name, qty, price_unit, ...}]  ← if added via Execute Code
 * }
 * Pass store via URL: POST /api/order?store=pos_48002
 *
 * ── Format B: Custom full-detail payload ──
 * {
 *   "store_id"     : "pos_48002",
 *   "name"         : "POS-722",
 *   "amount_total" : 9.99,
 *   "currency"     : "USD",
 *   "items"        : [{name, qty, price, uom}],
 *   "qr_string"    : "00020101..."
 * }
 */

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const SESSION_TTL_SECONDS = 3600; // 1 hour

/** Build a namespaced Redis key per store. */
function sessionKey(storeId) {
  const safe = String(storeId || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return `pos_session_${safe}`;
}

/**
 * Map Odoo currency_id (integer) to ISO currency string.
 * Common Odoo default IDs — extend as needed.
 */
function resolveCurrency(body) {
  if (body.currency && typeof body.currency === "string") {
    return body.currency.toUpperCase();
  }
  // Odoo sends currency_id as integer — map common ones
  const currencyMap = {
    1:   "USD",
    2:   "EUR",
    3:   "KHR",
    4:   "THB",
    143: "KHR", // Odoo KH instance default
  };
  if (body.currency_id && currencyMap[body.currency_id]) {
    return currencyMap[body.currency_id];
  }
  return "USD"; // safe default
}

/**
 * Normalise items from either format:
 *  - Format A: body.lines = [id, id, ...]  → show empty (IDs cannot be resolved)
 *  - Format A+: body.order_lines = [{product_id, qty, price_unit, ...}]
 *  - Format B: body.items = [{name, qty, price, uom}]
 */
function resolveItems(body) {
  // Best: full item objects from Format B
  if (Array.isArray(body.items) && body.items.length > 0 && typeof body.items[0] === "object") {
    return body.items;
  }

  // Good: Odoo order_lines with detail (via Execute Code or custom mapping)
  if (Array.isArray(body.order_lines) && body.order_lines.length > 0 && typeof body.order_lines[0] === "object") {
    return body.order_lines.map((l) => ({
      name:  l.product_id?.[1] || l.full_product_name || l.name || "Item",
      qty:   Number(l.qty || l.product_uom_qty || 1),
      price: Number(l.price_unit || l.price || 0),
      uom:   l.product_uom_id?.[1] || l.uom || "",
    }));
  }

  // Fallback: Odoo sends only IDs in lines[] → cannot resolve without Odoo API
  // Return empty array — display will show "No items" placeholder
  return [];
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const body = req.body;

    // ── Auth (optional — skip if WEBHOOK_SECRET not set) ────────
    const secret = process.env.WEBHOOK_SECRET;
    if (secret) {
      const auth = req.headers["authorization"] || "";
      if (auth !== `Bearer ${secret}`) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    // ── Reference — support both field names ─────────────────────
    const reference = body.name || body.pos_reference || body._id;
    if (!reference) {
      return res.status(400).json({ error: "Missing field: name or pos_reference" });
    }

    if (body.amount_total === undefined || body.amount_total === null) {
      return res.status(400).json({ error: "Missing field: amount_total" });
    }

    // ── Store ID — prefer URL query param so Odoo URL controls it ─
    // Example Odoo URL: https://pos-customer-display.vercel.app/api/order?store=pos_48002
    const storeId = req.query.store || body.store_id || body.pos_id || "default";
    const key     = sessionKey(storeId);

    const sessionData = {
      status:       "PENDING",
      store_id:     storeId,
      reference:    String(reference).trim(),
      amount_total: Number(body.amount_total),
      currency:     resolveCurrency(body),
      items:        resolveItems(body),
      qr_string:    body.qr_string || null,
      created_at:   new Date().toISOString(),
    };

    await redis.set(key, JSON.stringify(sessionData), { ex: SESSION_TTL_SECONDS });

    console.log(`[order] ✓ store=${storeId} ref=${sessionData.reference} total=${sessionData.amount_total} items=${sessionData.items.length}`);

    return res.status(200).json({
      success:   true,
      message:   "Order received. Awaiting payment.",
      store_id:  storeId,
      reference: sessionData.reference,
      items_count: sessionData.items.length,
    });
  } catch (err) {
    console.error("[order] Error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
