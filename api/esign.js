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

  const auth = (DIGIO_CLIENT_ID && DIGIO_CLIENT_SECRET)
    ? 'Basic ' + Buffer.from(`${DIGIO_CLIENT_ID}:${DIGIO_CLIENT_SECRET}`).toString('base64')
    : null;

  const action = req.url.split('/').pop().split('?')[0];

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
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

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

      // Step 1: Upload document to Digio
      const uploadRes = await fetch(`${BASE}/v2/client/document/uploadedits`, {
        method: 'POST',
        headers: {
          'Authorization': auth,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          file_name: `PropLedger_Agreement_${agreementId}.pdf`,
          file_data: pdfBase64,
          file_type: 'application/pdf',
          signers: [
            {
              identifier: landlordEmail,
              name: landlordName || 'Licensor',
              reason: 'Signing as Licensor (Landlord)',
              sign_type: 'electronic'
            },
            {
              identifier: tenantEmail,
              name: tenantName || 'Licensee',
              reason: 'Signing as Licensee (Tenant)',
              sign_type: 'electronic'
            }
          ],
          expire_in_days: 30,
          notify_signers: true,
          send_sign_link: true,
          message: `Please sign the Leave & License Agreement for ${propertyAddress || 'the property'} on PropLedger.`
        })
      });

      const uploadData = await uploadRes.json();

      if (!uploadData.id) {
        console.error('Digio upload error:', uploadData);
        return res.status(400).json({
          error: uploadData.message || 'Failed to create sign request',
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
  // Generate clean HTML for the agreement, return as base64
  // In production, use puppeteer/wkhtmltopdf on the server
  // For now, create a well-structured HTML that Digio can accept as a text document
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body { font-family: 'Times New Roman', serif; font-size: 12pt; line-height: 1.8; color: #000; margin: 40px; }
  h1 { text-align: center; font-size: 16pt; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px; }
  h2 { font-size: 13pt; text-transform: uppercase; margin-top: 24px; margin-bottom: 8px; border-bottom: 1px solid #333; padding-bottom: 4px; }
  .meta { text-align: center; margin-bottom: 24px; font-size: 11pt; color: #555; }
  .section { margin-bottom: 16px; }
  .sig-block { margin-top: 48px; display: flex; justify-content: space-between; }
  .sig { width: 45%; border-top: 1px solid #000; padding-top: 8px; font-size: 11pt; }
</style>
</head>
<body>
<h1>${meta.title || 'Leave & License Agreement'}</h1>
<div class="meta">
  Between <strong>${meta.landlordName || 'Licensor'}</strong> (Landlord) and <strong>${meta.tenantName || 'Tenant'}</strong> (Tenant)<br>
  Property: ${meta.propertyAddress || ''} | Rent: ₹${parseInt(meta.monthlyRent || 0).toLocaleString('en-IN')}/month
</div>
<div class="section">
${(agreementText || '')
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/━+/g, '<hr style="border:none;border-top:1px solid #ccc;margin:12px 0;">')
  .replace(/\n/g, '<br>')}
</div>
<div class="sig-block">
  <div class="sig">
    <strong>${meta.landlordName || 'Licensor'}</strong><br>
    Signature: ____________________<br>
    Date: ____________________
  </div>
  <div class="sig">
    <strong>${meta.tenantName || 'Licensee'}</strong><br>
    Signature: ____________________<br>
    Date: ____________________
  </div>
</div>
<p style="text-align:center;margin-top:32px;font-size:9pt;color:#888;">
  Generated by PropLedger (propledger.in) · Digitally signed via Digio
</p>
</body>
</html>`;

  return Buffer.from(html).toString('base64');
}
