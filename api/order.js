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
 * Generate HMAC-SHA512 signature hash for ABA PayWay QR API (generate-qr endpoint)
 * Official hash string order:
 * req_time + merchant_id + tran_id + amount + items + first_name + last_name + email + phone + purchase_type + payment_option + callback_url + return_deeplink + currency + custom_fields + return_params + payout + lifetime + qr_image_template
 */
function generatePaywayQRHash(params, apiKey) {
  const parts = [
    params.req_time || '',
    params.merchant_id || '',
    params.tran_id || '',
    params.amount !== undefined && params.amount !== null ? String(params.amount) : '',
    params.items || '',
    params.first_name || '',
    params.last_name || '',
    params.email || '',
    params.phone || '',
    params.purchase_type || '',
    params.payment_option || '',
    params.callback_url || '',
    params.return_deeplink || '',
    params.currency || '',
    params.custom_fields || '',
    params.return_params || '',
    params.payout || '',
    params.lifetime !== undefined && params.lifetime !== null ? String(params.lifetime) : '',
    params.qr_image_template || '',
  ];
  const rawStr = parts.join('');
  return crypto.createHmac('sha512', apiKey).update(rawStr).digest('base64');
}

/**
 * Call ABA PayWay Sandbox / Production QR API to create transaction and fetch template3_color QR
 */
async function fetchABAPaywayQR({ storeId, reference, amount, currency, items }) {
  const merchantId = process.env.ABA_PAYWAY_MERCHANT_ID;
  const apiKey     = process.env.ABA_PAYWAY_PUBLIC_KEY || process.env.ABA_PAYWAY_API_KEY;
  const apiUrl     = process.env.ABA_PAYWAY_API_URL || 'https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/generate-qr';

  if (!merchantId || !apiKey) {
    console.warn('[payway] Missing ABA_PAYWAY_MERCHANT_ID or ABA_PAYWAY_PUBLIC_KEY in Environment Variables');
    return null;
  }

  // Format amount to 2 decimal places
  const formattedAmount = Number(amount || 0).toFixed(2);
  const req_time = getFormattedReqTime();
  const tran_id = String(reference || `POS_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20);

  // Format items array for ABA PayWay spec ({name, quantity, price})
  const paywayItems = (items || []).map(i => ({
    name: String(i.name || 'Item').replace(/^\d+\s*[\r\n]+/, '').trim(),
    quantity: Number(i.qty || i.quantity || 1),
    price: Number(i.price || 0)
  }));

  // Encode items to Base64 JSON
  const items_base64 = Buffer.from(JSON.stringify(paywayItems)).toString('base64');
  const payment_option = 'abapay_khqr';

  // Host callback URL
  const callbackUrl = process.env.VERCEL_URL
    ? Buffer.from(`https://${process.env.VERCEL_URL}/api/callback?store=${storeId}`).toString('base64')
    : Buffer.from(`https://pos-customer-display.vercel.app/api/callback?store=${storeId}`).toString('base64');

  const reqPayload = {
    req_time,
    merchant_id: merchantId,
    tran_id,
    first_name: 'SK',
    last_name: 'Store',
    email: 'cheatgaming1111@gmail.com',
    phone: '012345678',
    amount: formattedAmount,
    purchase_type: 'purchase',
    payment_option,
    items: items_base64,
    currency: currency || 'USD',
    callback_url: callbackUrl,
    return_deeplink: null,
    custom_fields: null,
    return_params: storeId,
    payout: null,
    lifetime: 10,
    qr_image_template: 'template3_color',
  };

  // Calculate HMAC-SHA512 hash using official concatenation formula
  const hash = generatePaywayQRHash(reqPayload, apiKey);
  reqPayload.hash = hash;
  reqPayload.amount = Number(formattedAmount); // send numeric in JSON payload

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(reqPayload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      console.log(`[payway] API Response for store=${storeId}:`, data);
      if (data.status?.code === '0' || data.status === '0' || data.status === 'SUCCESS' || data.status?.code === 0) {
        return {
          qrString: data.qrString || data.qr_string || null,
          qrImage: data.qrImage || data.qr_image || null,
          abapay_deeplink: data.abapay_deeplink || null,
        };
      }
    }
  } catch (err) {
    console.warn(`[payway] Failed to fetch ABA PayWay API:`, err.message);
  }
  return null;
}

