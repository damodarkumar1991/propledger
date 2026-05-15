// /api/kyc/digilocker-status.js
// Polls Surepass for DigiLocker result after tenant has completed consent
// Also cross-matches Aadhaar name vs PAN name if both exist

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Normalise name for fuzzy comparison (lowercase, remove extra spaces/dots)
function normaliseName(name = '') {
  return name.toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

// Simple word-overlap score between two names
function nameMatchScore(nameA = '', nameB = '') {
  const a = normaliseName(nameA).split(' ').filter(Boolean);
  const b = normaliseName(nameB).split(' ').filter(Boolean);
  if (!a.length || !b.length) return 0;
  const matches = a.filter(word => b.includes(word));
  return Math.round((matches.length / Math.max(a.length, b.length)) * 100);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { verification_id } = req.body;

  if (!verification_id) {
    return res.status(400).json({ error: 'verification_id is required' });
  }

  try {
    // 1. Fetch current verification record to get digilocker_client_id
    const { data: record, error: fetchError } = await supabase
      .from('tenant_verifications')
      .select('digilocker_client_id, pan_data, pan_verified, digilocker_status')
      .eq('id', verification_id)
      .single();

    if (fetchError || !record) {
      return res.status(404).json({ error: 'Verification record not found' });
    }

    if (!record.digilocker_client_id) {
      return res.status(400).json({ error: 'DigiLocker not yet initiated for this verification' });
    }

    // If already completed, return cached result
    if (record.digilocker_status === 'completed') {
      return res.status(200).json({
        success: true,
        status: 'completed',
        message: 'DigiLocker already verified',
      });
    }

    // 2. Poll Surepass for DigiLocker status
    const surepassRes = await fetch(
      `https://kyc-api.surepass.app/api/v1/identity/digilocker/status/${record.digilocker_client_id}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${process.env.SUREPASS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const surepassData = await surepassRes.json();

    // Still waiting for tenant to complete consent
    if (!surepassData.success || surepassData.data?.status === 'pending') {
      return res.status(200).json({
        success: true,
        status: 'pending',
        message: 'Tenant has not yet completed DigiLocker consent.',
      });
    }

    const digiData = surepassData.data;

    // 3. Extract Aadhaar details from DigiLocker response
    const aadhaarInfo = {
      full_name:    digiData.name || digiData.full_name || '',
      date_of_birth: digiData.dob || digiData.date_of_birth || '',
      gender:       digiData.gender || '',
      address:      digiData.address || digiData.current_address || '',
      photo:        digiData.photo || '',  // base64 if returned
      verified_at:  new Date().toISOString(),
    };

    // 4. Cross-match with PAN name if PAN was already verified
    let nameMatchResult = { score: 0, status: 'not_checked' };
    if (record.pan_verified && record.pan_data?.full_name) {
      const score = nameMatchScore(record.pan_data.full_name, aadhaarInfo.full_name);
      nameMatchResult = {
        score,
        status: score >= 60 ? 'matched' : 'mismatch',
        pan_name: record.pan_data.full_name,
        aadhaar_name: aadhaarInfo.full_name,
      };
    }

    // Determine overall KYC status
    const kycComplete =
      record.pan_verified &&
      (nameMatchResult.status === 'matched' || nameMatchResult.status === 'not_checked');

    // 5. Save DigiLocker result + cross-match to Supabase
    const { error: updateError } = await supabase
      .from('tenant_verifications')
      .update({
        digilocker_verified:     true,
        digilocker_status:       'completed',
        digilocker_data:         aadhaarInfo,
        aadhaar_name:            aadhaarInfo.full_name,
        aadhaar_dob:             aadhaarInfo.date_of_birth,
        aadhaar_address:         aadhaarInfo.address,
        aadhaar_gender:          aadhaarInfo.gender,
        name_match_score:        nameMatchResult.score,
        name_match_status:       nameMatchResult.status,
        kyc_status:              kycComplete ? 'KYC_COMPLETE' : 'KYC_PARTIAL',
        kyc_completed_at:        kycComplete ? new Date().toISOString() : null,
      })
      .eq('id', verification_id);

    if (updateError) {
      console.error('Supabase update error:', updateError);
      return res.status(500).json({ error: 'Failed to save DigiLocker result' });
    }

    return res.status(200).json({
      success: true,
      status: 'completed',
      kyc_status: kycComplete ? 'KYC_COMPLETE' : 'KYC_PARTIAL',
      data: {
        aadhaar_name:    aadhaarInfo.full_name,
        date_of_birth:   aadhaarInfo.date_of_birth,
        gender:          aadhaarInfo.gender,
        address:         aadhaarInfo.address,
      },
      name_match: nameMatchResult,
    });

  } catch (err) {
    console.error('DigiLocker status error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
