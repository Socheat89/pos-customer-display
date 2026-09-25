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
    const storeId = store || 'pos_default';

    const rawData = await redis.get(`pos_session_${storeId}`);

    if (!rawData) {
      return res.status(200).json({ status: 'IDLE', store_id: storeId });
    }

    const data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

