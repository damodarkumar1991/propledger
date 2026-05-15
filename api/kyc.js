// api/kyc.js — Consolidated KYC handler for PropLedger
// Actions: create-verification | init-verification | pan-verify | digilocker-init | digilocker-status

const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action is required' });

  try {
    if (action === 'create-verification')  return await createVerification(req, res);
    if (action === 'init-verification')    return await initVerification(req, res);
    if (action === 'pan-verify')           return await panVerify(req, res);
    if (action === 'digilocker-init')      return await digilockerInit(req, res);
    if (action === 'digilocker-status')    return await digilockerStatus(req, res);
    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error(`KYC [${action}] error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── CREATE VERIFICATION (auth-gated, from dashboard) ─────────────────────────
async function createVerification(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

  const { agreement_id, payment_id } = req.body;

  const { data, error } = await supabase
    .from('tenant_verifications')
    .insert({
      landlord_id:    user.id,
      agreement_id:   agreement_id || null,
      payment_id:     payment_id || 'bypass',
      payment_status: 'paid',
      kyc_status:     'NOT_STARTED',
    })
    .select('id')
    .single();

  if (error) {
    console.error('Create verification error:', error);
    return res.status(500).json({ error: 'Failed to create verification session' });
  }

  return res.status(200).json({ success: true, verification_id: data.id });
}

// ── INIT VERIFICATION (no auth — called on page load) ────────────────────────
async function initVerification(req, res) {
  // Minimal insert — only columns that exist in the original table
  // New columns (digilocker_*, kyc_status etc.) are added via migration
  // If migration not yet run, this still succeeds with just payment_id + payment_status
  const { data, error } = await supabase
    .from('tenant_verifications')
    .insert({
      payment_id:     'kyc_init',
      payment_status: 'paid',
    })
    .select('id')
    .single();

  if (error) {
    console.error('Init verification error:', error);
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ success: true, verification_id: data.id });
}

// ── PAN VERIFY ───────────────────────────────────────────────────────────────
async function panVerify(req, res) {
  const { pan_number, verification_id } = req.body;

  if (!pan_number || !verification_id) {
    return res.status(400).json({ error: 'pan_number and verification_id are required' });
  }

  if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan_number.toUpperCase())) {
    return res.status(400).json({ error: 'Invalid PAN format. Expected: ABCDE1234F' });
  }

  let surepassData;
  try {
    const { data } = await axios.post(
      'https://kyc-api.surepass.app/api/v1/pan/pan-comprehensive',
      { id_number: pan_number.toUpperCase() },
      { headers: { 'Authorization': `Bearer ${process.env.SUREPASS_TOKEN}` } }
    );
    surepassData = data;
  } catch (err) {
    const data = err.response?.data;
    console.error('Surepass PAN error:', data);
    return res.status(422).json({
      error:  'PAN verification failed',
      detail: data?.message || err.message,
    });
  }

  if (!surepassData.success) {
    return res.status(422).json({
      error:  'PAN verification failed',
      detail: surepassData.message || 'Invalid PAN or not found',
    });
  }

  const p = surepassData.data;

  const safeData = {
    full_name:      p.full_name  || '',
    first_name:     p.first_name || '',
    last_name:      p.last_name  || '',
    pan_number:     pan_number.toUpperCase(),
    date_of_birth:  p.dob        || '',
    pan_status:     p.status     || '',
    pan_type:       p.category   || '',
    aadhaar_linked: p.aadhaar_linked || false,
    verified_at:    new Date().toISOString(),
  };

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

// ── DIGILOCKER INIT ──────────────────────────────────────────────────────────
async function digilockerInit(req, res) {
  const { verification_id } = req.body;

  if (!verification_id) {
    return res.status(400).json({ error: 'verification_id is required' });
  }

  let surepassData;
  try {
    const { data } = await axios.post(
      'https://kyc-api.surepass.app/api/v1/identity/digilocker',
      { client_id: verification_id },
      { headers: { 'Authorization': `Bearer ${process.env.SUREPASS_TOKEN}` } }
    );
    surepassData = data;
  } catch (err) {
    const data = err.response?.data;
    console.error('Surepass DigiLocker init error:', data);
    return res.status(422).json({
      error:  'Failed to initiate DigiLocker',
      detail: data?.message || err.message,
    });
  }

  if (!surepassData.success) {
    return res.status(422).json({
      error:  'Failed to initiate DigiLocker',
      detail: surepassData.message || 'Surepass error',
    });
  }

  const { url, client_id } = surepassData.data;

  const { error: dbError } = await supabase
    .from('tenant_verifications')
    .update({
      digilocker_client_id:    client_id || verification_id,
      digilocker_link:         url,
      digilocker_status:       'pending',
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
  });
}

// ── DIGILOCKER STATUS ────────────────────────────────────────────────────────
async function digilockerStatus(req, res) {
  const { verification_id } = req.body;

  if (!verification_id) {
    return res.status(400).json({ error: 'verification_id is required' });
  }

  // Fetch current record
  const { data: record, error: fetchError } = await supabase
    .from('tenant_verifications')
    .select('digilocker_client_id, pan_data, pan_verified, digilocker_status')
    .eq('id', verification_id)
    .single();

  if (fetchError || !record) {
    return res.status(404).json({ error: 'Verification record not found' });
  }

  if (!record.digilocker_client_id) {
    return res.status(400).json({ error: 'DigiLocker not yet initiated' });
  }

  // Already completed — return cached
  if (record.digilocker_status === 'completed') {
    return res.status(200).json({ success: true, status: 'completed', message: 'Already verified' });
  }

  let surepassData;
  try {
    const { data } = await axios.get(
      `https://kyc-api.surepass.app/api/v1/identity/digilocker/status/${record.digilocker_client_id}`,
      { headers: { 'Authorization': `Bearer ${process.env.SUREPASS_TOKEN}` } }
    );
    surepassData = data;
  } catch (err) {
    console.error('Surepass DigiLocker status error:', err.response?.data);
    return res.status(422).json({ error: 'Failed to check DigiLocker status' });
  }

  // Still waiting
  if (!surepassData.success || surepassData.data?.status === 'pending') {
    return res.status(200).json({ success: true, status: 'pending', message: 'Tenant has not completed consent yet.' });
  }

  const digiData = surepassData.data;

  const aadhaarInfo = {
    full_name:     digiData.name     || digiData.full_name || '',
    date_of_birth: digiData.dob      || digiData.date_of_birth || '',
    gender:        digiData.gender   || '',
    address:       digiData.address  || digiData.current_address || '',
    verified_at:   new Date().toISOString(),
  };

  // Cross-match PAN name vs Aadhaar name
  let nameMatchResult = { score: 0, status: 'not_checked' };
  if (record.pan_verified && record.pan_data?.full_name) {
    const score = nameMatchScore(record.pan_data.full_name, aadhaarInfo.full_name);
    nameMatchResult = {
      score,
      status:       score >= 60 ? 'matched' : 'mismatch',
      pan_name:     record.pan_data.full_name,
      aadhaar_name: aadhaarInfo.full_name,
    };
  }

  const kycComplete = record.pan_verified && nameMatchResult.status !== 'mismatch';

  await supabase
    .from('tenant_verifications')
    .update({
      digilocker_verified: true,
      digilocker_status:   'completed',
      digilocker_data:     aadhaarInfo,
      aadhaar_name:        aadhaarInfo.full_name,
      aadhaar_dob:         aadhaarInfo.date_of_birth,
      aadhaar_address:     aadhaarInfo.address,
      aadhaar_gender:      aadhaarInfo.gender,
      name_match_score:    nameMatchResult.score,
      name_match_status:   nameMatchResult.status,
      kyc_status:          kycComplete ? 'KYC_COMPLETE' : 'KYC_PARTIAL',
      kyc_completed_at:    kycComplete ? new Date().toISOString() : null,
    })
    .eq('id', verification_id);

  return res.status(200).json({
    success:    true,
    status:     'completed',
    kyc_status: kycComplete ? 'KYC_COMPLETE' : 'KYC_PARTIAL',
    data: {
      aadhaar_name:  aadhaarInfo.full_name,
      date_of_birth: aadhaarInfo.date_of_birth,
      gender:        aadhaarInfo.gender,
      address:       aadhaarInfo.address,
    },
    name_match: nameMatchResult,
  });
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function normaliseName(name = '') {
  return name.toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

function nameMatchScore(nameA = '', nameB = '') {
  const a = normaliseName(nameA).split(' ').filter(Boolean);
  const b = normaliseName(nameB).split(' ').filter(Boolean);
  if (!a.length || !b.length) return 0;
  const matches = a.filter(w => b.includes(w));
  return Math.round((matches.length / Math.max(a.length, b.length)) * 100);
}
