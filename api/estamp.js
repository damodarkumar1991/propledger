// api/estamp.js — PropLedger eStamp API (Surepass stamper-v2)
// Actions: order-stamp, check-status, fetch-stamp-pdf

const { createClient } = require('@supabase/supabase-js');

const SUREPASS_BASE = 'https://kyc-api.surepass.app';
const SUREPASS_TOKEN = process.env.SUREPASS_TOKEN;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Indian states with eStamp support and common article IDs
const SUPPORTED_STATES = {
  AN: 'Andaman & Nicobar', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh',
  AS: 'Assam', BR: 'Bihar', CH: 'Chandigarh', CG: 'Chhattisgarh',
  DD: 'Daman & Diu', DL: 'Delhi', GA: 'Goa', GJ: 'Gujarat',
  HR: 'Haryana', HP: 'Himachal Pradesh', JK: 'Jammu & Kashmir',
  JH: 'Jharkhand', KA: 'Karnataka', KL: 'Kerala', LA: 'Ladakh',
  LD: 'Lakshadweep', MP: 'Madhya Pradesh', MH: 'Maharashtra',
  MN: 'Manipur', ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland',
  OD: 'Odisha', PY: 'Puducherry', PB: 'Punjab', RJ: 'Rajasthan',
  SK: 'Sikkim', TN: 'Tamil Nadu', TS: 'Telangana', TR: 'Tripura',
  UP: 'Uttar Pradesh', UK: 'Uttarakhand', WB: 'West Bengal'
};

