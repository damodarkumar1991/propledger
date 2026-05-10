// /api/kyc/aadhaar-generate-otp.js
// Step 1 of Aadhaar verification: send OTP to tenant's Aadhaar-linked mobile

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { aadhaar_number, verification_id } = req.body;

  if (!aadhaar_number || !verification_id) {
    return res.status(400).json({ error: 'aadhaar_number and verification_id are required' });
  }

  // Validate Aadhaar format (12 digits)
  const aadhaarClean = aadhaar_number.replace(/\s/g, '');
  if (!/^\d{12}$/.test(aadhaarClean)) {
    return res.status(400).json({ error: 'Invalid Aadhaar. Must be 12 digits.' });
  }

  try {
    // 1. Call Surepass Aadhaar OTP generation
    const surepassRes = await fetch('https://kyc-api.surepass.app/api/v1/aadhaar-v2/generate-otp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUREPASS_TOKEN}`,
      },
      body: JSON.stringify({
        id_number: aadhaarClean,
      }),
    });

    const surepassData = await surepassRes.json();

    if (!surepassRes.ok || !surepassData.success) {
      console.error('Surepass Aadhaar OTP error:', surepassData);
      return res.status(422).json({
        error: 'Failed to send OTP',
        detail: surepassData.message || 'Aadhaar not found or UIDAI service unavailable',
      });
    }

    const clientId = surepassData.data?.client_id;

    if (!clientId) {
      return res.status(422).json({ error: 'No client_id returned from Surepass' });
    }

    // 2. Store client_id and last4 in Supabase for the submit-otp step
    const { error: dbError } = await supabase
      .from('tenant_verifications')
      .update({
        aadhaar_last4:    aadhaarClean.slice(-4),
        aadhaar_client_id: clientId,
      })
      .eq('id', verification_id);

    if (dbError) {
      console.error('Supabase update error:', dbError);
      return res.status(500).json({ error: 'Failed to save OTP session' });
    }

    // 3. Return success — OTP has been sent to tenant's registered mobile
    return res.status(200).json({
      success: true,
      message: 'OTP sent to Aadhaar-linked mobile number',
      // Do NOT return client_id to frontend — keep it server-side
    });

  } catch (err) {
    console.error('Aadhaar generate-otp error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
