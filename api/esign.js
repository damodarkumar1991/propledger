// api/esign.js — Sequential Aadhaar eSign for PropLedger
// Flow: Landlord signs first → webhook → tenant gets landlord-signed PDF → tenant signs → both get final PDF

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const SUREPASS_BASE = 'https://kyc-api.surepass.app';
const BASE_URL = 'https://www.propledger.in';

function getSurepassHeaders() {
  return { 'Authorization': `Bearer ${process.env.SUREPASS_TOKEN}`, 'Content-Type': 'application/json' };
}

function getSupabaseAdmin() {
  return createClient(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUREPASS_TOKEN = process.env.SUREPASS_TOKEN;
  const urlPart = req.url.split('/').pop().split('?')[0];
  const action = (urlPart === 'esign' || !urlPart) ? (req.body?.action || 'create-request') : urlPart;

  if (!SUREPASS_TOKEN) {
    if (action === 'create-request') return res.json({ success: true, demo: true, documentId: 'DEMO-' + Date.now(), landlordToken: 'demo-landlord-token', status: 'initiated' });
    return res.json({ success: true, demo: true, status: 'pending' });
  }

  try {

    // ── CREATE REQUEST — LANDLORD ONLY ────────────────────────────────────────
    if (action === 'create-request') {
      const { agreementId, agreementText, agreementTitle, landlordName, landlordEmail, tenantName, tenantEmail, propertyAddress, monthlyRent } = req.body || {};

      if (!landlordEmail || !tenantEmail) return res.status(400).json({ error: 'Both email addresses are required' });

      // Generate PDF
      const pdfBase64 = await generateAgreementPDF(agreementText || '', { title: agreementTitle || 'Leave & License Agreement', landlordName, tenantName, propertyAddress, monthlyRent });
      const { PDFDocument } = require('pdf-lib');
      const pdfDoc = await PDFDocument.load(Buffer.from(pdfBase64, 'base64'));
      const totalPages = pdfDoc.getPageCount();

      // Upload PDF to Supabase
      const sbAdmin = getSupabaseAdmin();
      const fileName = `esign_${agreementId || Date.now()}.pdf`;
      const { error: uploadErr } = await sbAdmin.storage.from('agreements').upload(fileName, Buffer.from(pdfBase64, 'base64'), { contentType: 'application/pdf', upsert: true });
      if (uploadErr) return res.status(500).json({ error: 'Failed to upload PDF', details: uploadErr.message });

      const { data: urlData } = sbAdmin.storage.from('agreements').getPublicUrl(fileName);
      const pdfPublicUrl = urlData.publicUrl;

      // Signature positions for all pages (landlord = left side x:50)
      const landlordPositions = {};
      for (let p = 1; p <= totalPages; p++) { landlordPositions[p] = [{ x: 50, y: 50, width: 180, height: 50 }]; }

      const redirectUrl = `${BASE_URL}/esign.html?id=${agreementId}&signed=true`;

      // Initialize LANDLORD session ONLY
      const landlordInit = await axios.post(`${SUREPASS_BASE}/api/v1/esign/initialize`, {
        pdf_pre_uploaded: true, expiry_minutes: 10080, sign_type: 'aadhaar', redirect_url: redirectUrl, callback_url: `${BASE_URL}/api/esign?action=webhook`,
        config: { reason: `Signing Leave & License Agreement for ${propertyAddress || 'the property'}`, accept_virtual_sign: false, track_location: false, allow_download: true, skip_otp: false, skip_email: false, stamp_paper_amount: '', stamp_paper_state: '', stamp_data: {}, auth_mode: 1, positions: landlordPositions },
        prefill_options: { full_name: landlordName || '', user_email: landlordEmail }
      }, { headers: getSurepassHeaders(), timeout: 30000 });

      const landlordToken = landlordInit.data?.data?.client_id;
      const landlordUrl   = landlordInit.data?.data?.url;
      if (!landlordToken) return res.status(400).json({ error: 'Failed to create landlord signing session', details: landlordInit.data });

      // Attach PDF to landlord session
      await axios.post(`${SUREPASS_BASE}/api/v1/esign/upload-pdf`, { client_id: landlordToken, link: pdfPublicUrl }, { headers: getSurepassHeaders(), timeout: 30000 });

      // Save record — tenant session will be created by webhook after landlord signs
      await sbAdmin.from('esign_records').upsert({
        agreement_id: agreementId, landlord_email: landlordEmail, tenant_email: tenantEmail,
        tenant_name: tenantName, landlord_name: landlordName, property_address: propertyAddress,
        original_pdf_url: pdfPublicUrl, landlord_access_token: landlordToken,
        landlord_sign_url: landlordUrl || `https://esign-client.surepass.app/?token=${landlordToken}`,
        tenant_access_token: null, tenant_sign_url: null, status: 'initiated', total_pages: totalPages,
      }, { onConflict: 'agreement_id' });

      // Email LANDLORD only
      try {
        await axios.post(`${BASE_URL}/api/send-email`, { type: 'esign_invite', to: landlordEmail, data: { name: landlordName || 'Licensor', role: 'Landlord (Licensor)', signingUrl: landlordUrl || `https://esign-client.surepass.app/?token=${landlordToken}`, propertyAddress, otherParty: tenantName || 'Tenant' } });
      } catch (e) { console.error('Landlord email error:', e.message); }

      return res.json({ success: true, documentId: landlordToken, landlordToken, tenantToken: null, landlordSignUrl: landlordUrl || `https://esign-client.surepass.app/?token=${landlordToken}`, tenantSignUrl: null, status: 'initiated' });
    }

    // ── WEBHOOK — Sequential signing logic ───────────────────────────────────
    if (action === 'webhook') {
      const { client_id, status } = req.body || {};
      console.log('Webhook received:', { client_id, status });

      if (status !== 'ESIGN_COMPLETED' || !client_id) return res.json({ success: true });

      const sbAdmin = getSupabaseAdmin();
      const { data: record } = await sbAdmin.from('esign_records').select('*')
        .or(`landlord_access_token.eq.${client_id},tenant_access_token.eq.${client_id}`).maybeSingle();

      if (!record) { console.error('No record for client_id:', client_id); return res.json({ success: true }); }

      const isLandlord = record.landlord_access_token === client_id;
      const isTenant   = record.tenant_access_token   === client_id;

      // ── LANDLORD SIGNED ──────────────────────────────────────────────────
      if (isLandlord) {
        console.log('Landlord signed:', record.agreement_id);
        await sbAdmin.from('esign_records').update({ status: 'landlord_signed', landlord_signed_at: new Date().toISOString() }).eq('agreement_id', record.agreement_id);

        // Download landlord-signed PDF
        let tenantPdfUrl = record.original_pdf_url;
        try {
          const dlRes = await axios.get(`${SUREPASS_BASE}/api/v1/esign/download/${client_id}`, { headers: getSurepassHeaders(), responseType: 'arraybuffer', timeout: 30000 });
          const signedFileName = `esign_landlord_signed_${record.agreement_id}.pdf`;
          const { error: upErr } = await sbAdmin.storage.from('agreements').upload(signedFileName, Buffer.from(dlRes.data), { contentType: 'application/pdf', upsert: true });
          if (!upErr) {
            const { data: d } = sbAdmin.storage.from('agreements').getPublicUrl(signedFileName);
            tenantPdfUrl = d.publicUrl;
            await sbAdmin.from('esign_records').update({ landlord_signed_pdf_url: tenantPdfUrl }).eq('agreement_id', record.agreement_id);
            console.log('Landlord-signed PDF stored:', tenantPdfUrl);
          }
        } catch (e) { console.error('PDF download/upload failed (using original):', e.message); }

        // Create TENANT session with landlord-signed PDF
        const totalPages = record.total_pages || 5;
        const tenantPositions = {};
        for (let p = 1; p <= totalPages; p++) { tenantPositions[p] = [{ x: 320, y: 50, width: 180, height: 50 }]; }

        let tenantToken = null, tenantUrl = null;
        try {
          const tenantInit = await axios.post(`${SUREPASS_BASE}/api/v1/esign/initialize`, {
            pdf_pre_uploaded: true, expiry_minutes: 10080, sign_type: 'aadhaar',
            redirect_url: `${BASE_URL}/esign.html?id=${record.agreement_id}&signed=true&party=tenant`,
            callback_url: `${BASE_URL}/api/esign?action=webhook`,
            config: { reason: `Signing Leave & License Agreement for ${record.property_address || 'the property'}`, accept_virtual_sign: false, track_location: false, allow_download: true, skip_otp: false, skip_email: false, stamp_paper_amount: '', stamp_paper_state: '', stamp_data: {}, auth_mode: 1, positions: tenantPositions },
            prefill_options: { full_name: record.tenant_name || '', user_email: record.tenant_email }
          }, { headers: getSurepassHeaders(), timeout: 30000 });

          tenantToken = tenantInit.data?.data?.client_id;
          tenantUrl   = tenantInit.data?.data?.url;

          await axios.post(`${SUREPASS_BASE}/api/v1/esign/upload-pdf`, { client_id: tenantToken, link: tenantPdfUrl }, { headers: getSurepassHeaders(), timeout: 30000 });
          console.log('Tenant session created:', tenantToken);
        } catch (e) { console.error('Tenant session failed:', e.message); }

        if (tenantToken) {
          await sbAdmin.from('esign_records').update({ tenant_access_token: tenantToken, tenant_sign_url: tenantUrl || `https://esign-client.surepass.app/?token=${tenantToken}` }).eq('agreement_id', record.agreement_id);
        }

        // Email tenant with signing link (landlord-signed PDF attached)
        const tenantSignUrl = tenantUrl || `https://esign-client.surepass.app/?token=${tenantToken}`;
        try {
          await axios.post(`${BASE_URL}/api/send-email`, { type: 'esign_invite', to: record.tenant_email, data: { name: record.tenant_name || 'Licensee', role: 'Tenant (Licensee)', signingUrl: tenantSignUrl, propertyAddress: record.property_address, otherParty: record.landlord_name || 'Landlord', note: 'The landlord has already signed this agreement. Please review and add your Aadhaar signature to complete the process.' } });
          console.log('Tenant email sent:', record.tenant_email);
        } catch (e) { console.error('Tenant email error:', e.message); }

        return res.json({ success: true, message: 'Landlord signed. Tenant session created and email sent.' });
      }

      // ── TENANT SIGNED → Send final PDF to both ──────────────────────────
      if (isTenant) {
        console.log('Tenant signed:', record.agreement_id);
        const now = new Date().toISOString();
        await sbAdmin.from('esign_records').update({ status: 'completed', tenant_signed_at: now, completed_at: now }).eq('agreement_id', record.agreement_id);
        await sbAdmin.from('agreements').update({ status: 'esigned' }).eq('id', record.agreement_id);

        // Download final doubly-signed PDF
        let finalPdfUrl = null;
        try {
          const dlRes = await axios.get(`${SUREPASS_BASE}/api/v1/esign/download/${client_id}`, { headers: getSurepassHeaders(), responseType: 'arraybuffer', timeout: 30000 });
          const finalFileName = `esign_completed_${record.agreement_id}.pdf`;
          const { error: upErr } = await sbAdmin.storage.from('agreements').upload(finalFileName, Buffer.from(dlRes.data), { contentType: 'application/pdf', upsert: true });
          if (!upErr) {
            const { data: d } = sbAdmin.storage.from('agreements').getPublicUrl(finalFileName);
            finalPdfUrl = d.publicUrl;
            await sbAdmin.from('esign_records').update({ final_signed_pdf_url: finalPdfUrl }).eq('agreement_id', record.agreement_id);
            console.log('Final signed PDF stored:', finalPdfUrl);
          }
        } catch (e) { console.error('Final PDF download failed:', e.message); }

        // Email BOTH parties the final signed PDF
        const emailData = { propertyAddress: record.property_address, finalPdfUrl, completedAt: now };
        try {
          await axios.post(`${BASE_URL}/api/send-email`, { type: 'esign_complete', to: record.landlord_email, data: { ...emailData, name: record.landlord_name || 'Landlord', role: 'Landlord (Licensor)' } });
          await axios.post(`${BASE_URL}/api/send-email`, { type: 'esign_complete', to: record.tenant_email,   data: { ...emailData, name: record.tenant_name   || 'Tenant',   role: 'Tenant (Licensee)'   } });
          console.log('Completion emails sent to both parties');
        } catch (e) { console.error('Completion email error:', e.message); }

        return res.json({ success: true, message: 'Agreement fully signed. Emails sent to both parties.' });
      }

      return res.json({ success: true });
    }

    // ── STATUS CHECK ─────────────────────────────────────────────────────────
    if (action === 'status') {
      const documentId = req.query?.id || req.body?.documentId;
      if (!documentId) return res.status(400).json({ error: 'documentId required' });
      try {
        const r = await axios.get(`${SUREPASS_BASE}/api/v1/esign/status/${documentId}`, { headers: getSurepassHeaders(), timeout: 15000 });
        const allSigned = r.data?.data?.status === 'ESIGN_COMPLETED';
        return res.json({ success: true, status: r.data?.data?.status, allSigned });
      } catch (e) { return res.json({ success: false, status: 'unknown', error: e.message }); }
    }

    // ── DOWNLOAD ─────────────────────────────────────────────────────────────
    if (action === 'download') {
      const documentId = req.query?.id || req.body?.documentId;
      if (!documentId) return res.status(400).json({ error: 'documentId required' });
      const sbAdmin = getSupabaseAdmin();
      const { data: record } = await sbAdmin.from('esign_records').select('final_signed_pdf_url,landlord_signed_pdf_url')
        .or(`landlord_access_token.eq.${documentId},tenant_access_token.eq.${documentId}`).maybeSingle();
      const storedUrl = record?.final_signed_pdf_url || record?.landlord_signed_pdf_url;
      if (storedUrl) return res.redirect(storedUrl);
      try {
        const dlRes = await axios.get(`${SUREPASS_BASE}/api/v1/esign/download/${documentId}`, { headers: getSurepassHeaders(), responseType: 'arraybuffer', timeout: 30000 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=signed_agreement.pdf');
        return res.send(Buffer.from(dlRes.data));
      } catch (e) { return res.status(500).json({ error: 'Download failed: ' + e.message }); }
    }

    return res.status(404).json({ error: 'Unknown action: ' + action });

  } catch (error) {
    console.error('esign handler error:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

// ── PDF GENERATOR ─────────────────────────────────────────────────────────────
async function generateAgreementPDF(agreementText, meta) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pageW = 595, pageH = 841, marginL = 50, marginR = 50, marginTop = 60, marginBottom = 60;
  const maxWidth = pageW - marginL - marginR, lineHeight = 15, fontSize = 9.5;
  const cleanText = (agreementText || '').replace(/\*\*/g, '').replace(/━+/g, '---').trim();

  function wrapText(text, f, size, max) {
    const lines = [];
    for (const para of text.split('\n')) {
      if (para.trim() === '') { lines.push(''); continue; }
      const words = para.split(/\s+/); let current = '';
      for (const word of words) {
        const test = current ? current + ' ' + word : word;
        if (f.widthOfTextAtSize(test, size) > max && current) { lines.push(current); current = word; } else current = test;
      }
      if (current) lines.push(current);
    }
    return lines;
  }

  const bodyLines = wrapText(cleanText, font, fontSize, maxWidth);
  let page = doc.addPage([pageW, pageH]), y = pageH - marginTop;
  page.drawText(meta.title || 'Leave & License Agreement', { x: marginL, y, font: fontBold, size: 16, color: rgb(0.1, 0.1, 0.1) }); y -= 28;
  for (const line of [`Landlord: ${meta.landlordName || ''}   |   Tenant: ${meta.tenantName || ''}`, meta.propertyAddress || ''].filter(Boolean)) { page.drawText(line, { x: marginL, y, font, size: 9.5, color: rgb(0.3, 0.3, 0.3) }); y -= 16; }
  y -= 10;
  for (const line of bodyLines) {
    if (y < marginBottom + 40) { page.drawText('— PropLedger.in —', { x: pageW / 2 - 40, y: 25, font, size: 7, color: rgb(0.6, 0.6, 0.6) }); page = doc.addPage([pageW, pageH]); y = pageH - marginTop; }
    if (line === '') { y -= lineHeight * 0.6; continue; }
    page.drawText(line, { x: marginL, y, font: /^(\d+\.\s+[A-Z]|SCHEDULE|PART\s|RECITALS)/.test(line) ? fontBold : font, size: fontSize, color: rgb(0.1, 0.1, 0.1) }); y -= lineHeight;
  }
  if (y < marginBottom + 120) { page = doc.addPage([pageW, pageH]); y = pageH - marginTop; }
  y -= 30;
  page.drawText('SIGNED BY:', { x: marginL, y, font: fontBold, size: 10, color: rgb(0.2, 0.2, 0.2) }); y -= 30;
  page.drawText('LICENSOR', { x: marginL, y, font: fontBold, size: 9, color: rgb(0.3, 0.3, 0.3) }); y -= 14;
  page.drawText(meta.landlordName || '', { x: marginL, y, font, size: 9, color: rgb(0.2, 0.2, 0.2) }); y -= 12;
  page.drawLine({ start: { x: marginL, y }, end: { x: marginL + 180, y }, thickness: 0.5, color: rgb(0.5, 0.5, 0.5) }); y -= 12;
  page.drawText('Signature', { x: marginL, y, font, size: 7, color: rgb(0.5, 0.5, 0.5) });
  let ty = y + 38;
  page.drawText('LICENSEE', { x: 320, y: ty, font: fontBold, size: 9, color: rgb(0.3, 0.3, 0.3) }); ty -= 14;
  page.drawText(meta.tenantName || '', { x: 320, y: ty, font, size: 9, color: rgb(0.2, 0.2, 0.2) }); ty -= 12;
  page.drawLine({ start: { x: 320, y: ty }, end: { x: 500, y: ty }, thickness: 0.5, color: rgb(0.5, 0.5, 0.5) }); ty -= 12;
  page.drawText('Signature', { x: 320, y: ty, font, size: 7, color: rgb(0.5, 0.5, 0.5) });
  page.drawText('Generated by PropLedger — propledger.in', { x: pageW / 2 - 70, y: 25, font, size: 7, color: rgb(0.6, 0.6, 0.6) });
  return Buffer.from(await doc.save()).toString('base64');
}
