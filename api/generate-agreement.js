// /api/generate-agreement.js
// PropLedger — Complete Indian Rental Agreement Generator
// Produces a court-admissible, properly formatted document

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

    const rentWords = d.rentInWords || numberToWords(parseInt(d.rent));
    const depositWords = d.depositInWords || numberToWords(parseInt(d.deposit || 0));
    const execPlace = d.executionPlace || d.city || 'Gurgaon';
    const dur = parseInt(d.duration) || 11;
    const endDate = d.endDate ? formatDate(d.endDate) : calculateEndDate(d.startDate, dur);
    const agType = d.agreementType || 'Leave and License';
    const isLL = agType.includes('Leave');
    const LICENSOR = isLL ? 'LICENSOR' : 'LESSOR/OWNER';
    const LICENSEE = isLL ? 'LICENSEE' : 'LESSEE/TENANT';
    const Licensor = isLL ? 'Licensor' : 'Lessor/Owner';
    const Licensee = isLL ? 'Licensee' : 'Lessee/Tenant';

    // Build furniture schedule
    let furnitureSchedule = '';
    if (d.furnitureItems && d.furnitureItems.length > 0) {
      furnitureSchedule = `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SCHEDULE II — INVENTORY OF FURNITURE AND APPLIANCES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The following items of furniture and appliances are provided by the ${Licensor} in the Licensed Premises. The ${Licensee} acknowledges receipt of the same in good working condition (subject to normal wear and tear) and undertakes to return them in the same condition at the time of vacating.

${formatTable(
  ['Sr. No.', 'Item Description', 'Quantity', 'Condition / Remarks'],
  d.furnitureItems.map((item, i) => [(i+1).toString(), item.name, item.qty, item.remarks || 'Good condition'])
)}

Any damage to the above items beyond normal wear and tear shall be repaired or replaced by the ${Licensee} at their own cost, or the equivalent amount shall be deducted from the Security Deposit.`;
    }

    // Build family members table
    let familySchedule = '';
    if (d.familyMembers && d.familyMembers.length > 0) {
      familySchedule = `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SCHEDULE III — FAMILY MEMBERS AUTHORISED TO RESIDE IN THE LICENSED PREMISES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The following family members of the ${Licensee} are authorised to reside in the Licensed Premises during the tenure of this Agreement:

${formatTable(
  ['Sr. No.', 'Full Name', 'Age', 'Gender', 'Relation to Licensee', 'Occupation'],
  d.familyMembers.map((m, i) => [(i+1).toString(), m.name, m.age||'', m.gender||'', m.relation||'', m.occupation||''])
)}

No other person(s) are permitted to reside in the Licensed Premises without prior written consent of the ${Licensor}.`;
    }

    // Build payment history table
    let paymentSchedule = '';
    if (d.payments && d.payments.length > 0) {
      paymentSchedule = `\n\nSCHEDULE IV — PAYMENT RECORD
${formatTable(
  ['Transaction Date', 'Particulars', 'Amount (₹)', 'Transaction ID', 'Bank Name'],
  d.payments.map(p => [p.date, p.particulars, p.amount, p.txnId||'', p.bank||''])
)}`;
    }

    const prompt = buildFullPrompt({
      d, LICENSOR, LICENSEE, Licensor, Licensee,
      rentWords, depositWords, execPlace, endDate, dur, agType, isLL,
      furnitureSchedule, familySchedule, paymentSchedule,
    });

    // Return the complete agreement template directly — no Claude call needed.
    // The buildFullPrompt() already generates the full legally structured agreement.
    // Using Claude to "reproduce" it was causing truncation at ~clause 11.
    // Claude is still used for special custom clauses when d.specialClauses is provided.
    let finalAgreement = prompt;

    // Only use Claude if user has added special custom clauses that need drafting
    if (d.specialClauses && d.specialClauses.trim().length > 50) {
      try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
        const message = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 800,
          system: `You are an Indian property lawyer. Draft ONLY the special clause text requested. Output just the clause text, no preamble.`,
          messages: [{ role: 'user', content: `Draft this special clause for a Leave & License agreement: ${d.specialClauses}` }],
        });
        const clauseText = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
        finalAgreement = prompt.replace(
          `   ${d.specialClauses}`,
          clauseText
        );
      } catch(e) {
        console.log('Special clause drafting skipped:', e.message);
      }
    }

    return res.status(200).json({ success: true, agreement: finalAgreement });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Failed to generate. Please try again.', details: error.message });
  }
};

