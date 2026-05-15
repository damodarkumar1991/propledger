// /api/kyc/digilocker-init.js
// Initiates DigiLocker verification link via Surepass identity/digilocker
// Returns a consent URL to send to the tenant

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { verification_id } = req.body;

  if (!verification_id) {
    return res.status(400).json({ error: 'verification_id is required' });
  }

  try {
    // 1. Call Surepass DigiLocker init endpoint
    const surepassRes = await fetch('https://kyc-api.surepass.app/api/v1/identity/digilocker', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUREPASS_TOKEN}`,
      },
      body: JSON.stringify({
        // Surepass uses client_id as your reference — tie it to verification_id
        client_id: verification_id,
      }),
    });

    const surepassData = await surepassRes.json();

    if (!surepassRes.ok || !surepassData.success) {
      console.error('Surepass DigiLocker init error:', surepassData);
      return res.status(422).json({
        error: 'Failed to initiate DigiLocker',
        detail: surepassData.message || 'Surepass error',
      });
    }

    const { url, client_id } = surepassData.data;

    // 2. Save the DigiLocker client_id + link to Supabase so we can poll later
    const { error: dbError } = await supabase
      .from('tenant_verifications')
      .update({
        digilocker_client_id:  client_id || verification_id,
        digilocker_link:       url,
        digilocker_status:     'pending',
        digilocker_initiated_at: new Date().toISOString(),
      })
      .eq('id', verification_id);

    if (dbError) {
      console.error('Supabase update error:', dbError);
      return res.status(500).json({ error: 'Failed to save DigiLocker session' });
    }

    return res.status(200).json({
      success: true,
      digilocker_url: url,
      message: 'Send this link to the tenant. They must log in with their Aadhaar-linked DigiLocker account.',
    });

  } catch (err) {
    console.error('DigiLocker init error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
