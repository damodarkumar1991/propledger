// /api/kyc/aadhaar-submit-otp.js
// Step 2 of Aadhaar verification: submit OTP, get data, cross-verify with PAN name

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Fuzzy name match: returns 0-100 score
function fuzzyNameMatch(name1, name2) {
  if (!name1 || !name2) return 0;

  const normalize = (s) =>
    s.toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .trim()
      .split(/\s+/)
      .sort()
      .join(' ');

  const n1 = normalize(name1);
  const n2 = normalize(name2);

  if (n1 === n2) return 100;

  // Token-based overlap score
  const tokens1 = new Set(n1.split(' '));
  const tokens2 = new Set(n2.split(' '));
  const intersection = [...tokens1].filter(t => tokens2.has(t)).length;
  const union = new Set([...tokens1, ...tokens2]).size;

  return Math.round((intersection / union) * 100);
}

function getMatchStatus(score) {
  if (score >= 80) return 'matched';
  if (score >= 50) return 'review';
  return 'mismatch';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { otp, verification_id } = req.body;

  if (!otp || !verification_id) {
    return res.status(400).json({ error: 'otp and verification_id are required' });
  }

  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ error: 'OTP must be 6 digits' });
  }

  try {
    // 1. Fetch verification record to get stored client_id and PAN name
    const { data: record, error: fetchError } = await supabase
      .from('tenant_verifications')
      .select('aadhaar_client_id, pan_data, pan_verified')
      .eq('id', verification_id)
      .maybeSingle();

    if (fetchError || !record) {
      return res.status(404).json({ error: 'Verification record not found' });
    }

    if (!record.aadhaar_client_id) {
      return res.status(400).json({ error: 'OTP not yet generated. Call generate-otp first.' });
    }

    // 2. Submit OTP to Surepass
    const surepassRes = await fetch('https://kyc-api.surepass.app/api/v1/aadhaar-v2/submit-otp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUREPASS_TOKEN}`,
      },
      body: JSON.stringify({
        client_id: record.aadhaar_client_id,
        otp: otp,
      }),
    });

    const surepassData = await surepassRes.json();

    if (!surepassRes.ok || !surepassData.success) {
      console.error('Surepass OTP submit error:', surepassData);
      return res.status(422).json({
        error: 'OTP verification failed',
        detail: surepassData.message || 'Invalid OTP or session expired',
      });
    }

    const aadhaarInfo = surepassData.data;

    // 3. Sanitize Aadhaar data — NEVER store full Aadhaar number
    const safeAadhaarData = {
      full_name:       aadhaarInfo.full_name || '',
      dob:             aadhaarInfo.dob || '',
      gender:          aadhaarInfo.gender || '',
      address:         aadhaarInfo.address || {},
      zip:             aadhaarInfo.zip || '',
      state:           aadhaarInfo.state || '',
      // face_status:  aadhaarInfo.face_status || '',   // enable if face match needed
      verified_at:     new Date().toISOString(),
    };

    // 4. Cross-verify name with PAN (if PAN already verified)
    let matchScore = 0;
    let matchStatus = 'pending';

    if (record.pan_verified && record.pan_data?.full_name) {
      matchScore = fuzzyNameMatch(safeAadhaarData.full_name, record.pan_data.full_name);
      matchStatus = getMatchStatus(matchScore);
    }

    // 5. Update Supabase record
    const { error: dbError } = await supabase
      .from('tenant_verifications')
      .update({
        aadhaar_verified:   true,
        aadhaar_data:       safeAadhaarData,
        aadhaar_client_id:  null,  // clear session token after use
        tenant_name:        safeAadhaarData.full_name,
        name_match_score:   matchScore,
        name_match_status:  matchStatus,
      })
      .eq('id', verification_id);

    if (dbError) {
      console.error('Supabase update error:', dbError);
      return res.status(500).json({ error: 'Failed to save verification result' });
    }

    // 6. Return result
    return res.status(200).json({
      success: true,
      data: {
        full_name:        safeAadhaarData.full_name,
        dob:              safeAadhaarData.dob,
        gender:           safeAadhaarData.gender,
        address:          safeAadhaarData.address,
        state:            safeAadhaarData.state,
        name_match_score: matchScore,
        name_match_status: matchStatus,
        pan_name:         record.pan_data?.full_name || null,
      },
    });

  } catch (err) {
    console.error('Aadhaar submit-otp error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
