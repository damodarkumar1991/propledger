// /api/kyc/pan-verify.js
// Verifies PAN number via Surepass and stores result in Supabase

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pan_number, verification_id } = req.body;

  if (!pan_number || !verification_id) {
    return res.status(400).json({ error: 'pan_number and verification_id are required' });
  }

  // Validate PAN format
  const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
  if (!panRegex.test(pan_number.toUpperCase())) {
    return res.status(400).json({ error: 'Invalid PAN format. Expected: ABCDE1234F' });
  }

  try {
    // 1. Call Surepass PAN verification API
    const surepassRes = await fetch('https://kyc-api.surepass.app/api/v1/pan/pan-comprehensive', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUREPASS_TOKEN}`,
      },
      body: JSON.stringify({
        id_number: pan_number.toUpperCase(),
      }),
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

    // 2. Sanitize: only store what we need
    const safeData = {
  full_name:       panInfo.full_name || '',
  first_name:      panInfo.first_name || '',
  last_name:       panInfo.last_name || '',
  pan_number:      panInfo.pan_number || pan_number.toUpperCase(),
  date_of_birth:   panInfo.dob || '',          // ✅ fixed
  pan_status:      panInfo.status || '',        // ✅ fixed
  pan_type:        panInfo.category || '',      // ✅ fixed
  aadhaar_linked:  panInfo.aadhaar_linked || false,  // bonus field
  verified_at:     new Date().toISOString(),
};

    // 3. Update the verification record in Supabase
    const { error: dbError } = await supabase
      .from('tenant_verifications')
      .update({
        pan_number:   pan_number.toUpperCase(),
        pan_verified: true,
        pan_data:     safeData,
        tenant_name:  safeData.full_name, // seed name for cross-match
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
      },
    });

  } catch (err) {
    console.error('PAN verify error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
