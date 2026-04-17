// /api/send-email.js
// PropLedger — Transactional Email via Resend
// Same pattern as Arthnumro & CrushTheCert

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

const EMAIL_FROM = 'PropLedger <hello@propledger.in>';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://propledger.in');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { type, to, data } = req.body;

  if (!type || !to) return res.status(400).json({ error: 'Missing type or recipient' });

  try {
    let emailPayload;

    switch (type) {

      // ── Magic link / sign in ──
      case 'magic_link':
        emailPayload = {
          from: EMAIL_FROM,
          to,
          subject: 'Your PropLedger sign-in link',
          html: magicLinkTemplate(data.link, data.name),
        };
        break;

      // ── Welcome email (new signup) ──
      case 'welcome':
        emailPayload = {
          from: EMAIL_FROM,
          to,
          subject: 'Welcome to PropLedger 🏠',
          html: welcomeTemplate(data.name),
        };
        break;

      // ── Agreement generated ──
      case 'agreement_generated':
        emailPayload = {
          from: EMAIL_FROM,
          to,
          subject: `Your rental agreement for ${data.property} is ready`,
          html: agreementReadyTemplate(data.name, data.property, data.tenant, data.dashboardUrl),
        };
        break;

      // ── Pro upgrade confirmation ──
      case 'pro_welcome':
        emailPayload = {
          from: EMAIL_FROM,
          to,
          subject: '⚡ You\'re now on PropLedger Pro!',
          html: proWelcomeTemplate(data.name),
        };
        break;

      // ── Rent reminder (V2 feature) ──
      case 'rent_reminder':
        emailPayload = {
          from: EMAIL_FROM,
          to,
          subject: `Rent reminder — ₹${data.amount} due on ${data.dueDate}`,
          html: rentReminderTemplate(data.tenantName, data.amount, data.dueDate, data.property, data.paymentLink),
        };
        break;

      // ── eSign invitation to landlord/tenant ──
      case 'esign_invite':
        emailPayload = {
          from: EMAIL_FROM,
          to,
          subject: `Action Required: Sign your Rental Agreement on PropLedger`,
          html: esignInviteTemplate(data)
        };
        break;

      default:
        return res.status(400).json({ error: `Unknown email type: ${type}` });
    }

    const result = await resend.emails.send(emailPayload);
    return res.status(200).json({ success: true, id: result.id });

  } catch (error) {
    console.error('Email send error:', error);
    return res.status(500).json({ error: 'Failed to send email' });
  }
};

// ── EMAIL TEMPLATES ──

function baseLayout(content) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PropLedger</title>
</head>
<body style="margin:0;padding:0;background:#f4f2ee;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ee;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- HEADER -->
        <tr>
          <td style="background:#0a0f1e;border-radius:12px 12px 0 0;padding:28px 40px;text-align:center;">
            <span style="font-family:Georgia,serif;font-size:26px;font-weight:700;color:#f8f6f0;letter-spacing:-0.5px;">
              Prop<span style="color:#c9a84c;">Ledger</span>
            </span>
            <div style="font-size:11px;color:#5a6478;margin-top:4px;letter-spacing:1.5px;text-transform:uppercase;">Property Management</div>
          </td>
        </tr>

        <!-- BODY -->
        <tr>
          <td style="background:#ffffff;padding:40px;border-left:1px solid #e8e4d9;border-right:1px solid #e8e4d9;">
            ${content}
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background:#0f1628;border-radius:0 0 12px 12px;padding:24px 40px;text-align:center;">
            <p style="font-size:12px;color:#5a6478;margin:0 0 8px;">
              © 2025 PropLedger · Built in India 🇮🇳
            </p>
            <p style="font-size:11px;color:#3a4258;margin:0;">
              <a href="https://propledger.in" style="color:#c9a84c;text-decoration:none;">propledger.in</a>
              &nbsp;·&nbsp;
              <a href="mailto:hello@propledger.in" style="color:#5a6478;text-decoration:none;">hello@propledger.in</a>
              &nbsp;·&nbsp;
              <a href="https://propledger.in/unsubscribe" style="color:#5a6478;text-decoration:none;">Unsubscribe</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function magicLinkTemplate(link, name) {
  return baseLayout(`
    <h1 style="font-family:Georgia,serif;font-size:28px;color:#0a0f1e;margin:0 0 8px;letter-spacing:-0.5px;">Sign in to PropLedger</h1>
    <p style="font-size:15px;color:#5a6478;margin:0 0 32px;line-height:1.6;">Hi${name ? ' ' + name : ''},<br>Click the button below to sign in. This link expires in 10 minutes.</p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${link}" style="display:inline-block;background:#c9a84c;color:#0a0f1e;font-size:15px;font-weight:700;padding:14px 36px;border-radius:8px;text-decoration:none;letter-spacing:0.3px;">
        Sign in to PropLedger →
      </a>
    </div>
    <p style="font-size:13px;color:#8892a4;line-height:1.6;margin:24px 0 0;">If you didn't request this, you can safely ignore this email. Someone may have entered your email address by mistake.</p>
    <hr style="border:none;border-top:1px solid #f0ece4;margin:24px 0;">
    <p style="font-size:12px;color:#aab0be;margin:0;">If the button doesn't work, copy and paste this link into your browser:<br><span style="color:#c9a84c;word-break:break-all;">${link}</span></p>
  `);
}

