// api/signing-flow.js — PropLedger Sequential Signing Pipeline
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const SUREPASS_BASE = 'https://kyc-api.surepass.app';
const SUREPASS_TOKEN = process.env.SUREPASS_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const BASE_URL = process.env.BASE_URL || 'https://propledger.in';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const spHeaders = {
  'Authorization': `Bearer ${SUREPASS_TOKEN}`,
  'Content-Type': 'application/json'
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body;

  try {
    switch (action) {
      case 'prepare':
        return await preparePdf(req, res);
      case 'init-landlord':
        return await initLandlordSign(req, res);
      case 'landlord-signed':
        return await handleLandlordSigned(req, res);
      case 'tenant-signed':
        return await handleTenantSigned(req, res);
      case 'check-status':
        return await checkSignStatus(req, res);
      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error('Signing flow error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
};

// ─── STEP 1: PREPARE PDF ─────────────────────────────────
async function preparePdf(req, res) {
  const { agreement_id, stamp_pdf_url } = req.body;
  if (!agreement_id) return res.status(400).json({ error: 'Missing agreement_id' });

  const { data: agreement, error: agError } = await supabase
    .from('agreements').select('*').eq('id', agreement_id).maybeSingle();
  if (agError || !agreement) return res.status(404).json({ error: 'Agreement not found' });

  const pdfRes = await fetch(`${BASE_URL}/api/generate-agreement`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'generate-pdf', agreement_text: agreement.agreement_text, agreement_id })
  });

  let agreementPdfBuffer;
  if (pdfRes.ok) {
    const pdfData = await pdfRes.json();
    if (pdfData.pdf_url) {
      const dlRes = await fetch(pdfData.pdf_url);
      agreementPdfBuffer = Buffer.from(await dlRes.arrayBuffer());
    }
  }

  if (!agreementPdfBuffer) {
    const existingPath = `agreements/${agreement_id}.pdf`;
    const { data: existingUrl } = supabase.storage.from('agreements').getPublicUrl(existingPath);
    if (existingUrl?.publicUrl) {
      try {
        const dlRes = await fetch(existingUrl.publicUrl);
        if (dlRes.ok) agreementPdfBuffer = Buffer.from(await dlRes.arrayBuffer());
      } catch (e) { console.log('No existing PDF found'); }
    }
  }

  if (!agreementPdfBuffer) return res.status(400).json({ error: 'Could not get agreement PDF.' });

  let finalPdfBuffer = agreementPdfBuffer;

  if (stamp_pdf_url) {
    try {
      const { PDFDocument } = require('pdf-lib');
      const stampRes = await fetch(stamp_pdf_url);
      if (!stampRes.ok) throw new Error('Could not download stamp PDF');
      const stampBuffer = Buffer.from(await stampRes.arrayBuffer());
      const stampDoc = await PDFDocument.load(stampBuffer);
      const agreementDoc = await PDFDocument.load(agreementPdfBuffer);
      const mergedDoc = await PDFDocument.create();
      const stampPages = await mergedDoc.copyPages(stampDoc, stampDoc.getPageIndices());
      stampPages.forEach(page => mergedDoc.addPage(page));
      const agreementPages = await mergedDoc.copyPages(agreementDoc, agreementDoc.getPageIndices());
      agreementPages.forEach(page => mergedDoc.addPage(page));
      finalPdfBuffer = Buffer.from(await mergedDoc.save());
    } catch (mergeErr) { console.error('PDF merge failed:', mergeErr.message); }
  }

  const fileName = `signing/${agreement_id}_ready.pdf`;
  const { error: uploadError } = await supabase.storage.from('agreements')
    .upload(fileName, finalPdfBuffer, { contentType: 'application/pdf', upsert: true });
  if (uploadError) return res.status(500).json({ error: 'Failed to upload PDF' });

  const { data: urlData } = supabase.storage.from('agreements').getPublicUrl(fileName);
  await supabase.from('agreements').update({
    pdf_url: urlData.publicUrl, has_stamp: !!stamp_pdf_url, status: 'ready_for_signing'
  }).eq('id', agreement_id);

  return res.status(200).json({ success: true, pdf_url: urlData.publicUrl, has_stamp: !!stamp_pdf_url });
}

