# POS Customer Display — SK Cosmetic

> **Odoo POS · ABA KHQR · Vercel + Upstash Redis**

A production-ready, serverless customer-facing display that shows live order details and an ABA PayWay KHQR code. Hosted on **Vercel** with state stored in **Upstash Redis**.

---

## Architecture

```
Odoo POS Studio
    │  POST /api/order  (new order webhook)
    ▼
Vercel Serverless Functions
    │  Upstash Redis (current_pos_session)
    ▼
ABA PayWay
    │  POST /api/callback  (payment confirmation)
    ▼
Customer Display (browser — polling /api/status every 1.1 s)
```

---

## Project Structure

```
pos-customer-display/
├── api/
│   ├── order.js      # Receives Odoo POS order → sets PENDING
│   ├── callback.js   # Receives ABA PayWay success → sets SUCCESS
│   ├── status.js     # Frontend polls this endpoint
│   └── reset.js      # Clears session → back to IDLE
├── public/
│   ├── index.html    # Customer-facing screen (3 states)
│   ├── css/style.css # ABA KHQR template3_color + animations
│   └── js/app.js     # State machine + QR renderer + polling
├── .env.example
├── package.json
├── vercel.json
└── README.md
```

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/YOUR_ORG/pos-customer-display.git
cd pos-customer-display
npm install
```

### 2. Upstash Redis

1. Go to [console.upstash.com](https://console.upstash.com/) → **Create Database** (choose nearest region).
2. Copy **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN** from the *REST API* tab.

### 3. Environment Variables

```bash
cp .env.example .env
# Fill in your Upstash credentials
```

### 4. Deploy to Vercel

```bash
npm i -g vercel          # or npx vercel
vercel login
vercel --prod
```

During deployment, add these **Environment Variables** in the Vercel dashboard or via CLI:

| Variable | Value |
|---|---|
| `UPSTASH_REDIS_REST_URL` | `https://xxxx.upstash.io` |
| `UPSTASH_REDIS_REST_TOKEN` | `AXxx...` |

---

## Webhook Setup

### Odoo Studio → `POST /api/order`

Configure an **Automation / Webhook** in Odoo Studio on the `pos.order` model (trigger: `On order confirmed`).

**Payload mapping:**

| Odoo Field | JSON Key |
|---|---|
| `name` | `name` |
| `amount_total` | `amount_total` |
| `currency_id.name` | `currency` |
| Order lines | `items` → `[{name, qty, price}]` |
| (custom KHQR field) | `qr_string` |

**Example body:**
```json
{
  "name": "Order 00001-001-0042",
  "amount_total": 24.50,
  "currency": "USD",
  "items": [
    { "name": "Laneige Water Cream", "qty": 1, "price": 18.00 },
    { "name": "Lip Sleeping Mask",   "qty": 1, "price": 6.50 }
  ],
  "qr_string": "00020101021229..."
}
```

### ABA PayWay → `POST /api/callback`

In your ABA PayWay merchant portal, set the **Return URL / IPN URL** to:

```
https://YOUR_VERCEL_APP.vercel.app/api/callback
```

ABA PayWay sends `status=00` (or `SUCCESS`) on successful payment. The callback handler will update the display automatically.

---

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/api/order` | `POST` | New order from Odoo → state: `PENDING` |
| `/api/callback` | `POST` | ABA PayWay result → state: `SUCCESS` |
| `/api/status` | `GET` | Current state (polled by display) |
| `/api/reset` | `POST` | Force reset to `IDLE` |

### Status Response Shape

```json
{
  "status":       "PENDING",
  "reference":    "Order 00001-001-0042",
  "amount_total": 24.50,
  "currency":     "USD",
  "items":        [{ "name": "...", "qty": 1, "price": 18.00 }],
  "qr_string":    "00020101...",
  "created_at":   "2026-09-24T03:55:00.000Z",
  "paid_at":      null
}
```

---

## UI States

| State | Screen |
|---|---|
| `IDLE` | Welcome screen with animated logo & waiting indicator |
| `PENDING` | Split layout: items left (55%) + KHQR right (45%) |
| `SUCCESS` | Full overlay with green checkmark, "Payment Successful!" + "Thank You!", 5 s countdown |

---

## Security Notes

- Add `WEBHOOK_SECRET` to `.env` and validate `Authorization: Bearer <secret>` in `api/order.js` for production.
- ABA PayWay callbacks should be IP-whitelisted where your infrastructure permits.
- The display URL can be restricted to your store network via Vercel's **IP Allowlist** (Pro plan).

---

## License

MIT — see [LICENSE](LICENSE).
