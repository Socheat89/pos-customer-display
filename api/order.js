import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = Redis.fromEnv();

/**
 * Format current date-time as YYYYMMDDHHmmss
 */
function getFormattedReqTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/**
 * Generate HMAC-SHA512 signature hash for ABA PayWay API v2
 * Formula: req_time + merchant_id + tran_id + amount + items_base64 + payment_option
 */
function generatePaywayHash({ req_time, merchant_id, tran_id, amount, items_base64, payment_option, apiKey }) {
  const rawStr = req_time + merchant_id + tran_id + amount + items_base64 + payment_option;
  return crypto.createHmac('sha512', apiKey).update(rawStr).digest('base64');
}

/**
 * Call ABA PayWay Sandbox / Production API to create transaction and fetch KHQR string / deeplink
 */
async function fetchABAPaywayQR({ storeId, reference, amount, currency, items }) {
  const merchantId = process.env.ABA_PAYWAY_MERCHANT_ID;
  const apiKey     = process.env.ABA_PAYWAY_PUBLIC_KEY || process.env.ABA_PAYWAY_API_KEY;
  const apiUrl     = process.env.ABA_PAYWAY_API_URL || 'https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/purchase';

  if (!merchantId || !apiKey) {
    console.warn('[payway] Missing ABA_PAYWAY_MERCHANT_ID or ABA_PAYWAY_PUBLIC_KEY in Environment Variables');
    return null;
  }

  // Format amount to 2 decimal places
  const formattedAmount = Number(amount || 0).toFixed(2);
  const req_time = getFormattedReqTime();
  const tran_id = String(reference || `POS_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);

  // Encode items to Base64 JSON
  const items_base64 = Buffer.from(JSON.stringify(items || [])).toString('base64');
  const payment_option = 'abapay_khqr';

  // Calculate HMAC-SHA512 hash
  const hash = generatePaywayHash({
    req_time,
    merchant_id: merchantId,
    tran_id,
    amount: formattedAmount,
    items_base64,
    payment_option,
    apiKey,
  });

  // Prepare form payload
  const formData = new URLSearchParams();
  formData.append('req_time', req_time);
  formData.append('merchant_id', merchantId);
  formData.append('tran_id', tran_id);
  formData.append('amount', formattedAmount);
  formData.append('items', items_base64);
  formData.append('hash', hash);
  formData.append('firstname', 'SK');
  formData.append('lastname', 'Customer');
  formData.append('phone', '012345678');
  formData.append('email', 'pos@skcosmetic.com');
  formData.append('return_params', storeId);
  formData.append('type', 'purchase');
  formData.append('payment_option', payment_option);
  formData.append('currency', currency || 'USD');

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`[payway] API Response for store=${storeId}:`, data);
      if (data.status?.code === '0' || data.status === '0' || data.status === 'SUCCESS') {
        return data.qrString || data.qrImage || data.abapay_deeplink || data.qr_string || null;
      }
    }
  } catch (err) {
    console.warn(`[payway] Failed to fetch ABA PayWay API, using fallback:`, err.message);
  }
  return null;
}

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

    const reference = payload.reference || payload.name || payload.pos_reference || payload._id || `POS-${Math.floor(1000 + Math.random() * 9000)}`;
    const amountTotal = Number(payload.amount_total !== undefined ? payload.amount_total : (payload.amount !== undefined ? payload.amount : 0));
    const currency = payload.currency || (payload.currency_id === 1 ? 'USD' : (payload.currency_id === 143 ? 'KHR' : 'USD'));
    const items = Array.isArray(payload.items) ? payload.items : (Array.isArray(payload.order_lines) ? payload.order_lines : []);

    // 1. Direct qrString from payload (if Tampermonkey or client already called ABA PayWay)
    let qrString = payload.qrString || payload.qr_string || payload.qrImage || payload.qr_code || payload.qr || null;

    // 2. Otherwise generate dynamic KHQR via ABA PayWay Sandbox / Production API
    if (!qrString && amountTotal > 0) {
      qrString = await fetchABAPaywayQR({
        storeId,
        reference,
        amount: amountTotal,
        currency,
        items,
      });
    }

    // 3. Fallback default KHQR string if ABA PayWay sandbox is unavailable
    if (!qrString) {
      qrString = process.env.DEFAULT_KHQR_STRING || '00020101021238580016A000000770000001010800021600020300052045999530384054040.685802KH5911SK COSMETIC6010Phnom Penh63041234';
    }

    // Standardize session data for Upstash Redis
    const sessionData = {
      status: 'ACTIVE',
      store_id: storeId,
      name: reference,
      reference: reference,
      amount_total: amountTotal,
      currency: currency,
      items: items,
      qr_string: qrString,
      updated_at: Date.now(),
    };

    // Save to Redis key per store
    await redis.set(`pos_session_${storeId}`, JSON.stringify(sessionData));

    console.log(`[order] Saved session for store: ${storeId}, total=${amountTotal}, ref=${reference}`);

    return res.status(200).json({
      success: true,
      store_id: storeId,
      status: 'ACTIVE',
    });
  } catch (err) {
    console.error('[order] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}