// ─── STEP 2: INIT LANDLORD ESIGN ─────────────────────────
async function initLandlordSign(req, res) {
  const { agreement_id, pdf_url, landlord_name, landlord_phone, landlord_email, tenant_name, tenant_email, property_address } = req.body;
  if (!agreement_id || !pdf_url || !landlord_name) return res.status(400).json({ error: 'Missing required fields' });

  // Upload PDF to Surepass
  await axios.post(`${SUREPASS_BASE}/api/v1/esign/upload-pdf`, {
    pdf_url, pdf_pre_uploaded: true
  }, { headers: spHeaders, timeout: 30000 });
  console.log('Landlord PDF uploaded to Surepass');

  // Initialize landlord session
  const signRes = await axios.post(`${SUREPASS_BASE}/api/v1/esign/initialize`, {
    pdf_pre_uploaded: true, pdf_url, sign_type: 'aadhaar', auth_mode: 1, expire_in_days: 7,
    config: { reason: 'Signing Leave & License Agreement as Licensor', positions: { 1: [{ x: 50, y: 700 }] } },
    prefill_options: {
      full_name: landlord_name,
      ...(landlord_phone && { mobile_number: landlord_phone }),
      ...(landlord_email && { user_email: landlord_email })
    }
  }, { headers: spHeaders, timeout: 30000 });

  const signData = signRes.data;
  console.log('Landlord eSign init:', JSON.stringify(signData));
  if (!signData.data) return res.status(400).json({ error: 'Failed to create landlord eSign session', details: signData.message });

  const landlordToken = signData.data.client_id;
  const rawUrl = signData.data.url || '';
  const landlordUrl = rawUrl.startsWith('http') ? rawUrl : `https://esign-client.surepass.app/?token=${rawUrl}&window_name=PropLedger%20eSign`;

  await supabase.from('esign_records').upsert({
    agreement_id, landlord_name, landlord_email, landlord_phone, tenant_name, tenant_email, property_address,
    landlord_client_id: landlordToken, landlord_sign_url: landlordUrl, status: 'landlord_pending',
    pdf_url, created_at: new Date().toISOString()
  }, { onConflict: 'agreement_id' }).select().maybeSingle();

  if (landlord_email && landlordUrl) {
    await sendSigningEmail({ to: landlord_email, name: landlord_name, role: 'Licensor (Landlord)', signingUrl: landlordUrl, propertyAddress: property_address, otherParty: tenant_name });
  }

  return res.status(200).json({ success: true, landlord_token: landlordToken, landlord_sign_url: landlordUrl, status: 'landlord_pending', message: 'Landlord eSign session created. Email sent.' });
}

