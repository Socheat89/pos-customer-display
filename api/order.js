import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    // Resolve store_id from Query param, Body store_id, or Odoo config_id
    let storeId = req.query.store || payload.store_id;
    if (!storeId && payload.config_id) {
      const cfgId = Array.isArray(payload.config_id) ? payload.config_id[0] : payload.config_id;
      storeId = `pos_${cfgId}`;
    }
    if (!storeId) {
      storeId = 'pos_default';
    }

    // Default KHQR string if none supplied in payload
    const defaultQR = process.env.DEFAULT_KHQR_STRING || '00020101021238580016A000000770000001010800021600020300052045999530384054040.685802KH5911SK COSMETIC6010Phnom Penh63041234';

    // Standardize session data
    const sessionData = {
      status: payload.status || 'ACTIVE',
      store_id: storeId,
      reference: payload.reference || payload.name || payload.pos_reference || payload._id || 'Order',
      amount_total: Number(payload.amount_total !== undefined ? payload.amount_total : (payload.amount !== undefined ? payload.amount : 0)),
      currency: payload.currency || (payload.currency_id === 1 ? 'USD' : (payload.currency_id === 143 ? 'KHR' : 'USD')),
      items: Array.isArray(payload.items) ? payload.items : (Array.isArray(payload.order_lines) ? payload.order_lines : []),
      qr_string: payload.qrString || payload.qr_string || payload.qrImage || payload.qr_code || payload.qr || defaultQR,
      ...payload,
      updated_at: Date.now()
    };

    // Save to Redis key per store
    await redis.set(`pos_session_${storeId}`, JSON.stringify(sessionData));

    console.log(`[order] Saved session for store: ${storeId}`);

    return res.status(200).json({ success: true, store_id: storeId, status: sessionData.status });
  } catch (err) {
    console.error('[order] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}

