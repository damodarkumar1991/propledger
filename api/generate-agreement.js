// /api/generate-agreement.js
// PropLedger — Realistic Indian Rental Agreement Generator
// Vercel Serverless Function (Node.js CommonJS)

const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const d = req.body;
    if (!d.landlordName || !d.tenantName || !d.propertyAddress || !d.rent || !d.startDate) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const licensor = d.agreementType === 'Rent Agreement' ? 'Lessor/Owner' : 'Licensor';
    const licensee = d.agreementType === 'Rent Agreement' ? 'Lessee/Tenant' : 'Licensee';
    const rentWords = d.rentInWords || numberToWords(parseInt(d.rent));
    const depositWords = d.depositInWords || numberToWords(parseInt(d.deposit || 0));
    const execPlace = d.executionPlace || d.city || 'Gurgaon';
    const endDate = d.endDate ? formatDate(d.endDate) : calculateEndDate(d.startDate, parseInt(d.duration) || 11);

    // Build furniture table
    let furnitureTable = '';
    if (d.furnitureItems && d.furnitureItems.length > 0) {
      furnitureTable = '\nSchedule I – Furniture and Appliances\n\n| Sr. No. | Item Name | Quantity | Remarks |\n|---------|-----------|----------|---------|\n';
      d.furnitureItems.forEach((item, i) => {
        furnitureTable += `| ${i+1} | ${item.name} | ${item.qty} | ${item.remarks || ''} |\n`;
      });
    }

    // Build family table
    let familyTable = '';
    if (d.familyMembers && d.familyMembers.length > 0) {
      familyTable = '\nFamily Members Residing at Premises\n\n| Sr. No. | Name | Age | Aadhaar | Gender | Relation | Occupation |\n|---------|------|-----|---------|--------|----------|------------|\n';
      d.familyMembers.forEach((m, i) => {
        familyTable += `| ${i+1} | ${m.name} | ${m.age} | ${m.aadhaar || 'N/A'} | ${m.gender} | ${m.relation} | ${m.occupation} |\n`;
      });
    }

    const agreementText = buildAgreement({
      ...d, licensor, licensee, rentWords, depositWords,
      execPlace, endDate, furnitureTable, familyTable
    });

    // Use Claude to polish and finalize the agreement
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `You are a senior Indian property lawyer. Your task is to take the draft rental agreement provided and output a final, polished, legally precise version. 
Rules:
- Preserve ALL clause numbers, ALL party details, ALL amounts exactly as given
- Keep ALL tables (furniture, family members) intact
- Keep the signature block exactly as given
- Fix any grammatical issues but do not change legal substance
- Do NOT add preamble, commentary or disclaimers
- Output ONLY the agreement text`,
      messages: [{ role: 'user', content: `Please finalize this rental agreement:\n\n${agreementText}` }],
    });

    const finalAgreement = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return res.status(200).json({ success: true, agreement: finalAgreement });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Failed to generate agreement. Please try again.', details: error.message });
  }
};

