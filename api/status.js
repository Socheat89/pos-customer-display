import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = Redis.fromEnv();

/** Format UTC req_time matching ABA PayWay standard (YYYYMMDDHHmmss) */
function getUtcReqTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}` +
         `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** Check transaction with ABA PayWay check-transaction-2 API */
async function checkPaywayTransaction(tranId) {
  const merchantId = process.env.ABA_PAYWAY_MERCHANT_ID;
  const apiKey     = process.env.ABA_PAYWAY_PUBLIC_KEY || process.env.ABA_PAYWAY_API_KEY;
  let apiUrl       = process.env.ABA_PAYWAY_API_URL || 'https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/generate-qr';

  if (!merchantId || !apiKey || !tranId) return false;

  let checkUrl = apiUrl.includes('checkout.payway.com.kh')
    ? 'https://checkout.payway.com.kh/api/payment-gateway/v1/payments/check-transaction-2'
    : 'https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/check-transaction-2';

  const req_time = getUtcReqTime();
  // Hash for check-transaction-2: HMAC-SHA512(req_time + merchant_id + tran_id)
  const hash = crypto.createHmac('sha512', apiKey).update(req_time + merchantId + tranId).digest('base64');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(checkUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ req_time, merchant_id: merchantId, tran_id: tranId, hash }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      console.log(`[status:payway-poll] tran_id=${tranId} raw response:`, JSON.stringify(data));
      // NOTE: In PayWay check-transaction-2:
      // data.status is the API call status (code "0" means API request succeeded).
      // The actual payment status is in data.data.payment_status or data.payment_status!
      const pStatus = String(data?.data?.payment_status ?? data?.payment_status ?? '').toUpperCase();
      const pStatusCode = data?.data?.payment_status_code ?? data?.payment_status_code;

      // Strictly confirm payment: only if explicitly APPROVED, PAID, or SUCCESS
      if (pStatus === 'APPROVED' || pStatus === 'PAID' || pStatus === 'SUCCESS') {
        console.log(`[status:payway-poll] Transaction confirmed PAID for tran_id=${tranId} (status=${pStatus})`);
        return true;
      }
      if (pStatusCode === 0 && (pStatus === 'APPROVED' || pStatus === 'COMPLETED' || pStatus === 'PAID')) {
        console.log(`[status:payway-poll] Transaction confirmed PAID for tran_id=${tranId} (code=0 status=${pStatus})`);
        return true;
      }
    }
  } catch (err) {
    // Non-critical background poll error
  }
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Prevent any browser, CDN, proxy, or edge network from caching the live status
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { store } = req.query;
    let storeId = store || 'pos_default';

    let rawData = await redis.get(`pos_session_${storeId}`);

    // If pos_default has no active session, find if any other store session exists
    if (!rawData && (!store || store === 'pos_default')) {
      try {
        const keys = await redis.keys('pos_session_*');
        if (Array.isArray(keys) && keys.length > 0) {
          for (const k of keys) {
            const val = await redis.get(k);
            if (val) {
              const parsed = typeof val === 'string' ? JSON.parse(val) : val;
              if (parsed && (parsed.status === 'ACTIVE' || parsed.status === 'PENDING' || parsed.status === 'SUCCESS')) {
                rawData = val;
                storeId = k.replace('pos_session_', '');
                break;
              }
            }
          }
        }
      } catch (_) {}
    }

    const hasPaywayKeys = Boolean(process.env.ABA_PAYWAY_MERCHANT_ID && (process.env.ABA_PAYWAY_PUBLIC_KEY || process.env.ABA_PAYWAY_API_KEY));
    const paywayApiUrl = process.env.ABA_PAYWAY_API_URL || 'default_generate_qr';

    if (!rawData) {
      return res.status(200).json({
        status: 'IDLE',
        store_id: storeId,
        _diagnostic: { hasPaywayKeys, paywayApiUrl }
      });
    }

    const data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;

    // Auto-check ABA PayWay ONLY if session is currently waiting for payment AND QR is shown to customer
    if (data && data.show_qr && (data.status === 'ACTIVE' || data.status === 'PENDING') && (data.tran_id || data.reference)) {
      const tranIdToCheck = data.tran_id || data.reference;
      const cooldownKey = `payway_poll_cd_${tranIdToCheck}`;
      try {
        const inCooldown = await redis.get(cooldownKey);
        if (!inCooldown) {
          await redis.set(cooldownKey, "1", { ex: 2 });
          const isPaid = await checkPaywayTransaction(tranIdToCheck);
          if (isPaid) {
            data.status = 'SUCCESS';
            data.paid_at = new Date().toISOString();
            data.updated_at = Date.now();
            await redis.set(`pos_session_${storeId}`, JSON.stringify(data), { ex: 300 });
            if (storeId !== 'pos_default') {
              await redis.set(`pos_session_pos_default`, JSON.stringify(data), { ex: 300 });
            }
          }
        }
      } catch (_) {}
    }

    data._diagnostic = { hasPaywayKeys, paywayApiUrl };
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
