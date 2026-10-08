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
 * 24-Slot Fixed Order Hash Specification for ABA PayWay Purchase API
 */
/**
 * 24-Slot Fixed Order Hash Specification for ABA PayWay Purchase API
 */
const PURCHASE_HASH_ORDER = [
  "req_time", "merchant_id", "tran_id", "amount", "items", "shipping",
  "firstname", "lastname", "email", "phone", "type", "payment_option",
  "return_url", "cancel_url", "continue_success_url", "return_deeplink",
  "currency", "custom_fields", "return_params", "payout", "lifetime",
  "additional_params", "google_pay_token", "skip_success_page"
];

/**
 * Call ABA PayWay Sandbox / Production API to create transaction and fetch KHQR string & image
 * Supports /payments/purchase (standard urlencoded POST)
 */
async function fetchABAPaywayQR({ storeId, reference, amount, currency, items }) {
  const merchantId = process.env.ABA_PAYWAY_MERCHANT_ID;
  const apiKey     = process.env.ABA_PAYWAY_PUBLIC_KEY || process.env.ABA_PAYWAY_API_KEY;
  let apiUrl       = process.env.ABA_PAYWAY_API_URL || 'https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/generate-qr';

  if (!merchantId || !apiKey) {
    console.warn('[payway] Missing ABA_PAYWAY_MERCHANT_ID or ABA_PAYWAY_PUBLIC_KEY in Environment Variables');
    return { error: 'Missing ABA PayWay Credentials in Environment' };
  }

  const numAmount = Number(amount || 0);
  const pad = n => String(n).padStart(2, "0");
  const d = new Date();
  const req_time = `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}` +
                   `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const tran_id = String(reference || `T${Date.now()}`)
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20);

  // Format items array for ABA PayWay spec ({name, quantity, price})
  const paywayItems = (items || []).map(i => ({
    name: String(i.name || 'Item').replace(/^\d+\s*[\r\n]+/, '').trim(),
    quantity: Number(i.qty || i.quantity || 1),
    price: Number(i.price || 0)
  }));
  const items_base64 = Buffer.from(JSON.stringify(paywayItems.length ? paywayItems : [{ name: "Order", quantity: 1, price: numAmount }])).toString('base64');

  // Callback / Return URL
  const callbackUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/callback?store=${storeId}`
    : `https://pos-customer-display.vercel.app/api/callback?store=${storeId}`;

  const isProd = apiUrl.includes('checkout.payway.com.kh') && !apiUrl.includes('checkout-sandbox');
  const baseHost = isProd ? 'https://checkout.payway.com.kh' : 'https://checkout-sandbox.payway.com.kh';

  // 1. Primary: Call ABA PayWay official /payments/generate-qr API
  // This endpoint returns the COMPLETE official template3_color ticket PNG directly from ABA PayWay!
  try {
    const genQrUrl = `${baseHost}/api/payment-gateway/v1/payments/generate-qr`;
    const paymentOption = 'abapay_khqr';
    const lifetime = '5';
    const qrImageTemplate = 'template3_color';
    const curr = currency || 'USD';

    // Hash specification for generate-qr:
    // req_time + merchant_id + tran_id + numAmount + items_base64 + '' + '' + '' + '' + '' + payment_option + '' + '' + curr + '' + '' + '' + lifetime + qr_image_template
    const hashStr = req_time + merchantId + tran_id + numAmount + items_base64 +
      '' + '' + '' + '' + '' + paymentOption +
      '' + '' + curr + '' + '' + '' + lifetime + qrImageTemplate;

    const hash = crypto.createHmac('sha512', apiKey).update(hashStr).digest('base64');

    const payload = {
      req_time,
      merchant_id: merchantId,
      tran_id,
      amount: numAmount,
      currency: curr,
      payment_option: paymentOption,
      lifetime: 5,
      qr_image_template: qrImageTemplate,
      items: items_base64,
      hash
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6500);

    const res = await fetch(genQrUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      console.log(`[payway:generate-qr] Response for store=${storeId}:`, data?.status || data);
      if (data.qrImage || data.qrString) {
        let qrImg = data.qrImage || data.qr_image || null;
        if (qrImg && !qrImg.startsWith('data:') && !qrImg.startsWith('http')) {
          qrImg = `data:image/png;base64,${qrImg}`;
        }
        return {
          tran_id,
          qrString: data.qrString || data.qr_string || null,
          qrImage: qrImg,
          abapay_deeplink: data.abapay_deeplink || null,
          is_payway: true,
          endpoint_used: 'generate-qr'
        };
      }
    }
  } catch (err) {
    console.warn('[payway:generate-qr] Error:', err.message);
  }

  // 2. Secondary: Fallback to /payments/purchase API
  try {
    const purchaseUrl = `${baseHost}/api/payment-gateway/v1/payments/purchase`;
    const formattedAmount = numAmount.toFixed(2);
    const f = {
      req_time,
      merchant_id:          merchantId,
      tran_id,
      amount:               formattedAmount,
      items:                items_base64,
      shipping:             '',
      firstname:            'SK',
      lastname:             'Store',
      email:                'pos@skstore.com',
      phone:                '012345678',
      type:                 'purchase',
      payment_option:       'abapay_khqr',
      return_url:           callbackUrl,
      cancel_url:           '',
      continue_success_url: '',
      return_deeplink:      '',
      currency:             currency || 'USD',
      custom_fields:        '',
      return_params:        storeId,
      payout:               '',
      lifetime:             '5',
      additional_params:    '',
      google_pay_token:     '',
      skip_success_page:    '',
    };

    const b4hash = PURCHASE_HASH_ORDER.map(k => (f[k] !== undefined && f[k] !== null ? String(f[k]) : '')).join('');
    f.hash = crypto.createHmac('sha512', apiKey).update(b4hash).digest('base64');

    const params = new URLSearchParams();
    Object.keys(f).forEach(k => {
      if (f[k] !== '') params.append(k, String(f[k]));
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6500);

    const res = await fetch(purchaseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      console.log(`[payway:purchase] Response for store=${storeId}:`, data?.status || data);
      let qrImg = data.qrImage || data.qr_image || null;
      if (qrImg && !qrImg.startsWith('data:') && !qrImg.startsWith('http')) {
        qrImg = `data:image/png;base64,${qrImg}`;
      }
      return {
        tran_id,
        qrString: data.qrString || data.qr_string || null,
        qrImage: qrImg,
        abapay_deeplink: data.abapay_deeplink || null,
        is_payway: true,
        endpoint_used: 'purchase'
      };
    }
  } catch (err) {
    console.warn('[payway:purchase] Error:', err.message);
  }

  return { error: 'Failed to fetch QR from ABA PayWay' };
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') {
    return res.status(200).json({
      success: true,
      message: 'Order API is online. Submit orders using POST.',
      store: req.query.store || 'pos_default'
    });
  }
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

    const reqStatus = (payload.status || 'ACTIVE').toUpperCase();
    const isPaymentMode = Boolean(payload.show_qr || payload.is_payment || payload.payment);

    // 1. Direct qrString / qrImage from payload
    let qrString = payload.qrString || payload.qr_string || payload.qr_code || payload.qr || null;
    let qrImage  = payload.qrImage || payload.qr_image || null;
    let deeplink = payload.abapay_deeplink || null;
    let isPayway = Boolean(qrString || qrImage);
    let paywayDebug = null;
    let paywayRes = null;

    // Fast cache check: if this order already has a generated genuine PayWay QR with same amount, reuse it!
    if (reqStatus !== 'SUCCESS' && !qrString && !qrImage && amountTotal > 0) {
      try {
        const prevRaw = await redis.get(`pos_session_${storeId}`);
        if (prevRaw) {
          const prev = typeof prevRaw === 'string' ? JSON.parse(prevRaw) : prevRaw;
          if (prev && prev.reference === reference && Number(prev.amount_total) === amountTotal) {
            // Only reuse if it was a genuine PayWay QR, OR if we are NOT currently in payment mode
            if (prev.is_payway || prev.qr_image || !isPaymentMode) {
              qrString = prev.qr_string;
              qrImage  = prev.qr_image;
              deeplink = prev.abapay_deeplink;
              isPayway = Boolean(prev.is_payway || prev.qr_image);
              paywayDebug = prev._payway_debug || null;
            }
          }
        }
      } catch (_) {}
    }

    // 2. Dynamic KHQR via ABA PayWay Sandbox / Production API
    if (reqStatus !== 'SUCCESS' && !isPayway && amountTotal > 0 && isPaymentMode) {
      paywayRes = await fetchABAPaywayQR({
        storeId,
        reference,
        amount: amountTotal,
        currency,
        items,
      });
      if (paywayRes) {
        paywayDebug = paywayRes;
        if (paywayRes.qrString || paywayRes.qrImage) {
          qrString = paywayRes.qrString;
          qrImage  = paywayRes.qrImage;
          deeplink = paywayRes.abapay_deeplink;
          isPayway = true;
        }
      }
    }

    // 3. Dynamic EMVCo KHQR fallback only if PayWay failed or is unavailable
    if (reqStatus !== 'SUCCESS' && !qrString && !qrImage && amountTotal > 0 && isPaymentMode) {
      qrString = generateEMVCoKHQR({
        merchantName: 'SK STORE',
        city: 'Phnom Penh',
        amount: amountTotal,
        currency: currency,
      });
    }

    // 4. Fallback only if amount is 0 and default string is provided
    if (reqStatus !== 'SUCCESS' && !qrString && !qrImage && process.env.DEFAULT_KHQR_STRING) {
      qrString = process.env.DEFAULT_KHQR_STRING;
    }

    const tran_id_used = paywayRes?.tran_id || String(reference || `T${Date.now()}`).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 20);

    // Standardize session data for Upstash Redis
    const sessionData = {
      status: reqStatus,
      store_id: storeId,
      name: reference,
      reference: reference,
      tran_id: tran_id_used,
      amount_total: amountTotal,
      currency: currency,
      items: items,
      qr_string: qrString,
      qr_image: qrImage,
      abapay_deeplink: deeplink,
      is_payway: isPayway,
      show_qr: reqStatus === 'SUCCESS' ? false : isPaymentMode,
      updated_at: Date.now(),
      _payway_debug: paywayDebug,
    };

    // Save to Redis key per store
    await redis.set(`pos_session_${storeId}`, JSON.stringify(sessionData));
    if (storeId !== 'pos_default') {
      await redis.set(`pos_session_pos_default`, JSON.stringify(sessionData));
    }

    // Save mapping tran_id -> storeId & reference -> storeId in Redis for 1 hour so callback can always find the store!
    if (tran_id_used) {
      try {
        await redis.set(`payway_tran_${tran_id_used}`, storeId, { ex: 3600 });
      } catch (_) {}
    }
    if (reference) {
      try {
        await redis.set(`payway_ref_${reference}`, storeId, { ex: 3600 });
      } catch (_) {}
    }

    console.log(`[order] Saved session for store: ${storeId}, status=${reqStatus}, total=${amountTotal}, ref=${reference}`);

    return res.status(200).json({
      success: true,
      store_id: storeId,
      status: reqStatus,
      _payway_debug: paywayDebug,
    });
  } catch (err) {
    console.error('[order] Error:', err);
    return res.status(500).json({ error: err.message });
  }
}