function buildFullPrompt({ d, LICENSOR, LICENSEE, Licensor, Licensee, rentWords, depositWords, execPlace, endDate, dur, agType, isLL, furnitureSchedule, familySchedule, paymentSchedule }) {
  const dueDate = d.rentDueDate || '1st';
  const grace = d.gracePeriod || '3';
  const late = d.lateFee || '1,000';
  const lockIn = d.lockInPeriod || '1';
  const notice = d.noticePeriod || '1';
  const incr = d.incrementPercent || '5';
  const maint = d.maintenanceCharges ? `Rs. ${parseInt(d.maintenanceCharges).toLocaleString('en-IN')}/- per month` : 'as applicable';
  const elec = d.electricityBoard || 'the concerned Electricity Board';
  const propType = d.propertyType || 'Flat/Apartment';
  const society = d.societyName || '';
  const societyRef = society ? `, ${society}` : '';
  const stampValue = d.stampDutyValue || '______';
  const grnNo = d.grnNo || '______';
  const certNo = d.certNo || '______';
  const execDate = formatDate(d.startDate);

  return `[STAMP PAPER HEADER BLOCK]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**NON-JUDICIAL STAMP PAPER**
**Article: Lease / Leave and License**
**Stamp Duty Paid: Rs. ${stampValue}/-**
Certificate No.: ${certNo}                              GRN No.: ${grnNo}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Seller / First Party (${Licensor}):**  ${d.landlordName}
**Address:**  ${d.landlordAddress}

**Buyer / Second Party (${Licensee}):**  ${d.tenantName}
**Address:**  ${d.tenantAddress}

**Purpose:**  ${agType} Agreement for Residential Use
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


**${agType.toUpperCase()} AGREEMENT**

This ${agType} Agreement is executed on this **${execDate}** at **${execPlace}**

**BETWEEN**

**${d.landlordName}**${d.landlordAge ? `, Age: **${d.landlordAge} Years**` : ''}${d.landlordGender ? `, **${d.landlordGender}**` : ''}${d.landlordFatherName ? `, S/o **${d.landlordFatherName}**` : ''}${d.landlordPAN ? `, PAN: **${d.landlordPAN}**` : ''}${d.landlordAadhaar ? `, Aadhaar: **XXXX XXXX ${String(d.landlordAadhaar).slice(-4)}**` : ''}, residing at **${d.landlordAddress}**

Hereinafter referred to as the **"${LICENSOR}"** (which expression, wherever the context requires, shall mean and include their heirs, executors, administrators, legal representatives and assigns) of the **FIRST PART**;

**AND**

**${d.tenantName}**${d.tenantAge ? `, Age: **${d.tenantAge} Years**` : ''}${d.tenantGender ? `, **${d.tenantGender}**` : ''}${d.tenantFatherName ? `, S/o/D/o **${d.tenantFatherName}**` : ''}${d.tenantPAN ? `, PAN: **${d.tenantPAN}**` : ''}${d.tenantAadhaar ? `, Aadhaar: **XXXX XXXX ${String(d.tenantAadhaar).slice(-4)}**` : ''}${d.tenantPhone ? `, Phone: **${d.tenantPhone}**` : ''}${d.tenantOccupation ? `, Occupation: **${d.tenantOccupation}**` : ''}${d.tenantEmployer ? `, Employer: **${d.tenantEmployer}**` : ''}, residing at **${d.tenantAddress}**

Hereinafter referred to as the **"${LICENSEE}"** (which expression, wherever the context requires, shall mean and include their heirs, executors, administrators, legal representatives and assigns) of the **SECOND PART**.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**SCHEDULE I — DESCRIPTION OF LICENSED PREMISES**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Property Type:**   ${propType}${societyRef}
**Full Address:**    ${d.propertyAddress}${d.city ? ', ' + d.city : ''}${d.state ? ', ' + d.state : ''}
**Configuration:**   ${d.bedrooms || 'N/A'} Bedroom(s), ${d.bathrooms || 'N/A'} Bathroom(s)
**Furnished Status:** ${d.furnished || 'As agreed'}

(Hereinafter referred to as the **"Licensed Premises"**)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**RECITALS**

**WHEREAS** the ${LICENSOR} is the lawful owner of the Licensed Premises and has the absolute right, title and authority to let out the same;

**WHEREAS** the ${LICENSOR} has agreed to let the Licensed Premises together with fixtures, fittings and amenities detailed in Schedule II hereto, to be used by the ${LICENSEE} for **residential purposes only**, on the terms and conditions mutually agreed between the parties;

**WHEREAS** the ${LICENSEE} has approached the ${LICENSOR} with a request to temporarily occupy and use the Licensed Premises on ${agType} basis;

**WHEREAS** the handing over of the Licensed Premises by the ${LICENSOR} to the ${LICENSEE} shall NOT be construed as handing over possession in part performance of any contract within the meaning of Section 53-A of the **Transfer of Property Act, 1882**, but only as a permission to use and enjoy the Licensed Premises as a licensee under a license as defined under **Section 52 of the Indian Easements Act, 1882**. The physical and legal possession of the Licensed Premises shall **always remain with the ${LICENSOR}** only.

**NOW THIS AGREEMENT OF ${agType.toUpperCase()} WITNESSETH AS FOLLOWS:**

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**PART A — FUNDAMENTAL TERMS**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**1. GRANT OF LICENSE**

   The ${LICENSOR} hereby grants to the ${LICENSEE}, by way of license, the right to use and occupy the Licensed Premises for **residential purpose only** for a period of **${dur} (${numberToWordsOrdinal(dur)}) months** commencing from **${formatDate(d.startDate)}** and ending on **${endDate}**, subject to the terms and conditions of this Agreement.

**2. LICENSE FEE**

   **2.1** The ${LICENSEE} shall pay to the ${LICENSOR} a monthly license fee of **Rs. ${parseInt(d.rent).toLocaleString('en-IN')}/- (Rupees ${rentWords})** per month${d.maintenanceCharges ? ` exclusive of maintenance charges of ${maint}` : d.maintenanceIncluded === 'yes' ? ' inclusive of maintenance charges payable to the Apartment Owners Association/Society' : ' excluding maintenance charges, electricity and water charges'}.

   **2.2** The license fee shall be paid in advance on or before the **${dueDate} day** of each English Calendar month, by ${d.paymentMode || 'Cheque / NEFT / UPI'}${d.bankName ? ` to ${d.bankName}` : ''}${d.accountNumber ? `, Account No.: ${d.accountNumber}` : ''}${d.ifscCode ? `, IFSC: ${d.ifscCode}` : ''}.

   **2.3** The ${LICENSEE} shall hand over **post-dated cheques (PDCs)** for all ${dur} months of the license period to the ${LICENSOR} at the time of signing this Agreement, wherever applicable.

   **2.4** A grace period of **${grace} (${numberToWordsOrdinal(parseInt(grace))}) days** is permitted after the due date. If payment is delayed beyond the grace period, the ${LICENSOR} shall be entitled to charge a **late payment fee of Rs. ${late}/-** per month.

   **2.5** If any cheque given by the ${LICENSEE} bounces, the ${LICENSEE} shall pay an additional penalty of **Rs. 500/-** per dishonoured cheque, and the outstanding amount along with the penalty must be paid within **48 hours** of intimation, failing which this License shall stand terminated.

**3. SECURITY DEPOSIT**

   **3.1** The ${LICENSEE} has paid / shall pay to the ${LICENSOR} an **interest-free refundable Security Deposit of Rs. ${parseInt(d.deposit).toLocaleString('en-IN')}/- (Rupees ${depositWords})**, the receipt of which the ${LICENSOR} hereby acknowledges.

   **3.2** The Security Deposit shall be refunded to the ${LICENSEE} by the ${LICENSOR} **within 7 (seven) days** of the ${LICENSEE} handing over vacant possession of the Licensed Premises along with all keys, in the same condition as received (subject to normal wear and tear).

   **3.3** The ${LICENSOR} shall be entitled to deduct from the Security Deposit:
      (a) All arrears of license fee and other charges payable by the ${LICENSEE};
      (b) Electricity, water, gas and maintenance charges outstanding;
      (c) Cost of repair of any damage to the Licensed Premises or fixtures/fittings caused by the ${LICENSEE};
      (d) Cleaning and repainting charges, if the premises are not returned in satisfactory condition;
      (e) Any other amounts payable by the ${LICENSEE} under this Agreement.

   **3.4** If the ${LICENSOR} fails to return the Security Deposit within 7 days of receiving vacant possession and all keys, the ${LICENSEE} shall be entitled to continue using the premises free of charge until the deposit is refunded.

**4. DURATION AND RENEWAL**

   **4.1** This License shall be initially for a period of **${dur} months**, commencing **${formatDate(d.startDate)}** and expiring on **${endDate}**.

   **4.2** This Agreement may be renewed by mutual written consent. A fresh agreement must be signed **at least 2 (two) months prior** to the expiration of this Agreement.

   **4.3** Upon renewal, the license fee shall be escalated by **${incr}% (${incr} percent)** over the prevailing license fee. The ${LICENSOR} may renegotiate the fee in case of major market fluctuations.

   **4.4** If the ${LICENSEE} fails to indicate willingness to renew at least 2 months before expiry (even after a reminder by the ${LICENSOR}), the ${LICENSOR} is free to enter into a fresh agreement with a new licensee, and the ${LICENSEE} must vacate on expiry.

**5. LOCK-IN PERIOD**

   Both parties agree to a lock-in period of **${lockIn} month(s)** from the commencement date. If the ${LICENSEE} terminates the Agreement before the lock-in period expires, the ${LICENSEE} shall be liable to pay **one month's license fee as termination charges**. If the ${LICENSOR} asks the ${LICENSEE} to vacate during the lock-in period, the ${LICENSOR} shall compensate the ${LICENSEE} for loss and inconvenience caused.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**PART B — COVENANTS OF THE ${LICENSEE}**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The ${LICENSEE} hereby covenants, undertakes and agrees with the ${LICENSOR} as follows:

**6. USE OF PREMISES**

   **6.1** The ${LICENSEE} shall use the Licensed Premises for **residential purposes only**, exclusively for the ${LICENSEE} and their immediate family members listed in Schedule III of this Agreement.

   **6.2** The ${LICENSEE} shall NOT use the Licensed Premises for any commercial activity including but not limited to paying guest accommodation, guest house, service apartment, hotel, coaching centre or any business or trade.

   **6.3** The ${LICENSEE} shall NOT store within or around the Licensed Premises any materials that are hazardous, dangerous, flammable, explosive, narcotic, or prohibited by any law, rule or regulation including firearms, ammunition, liquor (unless lawfully permitted), RDX or any other restricted substances.

   **6.4** The ${LICENSEE} shall NOT conduct any unlawful, immoral, or illegal activity in or from the Licensed Premises.

**7. SOCIETY RULES AND REGULATIONS**

   **7.1** The ${LICENSEE} shall follow all the rules, regulations and bye-laws laid down by the **Apartment Owners Association / Resident Welfare Association / Co-operative Housing Society** of the building${society ? ` (${society})` : ''}, as amended from time to time.

   **7.2** The ${LICENSEE} shall obtain a **No Objection Certificate (NOC)** from the Society/Association as required, and shall submit their identity documents for registration as a nominal member if mandated.

   **7.3** The ${LICENSEE} shall comply with all visitor registration and gate pass requirements of the Society/building management.

   **7.4** The ${LICENSEE} shall NOT cause any nuisance, annoyance or disturbance to other residents of the building or neighbourhood, including making noise during quiet hours (11:00 PM to 6:00 AM).

   **7.5** The ${LICENSEE} shall abide by all parking rules of the Society. Only authorised vehicles as per the ${LICENSOR}'s allocation shall be parked in the designated parking area.

**8. MAINTENANCE AND REPAIRS**

   **8.1** The ${LICENSEE} shall maintain the Licensed Premises, all fixtures, fittings and appliances in good and working condition, subject to normal wear and tear.

   **8.2** All **minor day-to-day repairs** (such as replacing bulbs, fuses, tap washers, minor plumbing repairs, etc.) shall be carried out by the ${LICENSEE} at their own cost.

   **8.3** Any **damage caused by the ${LICENSEE}'s negligence** — including damage to walls, flooring, doors, windows, sanitary fittings, electrical installations, or furniture/appliances listed in Schedule II — shall be repaired or replaced by the ${LICENSEE} at their own cost.

   **8.4** The ${LICENSEE} shall NOT make any structural alteration, addition, or modification to the Licensed Premises, including but not limited to:
      (a) Breaking or altering walls, doors, windows or flooring;
      (b) Installing A/C units, geysers or fixtures requiring drilling or structural changes, without prior written consent of the ${LICENSOR};
      (c) Constructing temporary or permanent structures inside or outside the Licensed Premises.
   Any holes caused by drilling, A/C ducting, nails etc. must be repaired and walls restored to original condition by the ${LICENSEE} before vacating.

   **8.5** The ${LICENSEE} shall NOT affix any sign boards, name plates, or advertisements on any part of the building exterior or common areas.

**9. UTILITIES AND CHARGES**

   **9.1 Electricity:** The ${LICENSEE} shall pay electricity charges directly to **${elec}** as per actual meter readings. The ${LICENSEE} shall pay the electricity bill **before the due date** to avoid disconnection. Any arrears at the time of vacating shall be settled before handover.

   **9.2 Water:** The ${LICENSEE} shall pay water charges as applicable to the Society/Municipal authority.

   **9.3 Maintenance:** The ${LICENSEE} shall pay Society maintenance charges of **${maint}** directly to the Society/Association. Any outstanding maintenance dues at vacating shall be settled before the ${LICENSOR} releases the Security Deposit.

   **9.4 Other Utilities:** All charges for gas connection, internet, telephone, DTH/cable TV and any other utilities shall be paid by the ${LICENSEE} directly to the respective service providers.

   **9.5** The ${LICENSEE} shall ensure all utility accounts are in the ${LICENSEE}'s name or the ${LICENSOR}'s name as applicable, and shall NOT default on any utility payment during the tenure of this Agreement.

**10. SUBLETTING AND ASSIGNMENT**

   **10.1** The ${LICENSEE} shall NOT transfer, assign, sublet, under-let, re-let, or part with possession of the Licensed Premises or any part thereof to any third party under any circumstances.

   **10.2** The ${LICENSEE} shall NOT allow any person(s) other than those listed in Schedule III to reside permanently in the Licensed Premises without prior written consent of the ${LICENSOR}.

   **10.3** Temporary guests may stay for a maximum of **7 (seven) consecutive days** without prior written consent. Any guest stay beyond 7 days requires written intimation to the ${LICENSOR} and compliance with Society rules.

**11. INSPECTION AND ACCESS**

   **11.1** The ${LICENSEE} shall permit the ${LICENSOR} and/or their authorised representatives to enter and inspect the Licensed Premises at **reasonable hours with 24 hours advance notice**, for the purpose of inspection, repairs, or showing the premises to prospective licensees.

   **11.2** During the **last 2 months** of the license period, the ${LICENSEE} shall cooperate with the ${LICENSOR} and allow prospective new licensees/tenants to inspect the premises at reasonable times.

   **11.3** In case of any emergency (fire, flood, gas leak, structural damage), the ${LICENSOR} may enter the Licensed Premises without prior notice.

**12. PROHIBITED ACTIVITIES AND SPECIAL RESTRICTIONS**

   **12.1** The ${LICENSEE} shall NOT use this Agreement for obtaining any **Loan, Home Loan, Credit Card, or any financial instrument** from any bank or financial institution.

   **12.2** The ${LICENSEE} shall NOT use the Licensed Premises to register for **Goods and Services Tax (GST)**, obtain a trade licence, or represent it as their principal place of business without prior written consent of the ${LICENSOR}. Any such action shall constitute a material breach leading to immediate termination.

   **12.3** The ${LICENSEE} shall NOT keep **pets or animals** in the Licensed Premises without prior written consent of the ${LICENSOR} and the Society.${d.petsAllowed === 'yes' ? ' (Pets are permitted in this Agreement as mutually agreed.)' : ''}

   **12.4** The ${LICENSEE} shall NOT smoke inside the Licensed Premises.${d.smokingAllowed === 'yes' ? ' (Smoking terms as mutually agreed.)' : ''}

   **12.5** The ${LICENSEE} shall NOT throw garbage, waste, or any article from windows, balconies or common areas. Garbage disposal shall be done as per Society rules.

**13. VACATING AND RESTORATION**

   **13.1** On expiry of this Agreement, or upon its earlier termination, the ${LICENSEE} shall:
      (a) Vacate the Licensed Premises **without delay**;
      (b) Remove all personal belongings and items NOT provided by the ${LICENSOR};
      (c) Return the Licensed Premises in **the same condition** as received, with all fixtures, fittings and appliances from Schedule II intact and in working order;
      (d) Hand over **all keys** (main door, bedroom, mailbox, parking, gym, etc.);
      (e) Complete any repairs required due to ${LICENSEE}'s use;
      (f) Clear all outstanding utility bills, maintenance charges and other dues;
      (g) Provide vacant possession to the ${LICENSOR}.

   **13.2** The premises must be returned in a **clean, ready-to-occupy condition**. If additional cleaning, painting or repairs are required beyond normal wear and tear, the cost shall be deducted from the Security Deposit.

   **13.3** Any nails, hooks, or fixtures installed by the ${LICENSEE} must be removed and the walls patched and restored to original condition before vacating.

   **13.4** In case the ${LICENSEE} fails to vacate on the date of expiry, the ${LICENSOR} shall be entitled to:
      (a) Recover **double the monthly license fee as compensation** (calculated on a per-day basis) for every day of overstay;
      (b) Remove the ${LICENSEE}'s belongings from the premises; and
      (c) Take such other legal action as may be available under law.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**PART C — COVENANTS OF THE ${LICENSOR}**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The ${LICENSOR} hereby covenants, undertakes and agrees as follows:

**14. QUIET ENJOYMENT**

   The ${LICENSOR} covenants that the ${LICENSEE}, paying the license fee and observing all terms herein, shall be entitled to **quietly and peacefully use and enjoy** the Licensed Premises during the license period, without any interference, disturbance or interruption by the ${LICENSOR} or any person claiming through the ${LICENSOR}.

**15. TITLE AND ENCUMBRANCES**

   **15.1** The ${LICENSOR} hereby states and warrants that:
      (a) The ${LICENSOR} is the lawful owner of the Licensed Premises and has full authority to enter into this Agreement;
      (b) The ${LICENSOR} has NOT sold, assigned, gifted, mortgaged, or created any third-party interest in the Licensed Premises that would affect the ${LICENSEE}'s peaceful occupation;
      (c) There is **no litigation pending** in any court touching the Licensed Premises;
      (d) The Licensed Premises is free from all encumbrances affecting the ${LICENSEE}'s right to use it.

   **15.2** The ${LICENSOR} shall be entitled to create a mortgage or charge on the Licensed Premises to any Bank or financial institution without handing over possession, provided such mortgage is subject to the terms of this Agreement.

**16. TAXES AND STATUTORY DUES**

   All **property taxes, municipal taxes, house tax, property rates, cesses, assessments** and other statutory levies on the Licensed Premises shall be paid by the **${LICENSOR}** only. The ${LICENSEE} shall not be responsible for any such payment.

**17. MAJOR STRUCTURAL REPAIRS**

   The ${LICENSOR} shall attend to any **major structural defects** in the Licensed Premises upon receiving written notice of such defects from the ${LICENSEE}. The ${LICENSOR} shall carry out such repairs within a **reasonable time** after receiving the notice.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**PART D — TERMINATION**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**18. NOTICE OF TERMINATION**

   Either party shall have the right to terminate this License by giving **${notice} month(s) prior written notice** to the other party. Notice shall be sent by:
      (a) Registered Post / Speed Post to the address mentioned in this Agreement; OR
      (b) Email to the email address provided by each party.
   On expiry of the notice period, the ${LICENSEE} shall deliver vacant possession as described in Clause 13.

**19. TERMINATION FOR BREACH**

   **19.1** The ${LICENSOR} is entitled to terminate this Agreement immediately (or with such notice as stipulated) if the ${LICENSEE}:
      (a) Defaults in payment of license fee for more than **15 (fifteen) days** beyond the grace period;
      (b) Commits any breach of the terms of this Agreement;
      (c) Uses the Licensed Premises for any commercial, illegal or immoral purpose;
      (d) Sublets or parts with possession of the Licensed Premises;
      (e) Causes wilful damage to the Licensed Premises;
      (f) Violates Society rules repeatedly despite written warnings.

   **19.2** In case of breach, the ${LICENSOR} shall serve a notice of default on the ${LICENSEE}. The ${LICENSEE} shall rectify the default within **48 hours** of receipt of such notice, failing which the License shall stand terminated and the ${LICENSEE} shall hand over the premises forthwith.

**20. TERMINATION DUE TO INSOLVENCY**

   In the event the ${LICENSEE} is declared insolvent, or wound up, or a receiver is appointed by any Court, this License shall stand terminated forthwith and the ${LICENSOR} shall be entitled to resume possession of the Licensed Premises immediately.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**PART E — GENERAL PROVISIONS**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**21. INDEMNITY**

   **21.1** Both parties undertake to fully indemnify and keep each other harmless from any losses, damages, claims or proceedings arising out of non-compliance or breach of this Agreement.

   **21.2** The ${LICENSEE} shall NOT be liable for loss or damage caused to the Licensed Premises due to natural calamities (fire, lightning, earthquake, flood, storm, riot, terrorism, act of God), or due to any structural defects not caused by the ${LICENSEE}'s negligence.

**22. FORCE MAJEURE**

   Neither party shall be liable for failure or delay in performance of obligations under this Agreement due to causes beyond their reasonable control including natural disasters, pandemic, governmental restrictions, war or civil unrest.

**23. DISPUTE RESOLUTION**

   **23.1** Any dispute, difference or claim arising out of or in connection with this Agreement, or its breach, termination or validity, shall first be attempted to be resolved by **mutual negotiation** between the parties within 30 days.

   **23.2** If not resolved by negotiation, the matter shall be referred to **Arbitration** under the **Arbitration and Conciliation Act, 1996**, by a sole arbitrator appointed by mutual consent. The arbitration shall be conducted in **${execPlace}**.

   **23.3** Subject to Clause 23.1 and 23.2, the courts at **${d.city || execPlace}** shall have exclusive jurisdiction over any legal proceedings arising from this Agreement.

**24. GOVERNING LAW**

   This Agreement shall be governed by and construed in accordance with the **laws of India**, including the Indian Easements Act, 1882, the Transfer of Property Act, 1882, the Registration Act, 1908, and all applicable State laws.

**25. NOTICES**

   All notices under this Agreement shall be in writing and served at:
   **${LICENSOR}:** ${d.landlordAddress}
   **${LICENSEE}:** ${d.tenantAddress}

**26. ENTIRE AGREEMENT**

   This Agreement (including all Schedules annexed hereto) constitutes the entire agreement between the parties with respect to the Licensed Premises and supersedes all prior negotiations, representations and agreements. This Agreement may only be amended by a written document signed by both parties.

**27. MISCELLANEOUS**

   **27.1** The original copy of this Agreement shall be retained by the **${LICENSOR}** and a photocopy / scanned copy shall be provided to the **${LICENSEE}**.

   **27.2** If any provision of this Agreement is held to be invalid, illegal or unenforceable, the remaining provisions shall continue in full force and effect.

   **27.3** The failure of either party to enforce any right under this Agreement shall not constitute a waiver of that right.

   **27.4** Both parties confirm that they have read and fully understood all the terms of this Agreement and have signed it voluntarily, without any undue influence, coercion or pressure.

${d.specialClauses ? `\n**28. SPECIAL / ADDITIONAL CLAUSES**\n\n   ${d.specialClauses}\n` : ''}

${furnitureSchedule}
${familySchedule}
${paymentSchedule}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**EXECUTION**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**IN WITNESS WHEREOF**, the ${LICENSOR} and the ${LICENSEE} have hereunto set and subscribed their respective signatures (or by way of thumb impression; or electronic signatures via Aadhaar eSign) on the day, month and year first above mentioned, in the presence of the following witnesses:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**WITNESSES:**

**Witness 1:**

Name:         ${d.witness1Name || '___________________________________'}
Address:      ${d.witness1Address || '___________________________________'}
              ___________________________________
Signature:    ___________________________________
Date:         ___________________________________


**Witness 2:**

Name:         ${d.witness2Name || '___________________________________'}
Address:      ${d.witness2Address || '___________________________________'}
              ___________________________________
Signature:    ___________________________________
Date:         ___________________________________

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Signed, Sealed and Delivered by:**

**${LICENSOR}**                                          **${LICENSEE}**

___________________________________            ___________________________________
**${d.landlordName}**                                  **${d.tenantName}**

Place: ${execPlace}                                    Place: ${execPlace}
Date:  ___________________________________     Date:  ___________________________________

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**[FOR NOTARY / SUB-REGISTRAR USE ONLY]**

Execution admitted before me:

Name & Designation: ___________________________________
Registration No.:   ___________________________________
Seal & Signature:   ___________________________________
Date:               ___________________________________
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

*Generated by PropLedger (propledger.in) — AI-powered property management for Indian landlords.*
*This document should be printed on stamp paper of appropriate value as per your State's Stamp Act and signed in the presence of witnesses. For registration, present before the Sub-Registrar's office with original identity documents of both parties.*`;
}

