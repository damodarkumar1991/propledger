// /api/kyc/create-verification.js
// Creates a new verification session in Supabase before starting KYC flow
// Called after Razorpay payment is confirmed

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get logged-in user from Supabase auth header
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  const { agreement_id, payment_id } = req.body;
  // agreement_id is optional (null for standalone dashboard verification)
  // payment_id is Razorpay payment ID confirming ₹199 paid

  if (!payment_id) {
    return res.status(400).json({ error: 'payment_id is required' });
  }

  try {
    // TODO: Verify payment_id with Razorpay API before creating record
    // const paymentValid = await verifyRazorpayPayment(payment_id);
    // if (!paymentValid) return res.status(402).json({ error: 'Payment not verified' });

    const { data, error } = await supabase
      .from('tenant_verifications')
      .insert({
        landlord_id:    user.id,
        agreement_id:   agreement_id || null,
        payment_id:     payment_id,
        payment_status: 'paid',
      })
      .select('id')
      .single();

    if (error) {
      console.error('Create verification error:', error);
      return res.status(500).json({ error: 'Failed to create verification session' });
    }

    return res.status(200).json({
      success: true,
      verification_id: data.id,
    });

  } catch (err) {
    console.error('Create verification error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
