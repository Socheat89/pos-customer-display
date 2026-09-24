import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