// ─── STEP 3: LANDLORD SIGNED → CREATE TENANT SESSION ────
async function handleLandlordSigned(req, res) {
  const { agreement_id, landlord_client_id } = req.body;
  if (!agreement_id || !landlord_client_id) return res.status(400).json({ error: 'Missing agreement_id or landlord_client_id' });

  // Get signed PDF link from Surepass
  const docRes = await axios.get(`${SUREPASS_BASE}/api/v1/esign/get-signed-document/${landlord_client_id}`, { headers: spHeaders, timeout: 30000 });
  const docData = docRes.data;
  console.log('Get signed doc response:', JSON.stringify(docData));

  const signedPdfLink = docData.data?.url || docData.data?.link || docData.data?.pdf_url;
  if (!signedPdfLink) return res.status(400).json({ error: 'Could not get landlord-signed PDF link', details: docData.message });

  // Download the signed PDF
  const pdfRes = await fetch(signedPdfLink);
  if (!pdfRes.ok) return res.status(400).json({ error: 'Could not download landlord-signed PDF' });
  const signedPdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
  console.log(`Landlord-signed PDF downloaded: ${signedPdfBuffer.length} bytes`);

  // Upload to Supabase for our records
  const fileName = `signing/${agreement_id}_landlord_signed.pdf`;
  const { error: uploadError } = await supabase.storage.from('agreements')
    .upload(fileName, signedPdfBuffer, { contentType: 'application/pdf', upsert: true });
  if (uploadError) return res.status(500).json({ error: 'Failed to upload landlord-signed PDF' });

  const { data: urlData } = supabase.storage.from('agreements').getPublicUrl(fileName);
  const landlordSignedUrl = urlData.publicUrl;

  // Get tenant details
  const { data: signRecord } = await supabase.from('esign_records').select('*').eq('agreement_id', agreement_id).maybeSingle();
  if (!signRecord) return res.status(404).json({ error: 'Signing record not found' });

  // ── TENANT SESSION ──
  // Step A: Initialize tenant session
  const tenantInitRes = await axios.post(`${SUREPASS_BASE}/api/v1/esign/initialize`, {
    pdf_pre_uploaded: true,
    pdf_url: landlordSignedUrl,
    sign_type: 'aadhaar',
    auth_mode: 1,
    expire_in_days: 7,
    config: {
      reason: 'Signing Leave & License Agreement as Licensee',
      positions: { 1: [{ x: 350, y: 700 }] }
    },
    prefill_options: {
      full_name: signRecord.tenant_name || '',
      ...(signRecord.tenant_email && { user_email: signRecord.tenant_email })
    }
  }, { headers: spHeaders, timeout: 30000 });

  const tenantSignData = tenantInitRes.data;
  console.log('Tenant eSign init:', JSON.stringify(tenantSignData));
  if (!tenantSignData.data) return res.status(400).json({ error: 'Failed to create tenant eSign session', details: tenantSignData.message });

  const tenantToken = tenantSignData.data.client_id;

  // Step B: Attach PDF to tenant session (same pattern as working esign.js)
  const attachRes = await axios.post(`${SUREPASS_BASE}/api/v1/esign/upload-pdf`, {
    client_id: tenantToken,
    link: landlordSignedUrl
  }, { headers: spHeaders, timeout: 30000 });
  console.log('Tenant PDF attach response:', JSON.stringify(attachRes.data));

  const rawTenantUrl = tenantSignData.data.url || '';
  const tenantUrl = rawTenantUrl.startsWith('http')
    ? rawTenantUrl
    : `https://esign-client.surepass.app/?token=${rawTenantUrl}&window_name=PropLedger%20eSign`;

  // Update DB
  await supabase.from('esign_records').update({
    landlord_signed_at: new Date().toISOString(),
    landlord_signed_pdf_url: landlordSignedUrl,
    tenant_client_id: tenantToken,
    tenant_sign_url: tenantUrl,
    status: 'tenant_pending'
  }).eq('agreement_id', agreement_id);

  // Email tenant
  if (signRecord.tenant_email && tenantUrl) {
    await sendSigningEmail({
      to: signRecord.tenant_email, name: signRecord.tenant_name, role: 'Licensee (Tenant)',
      signingUrl: tenantUrl, propertyAddress: signRecord.property_address,
      otherParty: signRecord.landlord_name,
      message: `${signRecord.landlord_name} has signed the agreement. It's now your turn to sign.`
    });
  }

  return res.status(200).json({
    success: true, tenant_token: tenantToken, tenant_sign_url: tenantUrl,
    landlord_signed_pdf_url: landlordSignedUrl, status: 'tenant_pending',
    message: 'Landlord signature recorded. Tenant session created. Email sent.'
  });
}

