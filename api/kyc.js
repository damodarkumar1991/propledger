// api/kyc.js — Single consolidated KYC handler for PropLedger
// Actions: create-verification | pan-verify
// Replaces: api/kyc/create-verification.js + api/kyc/pan-verify.js

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body;

  if (!action) {
    return res.status(400).json({ error: 'action is required' });
  }

  try {
    switch (action) {
      case 'create-verification': return await createVerification(req, res);
      case 'pan-verify':          return await panVerify(req, res);
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error(`KYC [${action}] error:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── ACTION 1: CREATE VERIFICATION SESSION ────────────────────────────────────
async function createVerification(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  const { agreement_id, payment_id } = req.body;
  if (!payment_id) return res.status(400).json({ error: 'payment_id is required' });

  // TODO: Verify payment_id with Razorpay before creating record
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

  return res.status(200).json({ success: true, verification_id: data.id });
}

// ── ACTION 2: PAN VERIFY ─────────────────────────────────────────────────────
async function panVerify(req, res) {
  const { pan_number, verification_id } = req.body;

  if (!pan_number || !verification_id) {
    return res.status(400).json({ error: 'pan_number and verification_id are required' });
  }

  // Validate PAN format
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan_number.toUpperCase())) {
    return res.status(400).json({ error: 'Invalid PAN format. Expected: ABCDE1234F' });
  }

  // Call Surepass PAN Comprehensive API
  const surepassRes = await fetch('https://kyc-api.surepass.app/api/v1/pan/pan-comprehensive', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SUREPASS_TOKEN}`,
    },
    body: JSON.stringify({ id_number: pan_number.toUpperCase() }),
  });

  const surepassData = await surepassRes.json();

  if (!surepassRes.ok || !surepassData.success) {
    console.error('Surepass PAN error:', surepassData);
    return res.status(422).json({
      error: 'PAN verification failed',
      detail: surepassData.message || 'Invalid PAN or not found',
    });
  }

  const panInfo = surepassData.data;

  // Sanitize — only store what we need
  const safeData = {
    full_name:     panInfo.full_name    || '',
    first_name:    panInfo.first_name   || '',
    last_name:     panInfo.last_name    || '',
    pan_number:    pan_number.toUpperCase(),
    date_of_birth: panInfo.dob          || '',
    pan_status:    panInfo.status       || '',
    pan_type:      panInfo.category     || '',
    aadhaar_linked: panInfo.aadhaar_linked || false,
    verified_at:   new Date().toISOString(),
  };

  // Update Supabase record
  const { error: dbError } = await supabase
    .from('tenant_verifications')
    .update({
      pan_number:   pan_number.toUpperCase(),
      pan_verified: true,
      pan_data:     safeData,
      tenant_name:  safeData.full_name,
    })
    .eq('id', verification_id);

  if (dbError) {
    console.error('Supabase update error:', dbError);
    return res.status(500).json({ error: 'Failed to save verification result' });
  }

  return res.status(200).json({
    success: true,
    data: {
      full_name:     safeData.full_name,
      date_of_birth: safeData.date_of_birth,
      pan_status:    safeData.pan_status,
      pan_type:      safeData.pan_type,
      pan_number:    safeData.pan_number,
    },
  });
}