function formatTable(headers, rows) {
  const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i]||'').toString().length)) + 2);
  const line = colWidths.map(w => '─'.repeat(w)).join('┼');
  const headerRow = headers.map((h, i) => h.padEnd(colWidths[i])).join('│');
  const dataRows = rows.map(r => r.map((c, i) => (c||'').toString().padEnd(colWidths[i])).join('│')).join('\n');
  return `┌${colWidths.map(w => '─'.repeat(w)).join('┬')}┐\n│${headerRow}│\n├${line}┤\n│${dataRows.split('\n').join('│\n│')}│\n└${colWidths.map(w => '─'.repeat(w)).join('┴')}┘`;
}

function numberToWordsOrdinal(n) {
  const words = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen','Twenty','Twenty-One','Twenty-Two','Twenty-Three','Twenty-Four'];
  return words[n] || n.toString();
}

function formatDate(dateStr) {
  if (!dateStr) return '__________';
  try { return new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }); }
  catch { return dateStr; }
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
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function cvt(n) { let r=''; if(n>=100){r+=ones[Math.floor(n/100)]+' Hundred ';n%=100;} if(n>=20){r+=tens[Math.floor(n/10)]+' ';n%=10;} if(n>0)r+=ones[n]+' '; return r; }
  let r='', n=num;
  if(n>=10000000){r+=cvt(Math.floor(n/10000000))+'Crore ';n%=10000000;}
  if(n>=100000){r+=cvt(Math.floor(n/100000))+'Lakh ';n%=100000;}
  if(n>=1000){r+=cvt(Math.floor(n/1000))+'Thousand ';n%=1000;}
  r+=cvt(n);
  return r.trim()+' Only';
}
