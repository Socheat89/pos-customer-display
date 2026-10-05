import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

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
    data._diagnostic = { hasPaywayKeys, paywayApiUrl };
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