function buildAgreement(d) {
  const {
    landlordName, landlordAge, landlordGender, landlordFatherName,
    landlordPAN, landlordAadhaar, landlordAddress,
    tenantName, tenantAge, tenantGender, tenantFatherName,
    tenantPAN, tenantAadhaar, tenantPhone, tenantAddress,
    tenantOccupation, tenantEmployer,
    propertyAddress, city, state, bedrooms, bathrooms,
    furnished, rent, deposit, rentWords, depositWords,
    maintenanceIncluded, rentDueDate, gracePeriod, lateFee,
    paymentMode, bankName, accountNumber, ifscCode,
    startDate, endDate, duration, noticePeriod,
    lockInPeriod, incrementPercent, electricityBoard,
    furnitureTable, familyTable,
    witness1Name, witness1Address, witness2Name, witness2Address,
    agreementType, execPlace,
    licensor, licensee, specialClauses,
  } = d;

  const agType = agreementType || 'Leave and License';
  const dueDate = rentDueDate || '1st';
  const grace = gracePeriod || '3';
  const late = lateFee || '1,000';
  const lockIn = lockInPeriod || '1';
  const notice = noticePeriod || '1';
  const incr = incrementPercent || '5';
  const dur = duration || '11';

  return `${agType.toUpperCase()} AGREEMENT

This ${agType} Agreement is made and executed on ${formatDate(startDate)} at ${execPlace}

BETWEEN

Name: ${landlordName}${landlordAge ? ', Age: ' + landlordAge + ' Years' : ''}${landlordGender ? ', ' + landlordGender : ''}${landlordFatherName ? ', S/o ' + landlordFatherName : ''}${landlordPAN ? ', PAN: ' + landlordPAN : ''}${landlordAadhaar ? ', Aadhaar: XXXX XXXX ' + String(landlordAadhaar).slice(-4) : ''}, residing at ${landlordAddress}
Hereinafter referred to as the "${licensor}" (Party of the First Part)

AND

Name: ${tenantName}${tenantAge ? ', Age: ' + tenantAge + ' Years' : ''}${tenantGender ? ', ' + tenantGender : ''}${tenantFatherName ? ', S/o/D/o ' + tenantFatherName : ''}${tenantPAN ? ', PAN: ' + tenantPAN : ''}${tenantAadhaar ? ', Aadhaar: XXXX XXXX ' + String(tenantAadhaar).slice(-4) : ''}${tenantPhone ? ', Phone: ' + tenantPhone : ''}${tenantOccupation ? ', Occupation: ' + tenantOccupation : ''}${tenantEmployer ? ', Employer: ' + tenantEmployer : ''}, residing at ${tenantAddress}
Hereinafter referred to as the "${licensee}" (Party of the Second Part)

WHEREAS the ${licensor} is the lawful owner and in possession of the property situated at ${propertyAddress}${city ? ', ' + city : ''}${state ? ', ' + state : ''}${bedrooms ? ' having ' + bedrooms + ' bedroom(s)' : ''}${bathrooms ? ' and ' + bathrooms + ' bathroom(s)' : ''}, hereinafter referred to as the "Licensed Premises," and has agreed to let out the said property to the ${licensee} on the following terms and conditions.

NOW THIS AGREEMENT WITNESSETH AS UNDER:

1. That the ${licensor} hereby grants to the ${licensee} a revocable leave and license to occupy the Licensed Premises for a period of ${dur} months commencing from ${formatDate(startDate)} and ending on ${endDate}. This agreement can be extended by mutual consent on mutually agreed rental terms.

2. That the ${licensee} shall pay to the ${licensor} Rs. ${parseInt(rent).toLocaleString('en-IN')}/- (${rentWords}) per month as license fee${maintenanceIncluded === 'yes' ? ' inclusive of maintenance charges' : ' excluding electricity and water charges'}, in advance on or before the ${dueDate} day of each month.

3. The ${licensee} has agreed for a ${lockIn} month lock-in period. If the ${licensee} terminates the agreement before the lock-in period, the ${licensee} shall pay 1 month's rent as termination charges.

4. The ${licensee} shall pay a security deposit of Rs. ${parseInt(deposit).toLocaleString('en-IN')}/- (${depositWords}), which is interest-free and refundable at the end of the agreement after deducting any outstanding dues, electricity charges, water charges, maintenance charges, damage repair costs, or any other amounts payable by the ${licensee}.

5. That the due date for per month advance rent payment is the ${dueDate} day of every month with a grace period of ${grace} days. If payment is delayed beyond the grace period, the ${licensor} shall charge late fees of Rs. ${late}/-.

6. Mode of Payment: The ${licensee} shall pay rent via ${paymentMode || 'Cheque/NEFT/UPI'}${bankName ? ' to ' + bankName : ''}${accountNumber ? ', Account No.: ' + accountNumber : ''}${ifscCode ? ', IFSC: ' + ifscCode : ''}.

7. That this agreement may be terminated before expiry by serving ${notice} month(s) prior written notice by either party. On expiry of the notice period, the ${licensee} shall vacate the premises and the ${licensor} shall refund the security deposit after deductions.

8. On expiry of this agreement, the ${licensee} shall remove all belongings and handover physical possession of the Licensed Premises to the ${licensor} peacefully.

9. In case the ${licensee} does not vacate the Licensed Premises on expiry of the agreement, the ${licensor} shall be entitled to and is hereby authorised by the ${licensee} to remove all belongings of the ${licensee} from the premises without being responsible for any loss or damage.

10. That the ${licensee} shall not sublet any part of the Licensed Premises to anyone else under any circumstances without the prior written consent of the ${licensor}.

11. That the ${licensee} shall abide by all bye-laws, rules and regulations of the local authorities in respect of the Licensed Premises and shall not carry out any illegal activities.

12. That the ${licensee} shall pay electricity charges as per the charges issued by ${electricityBoard || 'the electricity board'} and water charges separately.

13. That the ${licensee} shall not make any structural addition or alteration in the Licensed Premises without prior written consent of the ${licensor}.

14. That the ${licensee} shall permit the ${licensor} or their authorised agent to enter the Licensed Premises for inspection at any reasonable time with prior notice.

15. That the ${licensee} shall keep the Licensed Premises in clean and hygienic condition and shall not cause nuisance to neighbours.

16. That the ${licensee} shall carry out all day-to-day minor repairs at their own cost.

17. That the ${licensee} shall use the Licensed Premises for residential purposes only.

18. That the ${licensee} shall not store any offensive, dangerous, explosive or highly inflammable articles in the Licensed Premises.

19. That the ${licensee} is not permitted to use this agreement for any Loan, Home Loan, or Credit Card issuance purposes.

20. That this agreement may be renewed for a further period of ${dur} months with ${incr}% increment in the license fee, on terms to be mutually agreed upon.

21. That the ${licensee} shall not use the Licensed Premises to obtain or register for Goods and Services Tax (GST), nor represent it as their principal place of business for GST purposes, without prior written consent of the ${licensor}. Any such action shall constitute a material breach and may lead to immediate termination.

22. Upon vacating, the ${licensee} shall return the property in a clean condition similar to move-in condition. Additional cleaning, repainting, or repair costs beyond normal wear and tear shall be deducted from the security deposit.

23. The original copy of this agreement shall be kept with the ${licensor} and a photocopy shall be provided to the ${licensee}.
${specialClauses ? '\n24. ' + specialClauses : ''}
${furnitureTable}
${familyTable}

That both parties have read and understood all the contents of this agreement and have signed the same voluntarily without any force or pressure.

IN WITNESS WHEREOF the ${licensor} and the ${licensee} have hereunto subscribed their signatures at ${execPlace} on ${formatDate(startDate)} in the presence of the following witnesses:

WITNESSES:

1. Name:      ${witness1Name || '_________________________'}
   Address:   ${witness1Address || '_________________________'}
   Signature: _________________________

2. Name:      ${witness2Name || '_________________________'}
   Address:   ${witness2Address || '_________________________'}
   Signature: _________________________


${licensor}                                    ${licensee}

_________________________                      _________________________
${landlordName}                                ${tenantName}
Date: _________________________                Date: _________________________`;
}

function formatDate(dateStr) {
  if (!dateStr) return '__________';
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch { return dateStr; }
}

function calculateEndDate(startDate, months) {
  if (!startDate) return '__________';
  try {
    const d = new Date(startDate);
    d.setMonth(d.getMonth() + months);
    d.setDate(d.getDate() - 1);
    return formatDate(d.toISOString().split('T')[0]);
  } catch { return '__________'; }
}

function numberToWords(num) {
  if (!num || isNaN(num)) return '';
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
    'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function cvt(n) {
    let r = '';
    if (n >= 100) { r += ones[Math.floor(n/100)] + ' Hundred '; n %= 100; }
    if (n >= 20) { r += tens[Math.floor(n/10)] + ' '; n %= 10; }
    if (n > 0) r += ones[n] + ' ';
    return r;
  }
  let r = '', n = num;
  if (n >= 10000000) { r += cvt(Math.floor(n/10000000)) + 'Crore '; n %= 10000000; }
  if (n >= 100000) { r += cvt(Math.floor(n/100000)) + 'Lakh '; n %= 100000; }
  if (n >= 1000) { r += cvt(Math.floor(n/1000)) + 'Thousand '; n %= 1000; }
  r += cvt(n);
  return r.trim() + ' Only';
}
