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
  const SUREPASS_BASE = 'https://kyc-api.surepass.app';

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
      const pdfBase64 = await generateAgreementPDF(agreementText || '', {
        title: agreementTitle || 'Leave & License Agreement',
        landlordName, tenantName, propertyAddress, monthlyRent
      });

      const BASE_URL = 'https://www.propledger.in';
      const redirectUrl = `${BASE_URL}/esign.html?id=${agreementId}&signed=true`;

    // Step 1: Upload PDF to Supabase Storage, get a public URL
      const { createClient } = require('@supabase/supabase-js');
      const sbAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const fileName = `esign_${agreementId || Date.now()}.pdf`;

      const { error: uploadErr } = await sbAdmin.storage
        .from('agreements')
        .upload(fileName, pdfBuffer, {
          contentType: 'application/pdf',
          upsert: true
        });

      if (uploadErr) {
        console.error('Supabase storage upload error:', uploadErr);
        return res.status(500).json({ error: 'Failed to upload agreement PDF', details: uploadErr.message });
      }

      const { data: urlData } = sbAdmin.storage.from('agreements').getPublicUrl(fileName);
      const pdfPublicUrl = urlData.publicUrl;
      console.log('PDF uploaded to Supabase:', pdfPublicUrl);

      // Step 2: Initialize eSign for each signer
      // Correct payload based on Surepass actual API spec
      const makePayload = (name, email, xPos) => ({
        pdf_pre_uploaded: true,
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
      let landlordUrl = null;
      try {
        const r = await axios.post(
          `${SUREPASS_BASE}/api/v1/esign/initialize`,
          makePayload(landlordName, landlordEmail, 50),
          { headers, timeout: 30000 }
        );
        console.log('Landlord init:', JSON.stringify(r.data));
        landlordToken = r.data?.data?.client_id;
        landlordUrl = r.data?.data?.url;
        // Attach PDF to this session
        await axios.post(`${SUREPASS_BASE}/api/v1/esign/upload-pdf`, {
          client_id: landlordToken,
          link: pdfPublicUrl
        }, { headers, timeout: 30000 });
        console.log('PDF attached to landlord session');
        if (!landlordToken) throw new Error(r.data?.message || 'No client_id in response');
      } catch (err) {
        const e = err.response?.data || { message: err.message };
        console.error('Landlord init error:', JSON.stringify(e));
        return res.status(400).json({ error: e.message || err.message, details: e });
      }

      console.log('Initializing eSign for tenant:', tenantEmail);
      let tenantToken = null;
      let tenantUrl = null;
      try {
        const r = await axios.post(
          `${SUREPASS_BASE}/api/v1/esign/initialize`,
          makePayload(tenantName, tenantEmail, 320),
          { headers, timeout: 30000 }
        );
        console.log('Tenant init:', JSON.stringify(r.data));
        tenantToken = r.data?.data?.client_id;
        tenantUrl = r.data?.data?.url;
        // Attach PDF to tenant session
        await axios.post(`${SUREPASS_BASE}/api/v1/esign/upload-pdf`, {
          client_id: tenantToken,
          link: pdfPublicUrl
        }, { headers, timeout: 30000 });
        console.log('PDF attached to tenant session');
      } catch (err) {
        console.error('Tenant init error (non-fatal):', err.response?.data || err.message);
      }

      const landlordSignUrl = landlordUrl || `https://esign-client.surepass.app/?token=${landlordToken}`;
      const tenantSignUrl = tenantUrl || (tenantToken ? `https://esign-client.surepass.app/?token=${tenantToken}` : null);

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
// ── PDF GENERATOR (pdf-lib) ───────────────────────────────────────────────────
async function generateAgreementPDF(agreementText, meta) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const pageW = 595;   // A4
  const pageH = 841;
  const marginL = 50;
  const marginR = 50;
  const marginTop = 60;
  const marginBottom = 60;
  const maxWidth = pageW - marginL - marginR;
  const lineHeight = 15;
  const fontSize = 9.5;
  const titleSize = 16;
  const subSize = 10;

  const title = meta.title || 'Leave & License Agreement';
  const landlord = meta.landlordName || 'Licensor';
  const tenant = meta.tenantName || 'Licensee';
  const address = meta.propertyAddress || '';
  const rent = meta.monthlyRent ? 'Rs. ' + parseInt(meta.monthlyRent).toLocaleString('en-IN') : '';

  // Clean agreement text
  const cleanText = (agreementText || '')
    .replace(/\*\*/g, '')
    .replace(/━+/g, '---')
    .trim();

  // Word-wrap helper
  function wrapText(text, f, size, max) {
    const lines = [];
    const paragraphs = text.split('\n');
    for (const para of paragraphs) {
      if (para.trim() === '') { lines.push(''); continue; }
      const words = para.split(/\s+/);
      let current = '';
      for (const word of words) {
        const test = current ? current + ' ' + word : word;
        const w = f.widthOfTextAtSize(test, size);
        if (w > max && current) {
          lines.push(current);
          current = word;
        } else {
          current = test;
        }
      }
      if (current) lines.push(current);
    }
    return lines;
  }

  // Wrap all content lines
  const bodyLines = wrapText(cleanText, font, fontSize, maxWidth);

  // Draw pages
  let page = doc.addPage([pageW, pageH]);
  let y = pageH - marginTop;

  // ── HEADER (first page only) ──
  page.drawText(title, { x: marginL, y, font: fontBold, size: titleSize, color: rgb(0.1, 0.1, 0.1) });
  y -= 24;

  page.drawLine({ start: { x: marginL, y: y + 4 }, end: { x: pageW - marginR, y: y + 4 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  y -= 18;

  const details = [
    `Landlord: ${landlord}    |    Tenant: ${tenant}`,
    address ? `Property: ${address}` : '',
    rent ? `Monthly Rent: ${rent}` : ''
  ].filter(Boolean);

  for (const line of details) {
    page.drawText(line, { x: marginL, y, font: font, size: subSize, color: rgb(0.3, 0.3, 0.3) });
    y -= 16;
  }

  y -= 8;
  page.drawLine({ start: { x: marginL, y: y + 4 }, end: { x: pageW - marginR, y: y + 4 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  y -= 20;

  // ── BODY ──
  for (const line of bodyLines) {
    if (y < marginBottom + 40) {
      // Footer on current page
      page.drawText('— PropLedger.in —', {
        x: pageW / 2 - 40, y: 25, font: font, size: 7, color: rgb(0.6, 0.6, 0.6)
      });
      // New page
      page = doc.addPage([pageW, pageH]);
      y = pageH - marginTop;
    }

    if (line === '') {
      y -= lineHeight * 0.6;
      continue;
    }

    // Detect section headers (lines in ALL CAPS or starting with number + period)
    const isHeader = /^(\d+\.\s+[A-Z]|SCHEDULE|PART\s|RECITALS|WITNESS)/.test(line);

    page.drawText(line, {
      x: marginL,
      y,
      font: isHeader ? fontBold : font,
      size: isHeader ? fontSize + 0.5 : fontSize,
      color: rgb(0.1, 0.1, 0.1)
    });
    y -= lineHeight;
  }

  // ── SIGNATURE BLOCK ──
  if (y < marginBottom + 120) {
    page = doc.addPage([pageW, pageH]);
    y = pageH - marginTop;
  }

  y -= 30;
  page.drawLine({ start: { x: marginL, y: y + 10 }, end: { x: pageW - marginR, y: y + 10 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  y -= 20;

  page.drawText('SIGNED BY:', { x: marginL, y, font: fontBold, size: 10, color: rgb(0.2, 0.2, 0.2) });
  y -= 30;

  // Landlord signature
  page.drawText('LICENSOR', { x: marginL, y, font: fontBold, size: 9, color: rgb(0.3, 0.3, 0.3) });
  y -= 14;
  page.drawText(landlord, { x: marginL, y, font: font, size: 9, color: rgb(0.2, 0.2, 0.2) });
  y -= 12;
  page.drawLine({ start: { x: marginL, y }, end: { x: marginL + 180, y }, thickness: 0.5, color: rgb(0.5, 0.5, 0.5) });
  y -= 12;
  page.drawText('Signature', { x: marginL, y, font: font, size: 7, color: rgb(0.5, 0.5, 0.5) });

  // Tenant signature
  let ty = y + 38;
  page.drawText('LICENSEE', { x: 320, y: ty, font: fontBold, size: 9, color: rgb(0.3, 0.3, 0.3) });
  ty -= 14;
  page.drawText(tenant, { x: 320, y: ty, font: font, size: 9, color: rgb(0.2, 0.2, 0.2) });
  ty -= 12;
  page.drawLine({ start: { x: 320, y: ty }, end: { x: 500, y: ty }, thickness: 0.5, color: rgb(0.5, 0.5, 0.5) });
  ty -= 12;
  page.drawText('Signature', { x: 320, y: ty, font: font, size: 7, color: rgb(0.5, 0.5, 0.5) });

  // Footer on last page
  page.drawText('Generated by PropLedger — propledger.in', {
    x: pageW / 2 - 70, y: 25, font: font, size: 7, color: rgb(0.6, 0.6, 0.6)
  });

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes).toString('base64');
}
