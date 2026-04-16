// /api/razorpay-verify.js — Verify payment signature server-side
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, type, agreementId, userId } = req.body || {};

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment fields' });
  }

  try {
    // Verify signature — MUST happen server-side with secret key
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      console.error('Signature mismatch');
      return res.status(400).json({ success: false, error: 'Payment verification failed' });
    }

    // Payment is genuine — save to Supabase
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const AMOUNTS = { esign: 499, screening: 199, bundle: 599 };

    await sb.from('payments').insert({
      user_id: userId || null,
      agreement_id: agreementId || null,
      type: type || 'unknown',
      razorpay_order_id,
      razorpay_payment_id,
      amount: AMOUNTS[type] || 0,
      status: 'paid',
      paid_at: new Date().toISOString()
    });

    console.log('Payment verified and saved:', razorpay_payment_id, type);

    return res.json({
      success: true,
      paymentId: razorpay_payment_id,
      type
    });

  } catch (err) {
    console.error('Verify error:', err);
    return res.status(500).json({ error: err.message });
  }
};
