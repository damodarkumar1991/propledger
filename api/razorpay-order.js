// /api/razorpay-order.js — Create Razorpay order server-side
const Razorpay = require('razorpay');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { type, agreementId, userId } = req.body || {};

  const PRICES = {
    esign:     49900,   // ₹499 in paise
    screening: 19900,   // ₹199 in paise
    bundle:    59900    // ₹599 in paise
  };

  const LABELS = {
    esign:     'Aadhaar eSign — Rental Agreement',
    screening: 'Tenant Screening Report',
    bundle:    'eSign + Tenant Screening Bundle'
  };

  const amount = PRICES[type];
  if (!amount) return res.status(400).json({ error: 'Invalid type. Use esign, screening, or bundle.' });

  try {
    const rzp = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });

    const order = await rzp.orders.create({
      amount,
      currency: 'INR',
      receipt: `pl_${type}_${Date.now()}`,
      notes: {
        type,
        agreementId: agreementId || '',
        userId: userId || '',
        platform: 'PropLedger'
      }
    });

    return res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      label: LABELS[type],
      keyId: process.env.RAZORPAY_KEY_ID
    });

  } catch (err) {
    console.error('Razorpay order error:', err);
    return res.status(500).json({ error: err.message || 'Failed to create order' });
  }
};