function welcomeTemplate(name) {
  return baseLayout(`
    <h1 style="font-family:Georgia,serif;font-size:28px;color:#0a0f1e;margin:0 0 8px;letter-spacing:-0.5px;">Welcome to PropLedger, ${name || 'there'}! 🏠</h1>
    <p style="font-size:15px;color:#5a6478;margin:0 0 24px;line-height:1.6;">You're now part of India's smartest property management platform. Here's what you can do right now:</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      ${[
        ['📝', 'Generate a Rental Agreement', 'AI-powered, India-compliant, PDF-ready in 3 minutes'],
        ['🔍', 'Tenant Screening (V2)', 'Aadhaar, credit & background checks — coming soon'],
        ['💰', 'Rent Tracking (V2)', 'Auto-reminders and payment tracking — coming soon'],
      ].map(([icon, title, desc]) => `
        <tr>
          <td style="padding:12px;background:#f8f7f4;border-radius:10px;margin-bottom:10px;display:block;">
            <span style="font-size:20px;">${icon}</span>
            <strong style="display:block;font-size:14px;color:#0a0f1e;margin:6px 0 3px;">${title}</strong>
            <span style="font-size:13px;color:#8892a4;">${desc}</span>
          </td>
        </tr>
        <tr><td style="height:8px;"></td></tr>
      `).join('')}
    </table>
    <div style="text-align:center;">
      <a href="https://propledger.in/dashboard.html" style="display:inline-block;background:#c9a84c;color:#0a0f1e;font-size:14px;font-weight:700;padding:13px 32px;border-radius:8px;text-decoration:none;">
        Go to Dashboard →
      </a>
    </div>
  `);
}

function agreementReadyTemplate(name, property, tenant, dashboardUrl) {
  return baseLayout(`
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:48px;">📄</div>
    </div>
    <h1 style="font-family:Georgia,serif;font-size:26px;color:#0a0f1e;margin:0 0 8px;letter-spacing:-0.5px;">Your agreement is ready</h1>
    <p style="font-size:15px;color:#5a6478;margin:0 0 24px;line-height:1.6;">Hi ${name || 'there'},<br>Your rental agreement for <strong style="color:#0a0f1e;">${property}</strong> with tenant <strong style="color:#0a0f1e;">${tenant}</strong> has been generated successfully.</p>
    <div style="background:#f8f7f4;border:1px solid #e8e4d9;border-radius:10px;padding:20px;margin-bottom:28px;">
      <p style="font-size:13px;color:#5a6478;margin:0 0 4px;">Property</p>
      <p style="font-size:15px;font-weight:600;color:#0a0f1e;margin:0 0 14px;">${property}</p>
      <p style="font-size:13px;color:#5a6478;margin:0 0 4px;">Tenant</p>
      <p style="font-size:15px;font-weight:600;color:#0a0f1e;margin:0;">${tenant}</p>
    </div>
    <div style="text-align:center;">
      <a href="${dashboardUrl || 'https://propledger.in/dashboard.html'}" style="display:inline-block;background:#c9a84c;color:#0a0f1e;font-size:14px;font-weight:700;padding:13px 32px;border-radius:8px;text-decoration:none;">
        View & Download Agreement →
      </a>
    </div>
    <p style="font-size:12px;color:#aab0be;margin:24px 0 0;line-height:1.6;">Remember to have the agreement reviewed by a lawyer before registration if required by your state.</p>
  `);
}

