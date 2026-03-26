// /api/esign.js — Aadhaar eSign via Digio API
// Handles: send-otp, verify-otp

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const DIGIO_CLIENT_ID = process.env.DIGIO_CLIENT_ID;
  const DIGIO_CLIENT_SECRET = process.env.DIGIO_CLIENT_SECRET;
  const DIGIO_BASE_URL = process.env.DIGIO_ENV === 'production'
    ? 'https://api.digio.in'
    : 'https://ext.digio.in:444'; // sandbox

  const action = req.url.split('/').pop(); // 'send-otp' or 'verify-otp'

  // ── DEMO MODE (no API keys configured) ──────────────────
  if (!DIGIO_CLIENT_ID || !DIGIO_CLIENT_SECRET) {
    if (action === 'send-otp') {
      return res.json({
        success: true,
        transactionId: 'DEMO_TXN_' + Date.now(),
        message: 'Demo mode: OTP simulated. Use any 6 digits.'
      });
    }
    if (action === 'verify-otp') {
      return res.json({
        success: true,
        signatureId: 'DEMO_SIG_' + Date.now(),
        timestamp: new Date().toISOString(),
        message: 'Demo mode: Signature simulated.'
      });
    }
  }

  // ── LIVE MODE: Digio API ─────────────────────────────────
  const auth = Buffer.from(`${DIGIO_CLIENT_ID}:${DIGIO_CLIENT_SECRET}`).toString('base64');

  try {
    if (action === 'send-otp') {
      const { aadhaar, name, agreementId, role } = req.body;

      if (!aadhaar || aadhaar.length !== 12) {
        return res.status(400).json({ error: 'Invalid Aadhaar number' });
      }

      // Step 1: Create signing request with Digio
      const docRes = await fetch(`${DIGIO_BASE_URL}/client/kyc/v2/request/with_template`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          customer_identifier: aadhaar,
          customer_name: name,
          notify_type: 'none',
          kyc_type: 'esign',
          generate_access_token: true,
          template_name: 'leave_and_license',
          send_to_esign: true,
          reference_id: `propledger_${agreementId}_${role}_${Date.now()}`
        })
      });

      const docData = await docRes.json();

      if (!docData.id) {
        return res.status(400).json({ error: docData.message || 'Failed to initiate eSign' });
      }

      // Step 2: Send Aadhaar OTP
      const otpRes = await fetch(`${DIGIO_BASE_URL}/client/esign/v2/request/${docData.id}/initiate`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          kyc_type: 'aadhaar_otp',
          identifier: aadhaar
        })
      });

      const otpData = await otpRes.json();

      return res.json({
        success: true,
        transactionId: docData.id,
        message: 'OTP sent to Aadhaar-registered mobile'
      });

    } else if (action === 'verify-otp') {
      const { otp, transactionId, agreementId, role, name, aadhaar } = req.body;

      const verifyRes = await fetch(`${DIGIO_BASE_URL}/client/esign/v2/request/${transactionId}/verify`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          otp,
          identifier: aadhaar
        })
      });

      const verifyData = await verifyRes.json();

      if (verifyData.status === 'signed' || verifyData.code === 'SUCCESS') {
        return res.json({
          success: true,
          signatureId: verifyData.esign_id || verifyData.id || transactionId,
          timestamp: new Date().toISOString(),
          signerName: name
        });
      } else {
        return res.status(400).json({
          error: verifyData.message || 'Invalid OTP or verification failed'
        });
      }
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (error) {
    console.error('eSign API error:', error);
    return res.status(500).json({ error: 'eSign service error. Please try again.' });
  }
};