// ─── STEP 4: TENANT SIGNED → FINAL PDF → EMAIL BOTH ─────
async function handleTenantSigned(req, res) {
  const { agreement_id, tenant_client_id } = req.body;
  if (!agreement_id || !tenant_client_id) return res.status(400).json({ error: 'Missing agreement_id or tenant_client_id' });

  const docRes = await axios.get(`${SUREPASS_BASE}/api/v1/esign/get-signed-document/${tenant_client_id}`, { headers: spHeaders, timeout: 30000 });
  const docData = docRes.data;
  const finalPdfLink = docData.data?.url || docData.data?.link || docData.data?.pdf_url;
  if (!finalPdfLink) return res.status(400).json({ error: 'Could not get final signed PDF link', details: docData.message });

  const pdfRes = await fetch(finalPdfLink);
  if (!pdfRes.ok) return res.status(400).json({ error: 'Could not download final signed PDF' });
  const finalPdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

  const fileName = `signing/${agreement_id}_final_signed.pdf`;
  const { error: uploadError } = await supabase.storage.from('agreements')
    .upload(fileName, finalPdfBuffer, { contentType: 'application/pdf', upsert: true });
  if (uploadError) return res.status(500).json({ error: 'Failed to upload final PDF' });

  const { data: urlData } = supabase.storage.from('agreements').getPublicUrl(fileName);
  const finalPdfUrl = urlData.publicUrl;

  const { data: signRecord } = await supabase.from('esign_records').select('*').eq('agreement_id', agreement_id).maybeSingle();

  await supabase.from('esign_records').update({ tenant_signed_at: new Date().toISOString(), final_pdf_url: finalPdfUrl, status: 'completed' }).eq('agreement_id', agreement_id);
  await supabase.from('agreements').update({ status: 'signed', signed_pdf_url: finalPdfUrl }).eq('id', agreement_id);

  if (signRecord) {
    const promises = [];
    if (signRecord.landlord_email) promises.push(sendFinalEmail({ to: signRecord.landlord_email, name: signRecord.landlord_name, role: 'Licensor', otherParty: signRecord.tenant_name, propertyAddress: signRecord.property_address, pdfUrl: finalPdfUrl }));
    if (signRecord.tenant_email) promises.push(sendFinalEmail({ to: signRecord.tenant_email, name: signRecord.tenant_name, role: 'Licensee', otherParty: signRecord.landlord_name, propertyAddress: signRecord.property_address, pdfUrl: finalPdfUrl }));
    await Promise.allSettled(promises);
  }

  return res.status(200).json({ success: true, final_pdf_url: finalPdfUrl, status: 'completed', message: 'Both parties have signed. Final PDF sent.' });
}

// ─── CHECK STATUS ────────────────────────────────────────
async function checkSignStatus(req, res) {
  const { agreement_id } = req.body;
  if (!agreement_id) return res.status(400).json({ error: 'Missing agreement_id' });

  const { data: signRecord } = await supabase.from('esign_records').select('*').eq('agreement_id', agreement_id).maybeSingle();
  if (!signRecord) return res.status(404).json({ error: 'No signing record found' });

  return res.status(200).json({
    success: true, status: signRecord.status,
    landlord_signed: !!signRecord.landlord_signed_at, landlord_signed_at: signRecord.landlord_signed_at,
    tenant_signed: !!signRecord.tenant_signed_at, tenant_signed_at: signRecord.tenant_signed_at,
    landlord_sign_url: signRecord.landlord_sign_url, tenant_sign_url: signRecord.tenant_sign_url,
    final_pdf_url: signRecord.final_pdf_url
  });
}