/**
 * Calculate CRC16-CCITT (0x1021, init 0xFFFF) for EMVCo Bakong KHQR strings.
 */
function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    crc ^= c << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Generate a 100% NBC Bakong EMVCo compliant KHQR String with valid CRC16 Checksum.
 */
function generateEMVCoKHQR({ merchantName = "SK COSMETIC", city = "Phnom Penh", amount = 0, currency = "USD" }) {
  const isUSD = String(currency).toUpperCase() === "USD";
  const currencyCode = isUSD ? "840" : "116";
  const formattedAmount = Number(amount || 0).toFixed(2);

  // ABA Bank Merchant Tag 38
  const merchantTag = process.env.ABA_KHQR_MERCHANT_TAG || "38580016A00000077000000101080002160002030005";

  let raw = "000201" +
            "010212" +
            merchantTag +
            "52045999" +
            `5303${currencyCode}`;

  if (amount > 0) {
    raw += `54${String(formattedAmount.length).padStart(2, '0')}${formattedAmount}`;
  }

  raw += "5802KH" +
         `59${String(merchantName.length).padStart(2, '0')}${merchantName}` +
         `60${String(city.length).padStart(2, '0')}${city}` +
         "6304";

  const checksum = crc16(raw);
  return raw + checksum;
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

    // 1. Direct qrString / qrImage from payload
    let qrString = payload.qrString || payload.qr_string || payload.qr_code || payload.qr || null;
    let qrImage  = payload.qrImage || payload.qr_image || null;
    let deeplink = payload.abapay_deeplink || null;

    // Fast cache check: if this order already has a generated qr_string with same amount, reuse it instantly!
    if (!qrString && !qrImage && amountTotal > 0) {
      try {
        const prevRaw = await redis.get(`pos_session_${storeId}`);
        if (prevRaw) {
          const prev = typeof prevRaw === 'string' ? JSON.parse(prevRaw) : prevRaw;
          if (prev && prev.reference === reference && Number(prev.amount_total) === amountTotal && (prev.qr_string || prev.qr_image)) {
            qrString = prev.qr_string;
            qrImage  = prev.qr_image;
            deeplink = prev.abapay_deeplink;
          }
        }
      } catch (_) {}
    }

    // 2. Otherwise generate dynamic KHQR via ABA PayWay Sandbox / Production API (2s max timeout)
    if (!qrString && !qrImage && amountTotal > 0) {
      const paywayRes = await fetchABAPaywayQR({
        storeId,
        reference,
        amount: amountTotal,
        currency,
        items,
      });
      if (paywayRes) {
        qrString = paywayRes.qrString;
        qrImage  = paywayRes.qrImage;
        deeplink = paywayRes.abapay_deeplink;
      }
    }

    // 3. Dynamic EMVCo KHQR string with valid CRC16 Checksum for the exact amount
    if (!qrString && !qrImage && amountTotal > 0) {
      qrString = generateEMVCoKHQR({
        merchantName: 'SK STORE',
        city: 'Phnom Penh',
        amount: amountTotal,
        currency: currency,
      });
    }

    // 4. Fallback only if amount is 0 and default string is provided
    if (!qrString && !qrImage && process.env.DEFAULT_KHQR_STRING) {
      qrString = process.env.DEFAULT_KHQR_STRING;
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
      qr_image: qrImage,
      abapay_deeplink: deeplink,
      show_qr: payload.show_qr !== undefined ? Boolean(payload.show_qr) : Boolean(payload.is_payment || payload.payment),
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


