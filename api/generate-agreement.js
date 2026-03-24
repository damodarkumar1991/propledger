// /api/generate-agreement.js
// PropLedger — AI Rental Agreement Generator
// Vercel Serverless Function (Node.js CommonJS)

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

module.exports = async function handler(req, res) {
  // CORS headers — allow all origins for now
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      // Property details
      landlordName,
      landlordAddress,
      propertyAddress,
      propertyType,
      furnished,
      city,
      // Tenant details
      tenantName,
      tenantPhone,
      tenantAadhaar, // Only last 4 digits stored
      tenantAddress,
      occupation,
      occupants,
      emergencyContact,
      // Terms
      rent,
      deposit,
      startDate,
      duration,
      maintenance,
      noticePeriod,
      increment,
      utilities,
      specialClauses,
    } = req.body;

    // Validate required fields
    const required = { landlordName, landlordAddress, propertyAddress, tenantName, tenantPhone, rent, deposit, startDate };
    const missing = Object.entries(required)
      .filter(([, v]) => !v)
      .map(([k]) => k);

    if (missing.length > 0) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    // Build prompt
    const prompt = buildAgreementPrompt({
      landlordName, landlordAddress, propertyAddress, propertyType, furnished, city,
      tenantName, tenantPhone, tenantAadhaar, tenantAddress, occupation, occupants, emergencyContact,
      rent, deposit, startDate, duration, maintenance, noticePeriod, increment, utilities, specialClauses
    });

    // Call Claude API
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `You are PropLedger's legal document AI. You generate professional, legally complete Indian residential rental agreements. Always write in formal legal English. Structure with numbered sections and sub-clauses. Include all standard Indian rental law requirements under the Transfer of Property Act 1882 and Registration Act 1908. Never add disclaimers within the agreement body itself — they will be added separately by the UI.`,
      messages: [
        { role: 'user', content: prompt }
      ],
    });

    const agreementText = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // Log to Supabase (agreement metadata, not full text in free plan)
    // await logAgreement(userId, tenantName, propertyAddress);

    return res.status(200).json({
      success: true,
      agreement: agreementText,
      metadata: {
        tenant: tenantName,
        property: propertyAddress,
        rent: rent,
        duration: duration,
        generatedAt: new Date().toISOString(),
        model: 'claude-sonnet-4-20250514',
      }
    });

  } catch (error) {
    console.error('Agreement generation error:', error);

    // Handle Anthropic API errors
    if (error.status === 429) {
      return res.status(429).json({ error: 'Rate limit reached. Please try again in a moment.' });
    }

    if (error.status === 401) {
      return res.status(500).json({ error: 'AI service authentication failed.' });
    }

    return res.status(500).json({ error: 'Failed to generate agreement. Please try again.' });
  }
}

function buildAgreementPrompt(data) {
  const endDate = calculateEndDate(data.startDate, parseInt(data.duration) || 11);

  return `Generate a complete Indian residential rental agreement with these exact details:

LANDLORD INFORMATION:
- Full Name: ${data.landlordName}
- Permanent Address: ${data.landlordAddress}

TENANT INFORMATION:
- Full Name: ${data.tenantName}
- Phone: ${data.tenantPhone}
- Aadhaar Reference: XXXX-XXXX-XXXX-${data.tenantAadhaar || 'XXXX'}
- Occupation: ${data.occupation || 'Salaried Employee'}
- Number of Occupants: ${data.occupants || '1'}
- Permanent Address: ${data.tenantAddress}
- Emergency Contact: ${data.emergencyContact || 'As provided separately'}

PROPERTY DETAILS:
- Address: ${data.propertyAddress}${data.city ? `, ${data.city}` : ''}
- Type: ${data.propertyType || 'Apartment/Flat'}
- Condition: ${data.furnished || 'Unfurnished'}

FINANCIAL TERMS:
- Monthly Rent: ₹${parseInt(data.rent).toLocaleString('en-IN')}
- Security Deposit: ₹${parseInt(data.deposit).toLocaleString('en-IN')}
- Maintenance Charges: ₹${parseInt(data.maintenance || 0).toLocaleString('en-IN')}/month
- Annual Rent Increment: ${data.increment || '10'}%
- Utilities: ${data.utilities || 'Tenant pays directly'}

AGREEMENT PERIOD:
- Start Date: ${formatDate(data.startDate)}
- End Date: ${endDate}
- Duration: ${data.duration || '11'} months
- Notice Period: ${data.noticePeriod || '1'} month(s)

SPECIAL CLAUSES:
${data.specialClauses || 'None specified'}

Generate a complete formal agreement with these sections:
1. PARTIES (full party details)
2. PROPERTY DESCRIPTION
3. TERM AND COMMENCEMENT
4. RENT AND PAYMENT TERMS
5. SECURITY DEPOSIT
6. MAINTENANCE AND UTILITIES
7. OBLIGATIONS OF THE TENANT (minimum 8 numbered sub-clauses)
8. OBLIGATIONS OF THE LANDLORD (minimum 5 numbered sub-clauses)
9. PROHIBITED ACTIVITIES
10. SUBLETTING AND ASSIGNMENT
11. INSPECTION AND ACCESS
12. TERMINATION AND NOTICE
13. DISPUTE RESOLUTION (Arbitration & Conciliation Act, 1996)
14. GOVERNING LAW (Laws of India, jurisdiction: ${data.city || 'the city where property is located'})
15. GENERAL PROVISIONS
16. SIGNATURES (with witness lines, date fields)`;
}

function calculateEndDate(startDate, months) {
  if (!startDate) return 'As agreed';
  try {
    const date = new Date(startDate);
    date.setMonth(date.getMonth() + months);
    date.setDate(date.getDate() - 1);
    return formatDate(date.toISOString().split('T')[0]);
  } catch {
    return 'As agreed';
  }
}

function formatDate(dateStr) {
  if (!dateStr) return 'As agreed';
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'long', year: 'numeric'
    });
  } catch {
    return dateStr;
  }
}