function proWelcomeTemplate(name) {
  return baseLayout(`
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-size:48px;">⚡</div>
    </div>
    <h1 style="font-family:Georgia,serif;font-size:28px;color:#0a0f1e;margin:0 0 8px;text-align:center;letter-spacing:-0.5px;">You're on Pro, ${name || 'there'}!</h1>
    <p style="font-size:15px;color:#5a6478;margin:0 0 28px;line-height:1.6;text-align:center;">Your PropLedger account has been upgraded. You now have access to the full platform.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      ${[
        ['✓', 'Unlimited rental agreements'],
        ['✓', 'Tenant screening — Aadhaar, credit & background'],
        ['✓', 'Rent tracker with auto-reminders'],
        ['✓', 'Document vault & AI verification'],
        ['✓', 'Priority support'],
      ].map(([icon, text]) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #f0ece4;">
            <span style="color:#2dd4a0;font-weight:700;margin-right:10px;">${icon}</span>
            <span style="font-size:14px;color:#0a0f1e;">${text}</span>
          </td>
        </tr>
      `).join('')}
    </table>
    <div style="text-align:center;">
      <a href="https://propledger.in/dashboard.html" style="display:inline-block;background:#c9a84c;color:#0a0f1e;font-size:14px;font-weight:700;padding:13px 32px;border-radius:8px;text-decoration:none;">
        Explore Pro Features →
      </a>
    </div>
  `);
}

function rentReminderTemplate(tenantName, amount, dueDate, property, paymentLink) {
  return baseLayout(`
    <h1 style="font-family:Georgia,serif;font-size:26px;color:#0a0f1e;margin:0 0 8px;letter-spacing:-0.5px;">Rent reminder 📅</h1>
    <p style="font-size:15px;color:#5a6478;margin:0 0 24px;line-height:1.6;">Hi ${tenantName},<br>This is a friendly reminder that your rent payment is due soon.</p>
    <div style="background:#fffbf0;border:1px solid #f0e4b8;border-radius:10px;padding:24px;margin-bottom:28px;text-align:center;">
      <div style="font-family:Georgia,serif;font-size:36px;font-weight:700;color:#0a0f1e;">₹${parseInt(amount).toLocaleString('en-IN')}</div>
      <div style="font-size:14px;color:#8892a4;margin-top:6px;">Due on ${dueDate}</div>
      <div style="font-size:13px;color:#5a6478;margin-top:4px;">${property}</div>
    </div>
    ${paymentLink ? `
    <div style="text-align:center;margin-bottom:20px;">
      <a href="${paymentLink}" style="display:inline-block;background:#c9a84c;color:#0a0f1e;font-size:14px;font-weight:700;padding:13px 32px;border-radius:8px;text-decoration:none;">
        Pay Now via UPI / Card →
      </a>
    </div>
    ` : ''}
    <p style="font-size:13px;color:#8892a4;margin:0;line-height:1.6;">If you've already paid, please ignore this reminder. Contact your landlord if you have any questions.</p>
  `);
}

function esignInviteTemplate(data) {
  const { name, role, signingUrl, propertyAddress, otherParty } = data;
  return emailWrapper(`
    <h2 style="font-family:'Georgia',serif;font-size:22px;color:#f8f6f0;margin:0 0 8px;">
      Your Signature is Required
    </h2>
    <p style="color:#8892a4;font-size:14px;margin:0 0 24px;">
      You have been requested to digitally sign a Leave & License Agreement on PropLedger.
    </p>

    <div style="background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.25);border-radius:12px;padding:20px;margin-bottom:24px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="color:#8892a4;font-size:12px;padding:4px 0;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Your Role</td>
          <td style="color:#f8f6f0;font-size:14px;padding:4px 0;text-align:right;">${role}</td>
        </tr>
        <tr>
          <td style="color:#8892a4;font-size:12px;padding:4px 0;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Property</td>
          <td style="color:#f8f6f0;font-size:14px;padding:4px 0;text-align:right;">${propertyAddress || 'As per agreement'}</td>
        </tr>
        <tr>
          <td style="color:#8892a4;font-size:12px;padding:4px 0;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Other Party</td>
          <td style="color:#f8f6f0;font-size:14px;padding:4px 0;text-align:right;">${otherParty || ''}</td>
        </tr>
      </table>
    </div>

    <p style="color:#e8e4d9;font-size:14px;line-height:1.7;margin:0 0 24px;">
      Hi <strong>${name}</strong>, please review and sign the rental agreement using your Aadhaar number. 
      The signing process takes less than 2 minutes and is legally valid under the IT Act, 2000.
    </p>

    <div style="text-align:center;margin:32px 0;">
      <a href="${signingUrl}" style="display:inline-block;background:#c9a84c;color:#0a0f1e;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:15px;font-weight:700;font-family:'Outfit',sans-serif;letter-spacing:0.3px;">
        ✍️ Sign Agreement Now →
      </a>
    </div>

    <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:16px;margin-bottom:24px;">
      <p style="color:#8892a4;font-size:12px;margin:0 0 8px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">What you'll need:</p>
      <ul style="color:#e8e4d9;font-size:13px;margin:0;padding-left:20px;line-height:2;">
        <li>Your Aadhaar number</li>
        <li>Mobile phone linked to your Aadhaar (for OTP)</li>
      </ul>
    </div>

    <p style="color:#5a6478;font-size:12px;line-height:1.6;margin:0;">
      This link is unique to you and expires in 30 days. Do not share it with anyone.
      Powered by Surepass · NSDL Aadhaar eSign · Legally valid under IT Act 2000.
    </p>
  `);
}