// ─── EMAIL HELPERS ───────────────────────────────────────
async function sendSigningEmail({ to, name, role, signingUrl, propertyAddress, otherParty, message }) {
  if (!RESEND_API_KEY) return;
  const html = `
    <div style="font-family:'Outfit',system-ui,sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
      <div style="background:#0a0f1e;padding:28px 32px;">
        <div style="font-size:22px;font-weight:700;color:#f8f6f0;">Prop<span style="color:#c9a84c;">Ledger</span></div>
      </div>
      <div style="padding:32px;">
        <h2 style="font-size:20px;color:#0a0f1e;margin:0 0 8px;">Your agreement is ready to sign</h2>
        <p style="color:#6B6B63;font-size:14px;line-height:1.6;margin:0 0 20px;">
          Hi ${name},<br><br>
          ${message || `A Leave & License agreement requires your signature as <strong>${role}</strong>.`}
        </p>
        ${propertyAddress ? `<div style="background:#f8f6f0;border-left:3px solid #c9a84c;padding:12px 16px;margin:0 0 20px;border-radius:0 8px 8px 0;">
          <div style="font-size:11px;color:#6B6B63;text-transform:uppercase;letter-spacing:0.5px;">Property</div>
          <div style="font-size:14px;color:#0a0f1e;font-weight:500;margin-top:2px;">${propertyAddress}</div>
          ${otherParty ? `<div style="font-size:12px;color:#6B6B63;margin-top:4px;">Other party: ${otherParty}</div>` : ''}
        </div>` : ''}
        <a href="${signingUrl}" style="display:inline-block;background:#c9a84c;color:#0a0f1e;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">
          Sign with Aadhaar →
        </a>
        <p style="color:#8892a4;font-size:12px;margin-top:20px;line-height:1.5;">
          This link expires in 7 days. You will need your Aadhaar-linked mobile number for OTP verification.
        </p>
      </div>
      <div style="background:#f8f6f0;padding:16px 32px;text-align:center;">
        <p style="color:#8892a4;font-size:11px;margin:0;">PropLedger · Smart property management for Indian landlords</p>
      </div>
    </div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'PropLedger <noreply@propledger.in>', to, subject: 'Sign your Leave & License agreement — PropLedger', html })
    });
    console.log(`Signing invite sent to ${to}`);
  } catch (err) { console.error('Email error:', err.message); }
}

async function sendFinalEmail({ to, name, role, otherParty, propertyAddress, pdfUrl }) {
  if (!RESEND_API_KEY) return;
  const html = `
    <div style="font-family:'Outfit',system-ui,sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
      <div style="background:#0a0f1e;padding:28px 32px;">
        <div style="font-size:22px;font-weight:700;color:#f8f6f0;">Prop<span style="color:#c9a84c;">Ledger</span></div>
      </div>
      <div style="padding:32px;">
        <div style="background:#E8F5EE;border:1px solid #B7E4CB;border-radius:8px;padding:14px 18px;margin:0 0 20px;display:flex;align-items:center;gap:10px;">
          <span style="font-size:20px;">✅</span>
          <span style="color:#1B4332;font-size:14px;font-weight:600;">Agreement signed by both parties</span>
        </div>
        <p style="color:#6B6B63;font-size:14px;line-height:1.6;margin:0 0 20px;">
          Hi ${name},<br><br>
          Your Leave & License agreement has been signed by both the Licensor and Licensee via Aadhaar eSign.
          The signed agreement is legally valid and enforceable.
        </p>
        ${propertyAddress ? `<div style="background:#f8f6f0;border-left:3px solid #2dd4a0;padding:12px 16px;margin:0 0 20px;border-radius:0 8px 8px 0;">
          <div style="font-size:11px;color:#6B6B63;text-transform:uppercase;letter-spacing:0.5px;">Property</div>
          <div style="font-size:14px;color:#0a0f1e;font-weight:500;margin-top:2px;">${propertyAddress}</div>
          <div style="font-size:12px;color:#6B6B63;margin-top:4px;">Your role: ${role} · Other party: ${otherParty}</div>
        </div>` : ''}
        <a href="${pdfUrl}" style="display:inline-block;background:#2dd4a0;color:#0a0f1e;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:600;">
          Download signed agreement →
        </a>
        <p style="color:#8892a4;font-size:12px;margin-top:20px;line-height:1.5;">
          Keep this PDF for your records. It contains Aadhaar-verified digital signatures from both parties.
        </p>
      </div>
      <div style="background:#f8f6f0;padding:16px 32px;text-align:center;">
        <p style="color:#8892a4;font-size:11px;margin:0;">PropLedger · Smart property management for Indian landlords</p>
      </div>
    </div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'PropLedger <noreply@propledger.in>', to, subject: '✅ Agreement signed — Download your copy · PropLedger', html })
    });
    console.log(`Final agreement sent to ${to}`);
  } catch (err) { console.error('Final email error:', err.message); }
}