const ARTICLE_IDS = {
  22088: 'Leave & License Agreement',
  3969:  'General Agreement',
  5188:  'Affidavit',
  5200:  'Sale Deed',
  5194:  'Power of Attorney'
};

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.body;

  try {
    switch (action) {
      case 'order-stamp':
        return await orderStamp(req, res);
      case 'check-status':
        return await checkStatus(req, res);
      case 'fetch-stamp-pdf':
        return await fetchStampPdf(req, res);
      case 'get-config':
        return res.status(200).json({
          success: true,
          states: SUPPORTED_STATES,
          articles: ARTICLE_IDS
        });
      default:
        return res.status(400).json({ error: 'Invalid action. Use: order-stamp, check-status, fetch-stamp-pdf, get-config' });
    }
  } catch (err) {
    console.error('eStamp API error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
};

// ─── ORDER STAMP ─────────────────────────────────────────
async function orderStamp(req, res) {
  const {
    user_id,
    agreement_id,
    first_party,
    second_party = 'Lessee',
    state,            // 2-letter code
    article_id = 22088,
    amount,           // stamp duty in INR
    consideration_amount,
    razorpay_payment_id,
    razorpay_order_id
  } = req.body;

  // Validation
  if (!first_party || !state || !amount) {
    return res.status(400).json({ error: 'Missing required fields: first_party, state, amount' });
  }
  if (!SUPPORTED_STATES[state]) {
    return res.status(400).json({ error: `Invalid state code: ${state}` });
  }
  if (amount < 10) {
    return res.status(400).json({ error: 'Stamp amount must be at least ₹10' });
  }

  // Call Surepass stamper-v2
  let surepassData;
  try {
    const surepassRes = await fetch(`${SUREPASS_BASE}/api/v1/stamper-v2/order-stamp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUREPASS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        first_party,
        second_party,
        state,
        article_id: Number(article_id),
        amount: Number(amount),
        consideration_amount: Number(consideration_amount || amount)
      })
    });

    const rawText = await surepassRes.text();
    console.log('Surepass raw response:', surepassRes.status, rawText);

    try {
      surepassData = JSON.parse(rawText);
    } catch (parseErr) {
      return res.status(400).json({
        error: 'Surepass returned non-JSON response',
        details: rawText.substring(0, 500),
        status_code: surepassRes.status
      });
    }

    if (!surepassRes.ok || !surepassData.data) {
      return res.status(400).json({
        error: 'Surepass eStamp order failed',
        details: surepassData.message || JSON.stringify(surepassData),
        status_code: surepassData.status_code,
        surepass_full: surepassData
      });
    }
  } catch (fetchErr) {
    return res.status(500).json({
      error: 'Failed to call Surepass API',
      details: fetchErr.message
    });
  }

  const { client_id } = surepassData.data;

  // Save to Supabase
  const { data: record, error: dbError } = await supabase
    .from('estamp_records')
    .insert({
      user_id,
      agreement_id,
      client_id,
      first_party,
      second_party,
      state_code: state,
      article_id: Number(article_id),
      stamp_amount: Number(amount),
      consideration_amount: Number(consideration_amount || amount),
      status: 'pending',
      razorpay_payment_id,
      razorpay_order_id,
      payment_status: razorpay_payment_id ? 'paid' : 'unpaid',
      total_charged: Number(amount) + 49, // stamp + service fee
      service_fee: 49
    })
    .select()
    .maybeSingle();

  if (dbError) {
    console.error('DB insert error:', dbError);
    // Don't fail — stamp is ordered, just log the DB issue
  }

  return res.status(200).json({
    success: true,
    client_id,
    status: 'pending',
    message: 'eStamp order placed. Poll for status.',
    record_id: record?.id,
    surepass_response: surepassData.data
  });
}

// ─── CHECK STATUS ────────────────────────────────────────
async function checkStatus(req, res) {
  const { client_id } = req.body;

  if (!client_id) {
    return res.status(400).json({ error: 'Missing client_id' });
  }

  const surepassRes = await fetch(`${SUREPASS_BASE}/api/v1/stamper-v2/fetch-stamp/${client_id}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${SUREPASS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  const surepassData = await surepassRes.json();
  console.log('Surepass fetch-stamp response:', JSON.stringify(surepassData));

  if (!surepassRes.ok) {
    return res.status(400).json({
      error: 'Failed to check stamp status',
      details: surepassData.message || surepassData
    });
  }

  const stampData = surepassData.data || {};
  const status = stampData.status || 'pending';
  const stampPdfUrl = stampData.link || stampData.pdf_url || null;
  const certificateNo = stampData.certificate_no || stampData.uin || null;

  // Update Supabase record if status changed
  const updatePayload = { status, updated_at: new Date().toISOString() };
  if (status === 'available') {
    updatePayload.stamp_pdf_url = stampPdfUrl;
    updatePayload.stamp_certificate_no = certificateNo;
    updatePayload.stamp_available_at = new Date().toISOString();
  }

  const { error: dbError } = await supabase
    .from('estamp_records')
    .update(updatePayload)
    .eq('client_id', client_id);

  if (dbError) console.error('DB update error:', dbError);

  return res.status(200).json({
    success: true,
    client_id,
    status,
    stamp_pdf_url: stampPdfUrl,
    certificate_no: certificateNo,
    raw: stampData
  });
}

// ─── FETCH STAMP PDF ─────────────────────────────────────
async function fetchStampPdf(req, res) {
  const { client_id } = req.body;

  if (!client_id) {
    return res.status(400).json({ error: 'Missing client_id' });
  }

  // First check status to get the PDF URL
  const statusRes = await fetch(`${SUREPASS_BASE}/api/v1/stamper-v2/fetch-stamp/${client_id}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${SUREPASS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  const statusData = await statusRes.json();
  const stampData = statusData.data || {};

  if (stampData.status !== 'available') {
    return res.status(400).json({
      error: 'Stamp not yet available',
      status: stampData.status
    });
  }

  const pdfUrl = stampData.link || stampData.pdf_url;
  if (!pdfUrl) {
    return res.status(400).json({ error: 'No PDF URL found for this stamp' });
  }

  // Download the PDF
  const pdfRes = await fetch(pdfUrl);
  if (!pdfRes.ok) {
    return res.status(500).json({ error: 'Failed to download stamp PDF from Surepass' });
  }

  const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

  // Upload to Supabase Storage
  const fileName = `stamps/${client_id}_estamp.pdf`;
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from('agreements')
    .upload(fileName, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true
    });

  if (uploadError) {
    console.error('Supabase upload error:', uploadError);
    return res.status(500).json({ error: 'Failed to upload stamp PDF to storage' });
  }

  const { data: publicUrlData } = supabase.storage
    .from('agreements')
    .getPublicUrl(fileName);

  const publicUrl = publicUrlData.publicUrl;

  // Update DB record
  await supabase
    .from('estamp_records')
    .update({
      stamp_pdf_url: publicUrl,
      status: 'available'
    })
    .eq('client_id', client_id);

  return res.status(200).json({
    success: true,
    client_id,
    stamp_pdf_url: publicUrl,
    message: 'Stamp PDF downloaded and stored'
  });
}
