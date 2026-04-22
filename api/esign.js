// /api/esign.js — Surepass eSign Integration for PropLedger
// Replaces Digio. Uses Surepass hosted eSign popup + NSDL backend.
// Docs: https://github.com/surepassio/aadhaar-esign-web-sdk

const axios = require('axios');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUREPASS_TOKEN = process.env.SUREPASS_TOKEN;
  const SUREPASS_BASE  = process.env.SUREPASS_ENV === 'production'
    ? 'https://kyc-api.surepass.io'
    : 'https://sandbox.surepass.app';

  const headers = {
    'Authorization': `Bearer ${SUREPASS_TOKEN}`,
    'Content-Type':  'application/json'
  };

  // Resolve action from URL path or body
  const urlPart = req.url.split('/').pop().split('?')[0];
  const action = (urlPart === 'esign' || !urlPart)
    ? (req.body?.action || 'create-request')
    : urlPart;

  // ── DEMO MODE ──────────────────────────────────────────────────────────────
  if (!SUREPASS_TOKEN) {
    console.log('No SUREPASS_TOKEN — demo mode for action:', action);
    if (action === 'create-request') {
      return res.json({
        success: true, demo: true,
        documentId: 'DEMO-' + Date.now(),
        landlordToken: 'demo-landlord-token',
        tenantToken:   'demo-tenant-token',
        status: 'initiated'
      });
    }
    return res.json({ success: true, demo: true, status: 'pending' });
  }

  try {

    // ── CREATE SIGN REQUEST ───────────────────────────────────────────────────
    if (action === 'create-request') {
      const {
        agreementId, agreementText, agreementTitle,
        landlordName, landlordEmail,
        tenantName, tenantEmail,
        propertyAddress, monthlyRent
      } = req.body || {};

      if (!landlordEmail || !tenantEmail) {
        return res.status(400).json({ error: 'Both email addresses are required' });
      }

      // Generate PDF base64
      const pdfBase64 = generateAgreementPDF(agreementText || '', {
        title: agreementTitle || 'Leave & License Agreement',
        landlordName, tenantName, propertyAddress, monthlyRent
      });

      const BASE_URL = 'https://www.propledger.in';
      const redirectUrl = `${BASE_URL}/esign.html?id=${agreementId}&signed=true`;

      // Step 1: Upload PDF first, get a URL back
      let pdfUrl = null;
      try {
        const FormData = require('form-data');
        const pdfBuffer = Buffer.from(pdfBase64, 'base64');
        const form = new FormData();
        form.append('file', pdfBuffer, {
          filename: `PropLedger_Agreement_${agreementId || Date.now()}.pdf`,
          contentType: 'application/pdf',
          knownLength: pdfBuffer.length
        });

        const uploadRes = await axios.post(
          `${SUREPASS_BASE}/api/v1/esign/upload-pdf`,
          form,
          { headers: { ...headers, ...form.getHeaders() }, timeout: 30000 }
        );
        console.log('PDF upload response:', JSON.stringify(uploadRes.data));
        pdfUrl = uploadRes.data?.data?.file_url || uploadRes.data?.data?.pdf_url || uploadRes.data?.file_url;
      } catch (uploadErr) {
        console.error('PDF upload error:', uploadErr.response?.data || uploadErr.message);
        // If upload endpoint is different, fall back to base64 in payload
      }

      // Step 2: Initialize eSign for each signer
      // Correct payload based on Surepass actual API spec
      const makePayload = (name, email, xPos) => ({
        pdf_pre_uploaded: !!pdfUrl,
        ...(pdfUrl ? { pdf_url: pdfUrl } : { file_data: pdfBase64 }),
        expiry_minutes: 10080, // 7 days
        sign_type: 'aadhaar',
        redirect_url: redirectUrl,
        config: {
          reason: `Signing Leave & License Agreement for ${propertyAddress || 'the property'}`,
          accept_virtual_sign: false,
          track_location: false,
          allow_download: true,
          skip_otp: false,
          skip_email: false,
          stamp_paper_amount: '',
          stamp_paper_state: '',
          stamp_data: {},
          auth_mode: 1,
          positions: {
            1: [{ x: xPos, y: 100, width: 200, height: 60 }]
          }
        },
        prefill_options: {
          full_name: name || '',
          user_email: email
        }
      });

      console.log('Initializing eSign for landlord:', landlordEmail);
      let landlordToken = null;
      try {
        const r = await axios.post(
          `${SUREPASS_BASE}/api/v1/esign/initialize`,
          makePayload(landlordName, landlordEmail, 50),
          { headers, timeout: 30000 }
        );
        console.log('Landlord init:', JSON.stringify(r.data));
        landlordToken = r.data?.data?.client_id;
        if (!landlordToken) throw new Error(r.data?.message || 'No client_id in response');
      } catch (err) {
        const e = err.response?.data || { message: err.message };
        console.error('Landlord init error:', JSON.stringify(e));
        return res.status(400).json({ error: e.message || err.message, details: e });
      }

      console.log('Initializing eSign for tenant:', tenantEmail);
      let tenantToken = null;
      try {
        const r = await axios.post(
          `${SUREPASS_BASE}/api/v1/esign/initialize`,
          makePayload(tenantName, tenantEmail, 320),
          { headers, timeout: 30000 }
        );
        console.log('Tenant init:', JSON.stringify(r.data));
        tenantToken = r.data?.data?.client_id;
      } catch (err) {
        console.error('Tenant init error (non-fatal):', err.response?.data || err.message);
      }

      const landlordSignUrl = `https://esign-client.surepass.app/?token=${landlordToken}`;
      const tenantSignUrl = tenantToken ? `https://esign-client.surepass.app/?token=${tenantToken}` : null;

      // Step 3: Email both parties
      try {
        await axios.post(`${BASE_URL}/api/send-email`, {
          type: 'esign_invite', to: landlordEmail,
          data: { name: landlordName || 'Licensor', role: 'Landlord (Licensor)', signingUrl: landlordSignUrl, propertyAddress, otherParty: tenantName || 'Tenant' }
        });
        if (tenantSignUrl) {
          await axios.post(`${BASE_URL}/api/send-email`, {
            type: 'esign_invite', to: tenantEmail,
            data: { name: tenantName || 'Licensee', role: 'Tenant (Licensee)', signingUrl: tenantSignUrl, propertyAddress, otherParty: landlordName || 'Landlord' }
          });
        }
        console.log('eSign emails sent to:', landlordEmail, tenantEmail);
      } catch (emailErr) {
        console.error('Email error (non-fatal):', emailErr.message);
      }

      return res.json({
        success: true,
        documentId: landlordToken,
        landlordToken,
        tenantToken,
        landlordSignUrl,
        tenantSignUrl,
        emailsSent: true,
        status: 'initiated'
      });
    }

    // ── STATUS CHECK ─────────────────────────────────────────────────────────
    if (action === 'status') {
      const documentId = req.query?.id || req.body?.documentId;
      if (!documentId) return res.status(400).json({ error: 'documentId required' });

      try {
        const statusRes = await axios.get(
          `${SUREPASS_BASE}/api/v1/esign/status/${documentId}`,
          { headers, timeout: 15000 }
        );
        const d = statusRes.data;
        const allSigned = d.data?.status === 'ESIGN_COMPLETED';
        return res.json({
          success: true,
          status: d.data?.status,
          allSigned,
          landlordSigned: allSigned,
          raw: d.data
        });
      } catch (err) {
        return res.json({ success: false, status: 'unknown', error: err.message });
      }
    }

    // ── DOWNLOAD ─────────────────────────────────────────────────────────────
    if (action === 'download') {
      const documentId = req.query?.id || req.body?.documentId;
      if (!documentId) return res.status(400).json({ error: 'documentId required' });

      try {
        const dlRes = await axios.get(
          `${SUREPASS_BASE}/api/v1/esign/download/${documentId}`,
          { headers, responseType: 'arraybuffer', timeout: 30000 }
        );
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=signed_agreement_${documentId}.pdf`);
        return res.send(Buffer.from(dlRes.data));
      } catch (err) {
        return res.status(500).json({ error: 'Download failed: ' + err.message });
      }
    }

    // ── WEBHOOK (Surepass callback) ──────────────────────────────────────────
    if (action === 'webhook') {
      const { client_id, status } = req.body || {};
      console.log('Surepass webhook:', client_id, status);

      if (status === 'ESIGN_COMPLETED' && client_id) {
        const { createClient } = require('@supabase/supabase-js');
        const sb = createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_ANON_KEY
        );
        await sb.from('esign_records')
          .update({ status: 'completed', signed_at: new Date().toISOString() })
          .or(`landlord_access_token.eq.${client_id},tenant_access_token.eq.${client_id}`);
      }
      return res.json({ success: true });
    }

    return res.status(404).json({ error: 'Unknown action: ' + action });

  } catch (error) {
    console.error('esign handler error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

// ── PDF GENERATOR ─────────────────────────────────────────────────────────────
function generateAgreementPDF(agreementText, meta) {
  const title = meta.title || 'Leave & License Agreement';
  const landlord = (meta.landlordName || 'Licensor').replace(/[()\\]/g, '');
  const tenant = (meta.tenantName || 'Licensee').replace(/[()\\]/g, '');
  const address = (meta.propertyAddress || '').replace(/[()\\]/g, '').slice(0, 80);
  const rent = meta.monthlyRent ? `Rs.${parseInt(meta.monthlyRent).toLocaleString()}` : '';

  const cleanText = (agreementText || '')
    .replace(/[^\x20-\x7E\n]/g, ' ')
    .replace(/[()\\]/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/━+/g, '---')
    .trim();

  const words = cleanText.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const word of words) {
    if ((cur + ' ' + word).trim().length <= 85) {
      cur = (cur + ' ' + word).trim();
    } else {
      if (cur) lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);

  const lineH = 14.4;
  const marginTop = 780;
  const marginBottom = 50;

  let stream = '';
  stream += `BT\n/F1 14 Tf\n100 810 Td\n(${title}) Tj\n`;
  stream += `/F1 10 Tf\n0 -22 Td\n(Landlord: ${landlord}   Tenant: ${tenant}) Tj\n`;
  stream += `/F1 10 Tf\n0 -14 Td\n(Property: ${address}) Tj\n`;
  if (rent) stream += `0 -14 Td\n(Monthly Rent: ${rent}) Tj\n`;
  stream += `ET\n0.5 w\n50 755 m\n545 755 l\nS\n`;
  stream += `BT\n/F1 9 Tf\n50 740 Td\n`;
  for (const line of lines) {
    stream += `(${line}) Tj\n0 -${lineH} Td\n`;
  }
  stream += `ET\n`;
  // Signature boxes
  stream += `BT\n/F1 10 Tf\n50 100 Td\n`;
  stream += `(Licensor: ______________________) Tj\n`;
  stream += `300 0 Td\n(Licensee: ______________________) Tj\nET\n`;
  stream += `BT\n/F1 8 Tf\n180 30 Td\n(Generated by PropLedger - propledger.in) Tj\nET\n`;

  const streamLen = Buffer.byteLength(stream, 'latin1');
  const parts = ['%PDF-1.4\n'];
  const o1 = parts.join('').length;
  parts.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  const o2 = parts.join('').length;
  parts.push(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
  const o3 = parts.join('').length;
  parts.push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 841] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`);
  const o4 = parts.join('').length;
  parts.push(`4 0 obj\n<< /Length ${streamLen} >>\nstream\n${stream}\nendstream\nendobj\n`);
  const o5 = parts.join('').length;
  parts.push(`5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`);
  const xrefOff = parts.join('').length;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  [o1, o2, o3, o4, o5].forEach(o => { xref += String(o).padStart(10,'0') + ' 00000 n \n'; });
  parts.push(xref);
  parts.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`);
  return Buffer.from(parts.join(''), 'latin1').toString('base64');
}
