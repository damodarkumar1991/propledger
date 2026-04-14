// /api/esign.js — Digio eSign Integration for PropLedger
// Handles: create-request, webhook, download
// Uses Digio's hosted signing UI — no custom OTP needed

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const DIGIO_CLIENT_ID     = process.env.DIGIO_CLIENT_ID;
  const DIGIO_CLIENT_SECRET = process.env.DIGIO_CLIENT_SECRET;
  const DIGIO_ENV           = process.env.DIGIO_ENV || 'production';

  // Digio base URLs
  const BASE = DIGIO_ENV === 'sandbox'
    ? 'https://ext.digio.in:444'
    : 'https://api.digio.in';
  
  // Also try without port if above fails - some environments block non-standard ports
  const BASE_ALT = DIGIO_ENV === 'sandbox'
    ? 'https://ext.digio.in'
    : 'https://api.digio.in';

  const auth = (DIGIO_CLIENT_ID && DIGIO_CLIENT_SECRET)
    ? 'Basic ' + Buffer.from(`${DIGIO_CLIENT_ID}:${DIGIO_CLIENT_SECRET}`).toString('base64')
    : null;

  // Action can come from URL path (/api/esign/create-request)
  // OR from request body ({action: 'create-request'}) when called as /api/esign
  const urlAction = req.url.split('/').pop().split('?')[0];
  const action = (urlAction === 'esign' || !urlAction)
    ? (req.body?.action || 'create-request')
    : urlAction;

  // ── DEMO MODE: no credentials configured ────────────────────────────────
  if (!auth) {
    if (action === 'create-request') {
      const { agreementId } = req.body || {};
      return res.json({
        success: true,
        demo: true,
        documentId: 'DEMO_DOC_' + Date.now(),
        landlordSignUrl: `https://www.propledger.in/esign.html?id=${agreementId}&mode=demo&role=landlord`,
        tenantSignUrl: `https://www.propledger.in/esign.html?id=${agreementId}&mode=demo&role=tenant`,
        message: 'Demo mode — add DIGIO_CLIENT_ID and DIGIO_CLIENT_SECRET to enable real signing'
      });
    }
    if (action === 'status') {
      return res.json({ success: true, status: 'demo', signed: false });
    }
    return res.json({ success: true, demo: true });
  }

  // ── LIVE MODE ────────────────────────────────────────────────────────────
  try {

    // ── CREATE SIGN REQUEST ──────────────────────────────────────────────
    if (action === 'create-request') {
      // Accepts POST (and GET for testing)

      const {
        agreementId, agreementText, agreementTitle,
        landlordName, landlordEmail,
        tenantName, tenantEmail,
        propertyAddress, monthlyRent
      } = req.body;

      if (!landlordEmail || !tenantEmail) {
        return res.status(400).json({ error: 'Both landlord and tenant email required' });
      }

      // Convert agreement text to PDF (base64)
      // We generate a clean HTML → PDF using a simple approach
      const pdfBase64 = generateAgreementPDF(agreementText || '', {
        title: agreementTitle || 'Leave & License Agreement',
        landlordName, tenantName, propertyAddress, monthlyRent
      });

      const digioPayload = {
        file_name: `PropLedger_Agreement_${agreementId || Date.now()}.pdf`,
        signers: [
          {
            identifier: landlordEmail,
            name: landlordName || 'Licensor',
            reason: 'Signing as Licensor (Landlord)',
            sign_type: 'aadhaar'
          },
          {
            identifier: tenantEmail,
            name: tenantName || 'Licensee',
            reason: 'Signing as Licensee (Tenant)',
            sign_type: 'aadhaar'
          }
        ],
        expire_in_days: 30,
        notify_signers: true,
        send_sign_link: true,
        display_on_page: 'all',
        message: `Please sign the Leave & License Agreement for ${propertyAddress || 'the property'} on PropLedger.`
      };

      console.log('Digio request URL:', `${BASE}/v2/client/document/upload`);

      // Use axios + form-data — most reliable for multipart in Node serverless
      const axios = require('axios');
      const FormDataLib = require('form-data');

      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const form = new FormDataLib();

      form.append('file', pdfBuffer, {
        filename: digioPayload.file_name,
        contentType: 'application/pdf',
        knownLength: pdfBuffer.length
      });
      form.append('file_name', digioPayload.file_name);
      form.append('signers', JSON.stringify(digioPayload.signers));
      form.append('expire_in_days', String(digioPayload.expire_in_days));
      form.append('notify_signers', String(digioPayload.notify_signers));
      form.append('send_sign_link', String(digioPayload.send_sign_link));
      form.append('display_on_page', 'all');
      form.append('message', digioPayload.message);

      console.log('Form headers:', JSON.stringify(form.getHeaders()));
      console.log('PDF buffer size:', pdfBuffer.length);

      let axiosRes;
      try {
        axiosRes = await axios.post(
          `${BASE}/v2/client/document/upload`,
          form,
          {
            headers: {
              'Authorization': auth,
              ...form.getHeaders()
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 30000
          }
        );
      } catch (axiosErr) {
        const errData = axiosErr.response?.data || axiosErr.message;
        console.error('Axios error:', JSON.stringify(errData));
        return res.status(400).json({
          error: axiosErr.response?.data?.message || axiosErr.message,
          digio_status: axiosErr.response?.status,
          details: axiosErr.response?.data
        });
      }

      console.log('Digio status:', axiosRes.status);
      console.log('Digio response:', JSON.stringify(axiosRes.data));

      const uploadData = axiosRes.data;

      if (!uploadData.id) {
        console.error('Digio upload failed:', JSON.stringify(uploadData));
        return res.status(400).json({
          error: uploadData.message || uploadData.error || 'Digio upload failed',
          digio_response: uploadData,
          digio_response: uploadData,
          details: uploadData
        });
      }

      const documentId = uploadData.id;

      // Step 2: Get signing URLs for each party
      const landlordSigner = uploadData.signing_parties?.find(
        s => s.identifier === landlordEmail
      );
      const tenantSigner = uploadData.signing_parties?.find(
        s => s.identifier === tenantEmail
      );

      // Build Digio Web SDK URLs
      const landlordSignUrl = landlordSigner?.access_token
        ? buildDigioSignUrl(documentId, landlordEmail, landlordSigner.access_token, DIGIO_ENV)
        : null;
      const tenantSignUrl = tenantSigner?.access_token
        ? buildDigioSignUrl(documentId, tenantEmail, tenantSigner.access_token, DIGIO_ENV)
        : null;

      return res.json({
        success: true,
        documentId,
        landlordSignUrl,
        tenantSignUrl,
        landlordAccessToken: landlordSigner?.access_token,
        tenantAccessToken: tenantSigner?.access_token,
        status: 'pending',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      });
    }

    // ── GET STATUS ───────────────────────────────────────────────────────
    if (action === 'status') {
      const documentId = req.query?.id || req.body?.documentId;
      if (!documentId) return res.status(400).json({ error: 'documentId required' });

      const statusRes = await fetch(`${BASE}/v2/client/document/${documentId}`, {
        headers: { 'Authorization': auth }
      });
      const statusData = await statusRes.json();

      const allSigned = statusData.signing_parties?.every(p => p.status === 'signed');
      const landlordSigned = statusData.signing_parties?.find(
        s => s.role === 'landlord' || statusData.signing_parties?.indexOf(s) === 0
      )?.status === 'signed';

      return res.json({
        success: true,
        documentId,
        status: statusData.status,
        allSigned,
        landlordSigned,
        signers: statusData.signing_parties?.map(s => ({
          name: s.name,
          identifier: s.identifier,
          status: s.status,
          signedAt: s.signing_time
        }))
      });
    }

    // ── DOWNLOAD SIGNED PDF ──────────────────────────────────────────────
    if (action === 'download') {
      const documentId = req.query?.id || req.body?.documentId;
      if (!documentId) return res.status(400).json({ error: 'documentId required' });

      const dlRes = await fetch(`${BASE}/v2/client/document/${documentId}/download`, {
        headers: { 'Authorization': auth }
      });

      if (!dlRes.ok) {
        return res.status(400).json({ error: 'Failed to download document' });
      }

      const buffer = await dlRes.arrayBuffer();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="signed_agreement_${documentId}.pdf"`);
      return res.send(Buffer.from(buffer));
    }

    // ── WEBHOOK (Digio calls this when all parties sign) ─────────────────
    if (action === 'webhook') {
      const event = req.body;
      console.log('Digio webhook:', JSON.stringify(event));

      if (event?.event === 'sign_request.signed' || event?.event === 'document.signed') {
        const documentId = event?.document_id || event?.id;

        // Update Supabase — mark agreement as fully esigned
        if (documentId) {
          try {
            const { createClient } = require('@supabase/supabase-js');
            const sb = createClient(
              process.env.SUPABASE_URL,
              process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
            );
            await sb.from('esign_records')
              .update({
                status: 'completed',
                completed_at: new Date().toISOString(),
                digio_document_id: documentId
              })
              .eq('digio_document_id', documentId);

            await sb.from('agreements')
              .update({ status: 'esigned' })
              .eq('digio_document_id', documentId);
          } catch (e) {
            console.error('Supabase update error:', e);
          }
        }
      }

      return res.json({ success: true });
    }

    return res.status(404).json({ error: 'Unknown action: ' + action });

  } catch (error) {
    console.error('eSign API error:', error);
    return res.status(500).json({
      error: 'eSign service error',
      message: error.message
    });
  }
};

// ── HELPERS ─────────────────────────────────────────────────────────────────

function buildDigioSignUrl(documentId, identifier, accessToken, env) {
  const base = env === 'sandbox'
    ? 'https://ext.digio.in:444'
    : 'https://app.digio.in';
  return `${base}/#/gateway/login/${documentId}/${accessToken}/${encodeURIComponent(identifier)}`;
}

function generateAgreementPDF(agreementText, meta) {
  // Generate a valid minimal PDF using raw PDF syntax
  // No external libraries needed — works in Vercel serverless

  const title = meta.title || 'Leave & License Agreement';
  const landlord = (meta.landlordName || 'Licensor').replace(/[()\\]/g, '');
  const tenant = (meta.tenantName || 'Licensee').replace(/[()\\]/g, '');
  const address = (meta.propertyAddress || '').replace(/[()\\]/g, '').slice(0, 80);
  const rent = meta.monthlyRent ? `Rs.${parseInt(meta.monthlyRent).toLocaleString()}` : '';

  // Clean and chunk the agreement text into PDF-safe lines
  const cleanText = (agreementText || '')
    .replace(/[^\x20-\x7E\n]/g, ' ')  // ASCII only
    .replace(/[()\\]/g, ' ')           // Remove PDF special chars
    .replace(/\*\*/g, '')              // Remove markdown bold
    .replace(/━+/g, '---')            // Replace unicode bars
    .trim();

  const words = cleanText.split(/\s+/);
  const lines = [];
  let currentLine = '';
  const maxChars = 85;

  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length <= maxChars) {
      currentLine = (currentLine + ' ' + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  // Build PDF content stream
  const fontSize = 9;
  const lineHeight = fontSize * 1.6;
  const pageHeight = 841; // A4
  const marginTop = 780;
  const marginBottom = 50;
  const linesPerPage = Math.floor((marginTop - marginBottom) / lineHeight);

  let streamContent = '';
  // Header
  streamContent += `BT\n/F1 14 Tf\n100 810 Td\n(${title}) Tj\n`;
  streamContent += `/F1 10 Tf\n0 -22 Td\n(Landlord: ${landlord}   Tenant: ${tenant}) Tj\n`;
  streamContent += `0 -14 Td\n(Property: ${address}) Tj\n`;
  if (rent) streamContent += `0 -14 Td\n(Monthly Rent: ${rent}) Tj\n`;
  streamContent += `ET\n`;

  // Draw separator line
  streamContent += `0.5 w\n50 755 m\n545 755 l\nS\n`;

  // Agreement text lines
  let y = 740;
  streamContent += `BT\n/F1 ${fontSize} Tf\n50 ${y} Td\n`;

  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i % linesPerPage === 0) {
      // Simple page break handling - just continue on same page for now
      // Full multi-page support would need more complex PDF structure
    }
    streamContent += `(${lines[i]}) Tj\n0 -${lineHeight} Td\n`;
  }

  // Signature block
  streamContent += `ET\n`;
  streamContent += `BT\n/F1 10 Tf\n50 100 Td\n`;
  streamContent += `(Licensor Signature: _________________________) Tj\n`;
  streamContent += `300 0 Td\n(Licensee Signature: _________________________) Tj\n`;
  streamContent += `ET\n`;
  streamContent += `BT\n/F1 8 Tf\n160 30 Td\n`;
  streamContent += `(Generated by PropLedger - propledger.in) Tj\n`;
  streamContent += `ET\n`;

  const streamLength = Buffer.byteLength(streamContent, 'latin1');

  // Build complete PDF
  const pdfParts = [];
  pdfParts.push('%PDF-1.4\n');

  // Object 1: Catalog
  const obj1Offset = pdfParts.join('').length;
  pdfParts.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);

  // Object 2: Pages
  const obj2Offset = pdfParts.join('').length;
  pdfParts.push(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);

  // Object 3: Page
  const obj3Offset = pdfParts.join('').length;
  pdfParts.push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 ${pageHeight}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`);

  // Object 4: Content Stream
  const obj4Offset = pdfParts.join('').length;
  pdfParts.push(`4 0 obj\n<< /Length ${streamLength} >>\nstream\n${streamContent}\nendstream\nendobj\n`);

  // Object 5: Font
  const obj5Offset = pdfParts.join('').length;
  pdfParts.push(`5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`);

  // xref table
  const xrefOffset = pdfParts.join('').length;
  const offsets = [obj1Offset, obj2Offset, obj3Offset, obj4Offset, obj5Offset];
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  offsets.forEach(off => {
    xref += String(off).padStart(10, '0') + ' 00000 n \n';
  });
  pdfParts.push(xref);
  pdfParts.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const pdfStr = pdfParts.join('');
  return Buffer.from(pdfStr, 'latin1').toString('base64');
}
