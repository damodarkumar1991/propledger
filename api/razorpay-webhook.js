// /api/razorpay-webhook.js
// PropLedger — Razorpay Payment Webhook
// Mirrors CrushTheCert's stripe-webhook.js pattern
// Handles: checkout.paid → upgrade user plan in Supabase → send welcome email

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Service role — bypasses RLS
);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Verify Razorpay webhook signature ──
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];
  const body = JSON.stringify(req.body);

  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(body)
    .digest('hex');

  if (signature !== expectedSignature) {
    console.error('Invalid Razorpay webhook signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  console.log('Razorpay webhook event:', event.event);

  try {
    switch (event.event) {

      // ── Payment successful ──
      case 'payment.captured':
      case 'subscription.charged': {
        const payment = event.payload.payment?.entity || event.payload.subscription?.entity;
        if (!payment) break;

        const email = payment.email || payment.contact;
        const planNotes = payment.notes || {};
        const plan = planNotes.plan || 'pro'; // Passed when creating payment link
        const name = planNotes.name || '';

        if (!email) {
          console.error('No email in payment payload');
          break;
        }

        // 1. Upsert user in Supabase profiles table
        const { error: upsertError } = await supabase
          .from('profiles')
          .upsert({
            email,
            plan: plan,
            plan_activated_at: new Date().toISOString(),
            razorpay_payment_id: payment.id,
            razorpay_subscription_id: payment.subscription_id || null,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'email' });

        if (upsertError) {
          console.error('Supabase upsert error:', upsertError);
          throw upsertError;
        }

        // 2. Send Pro welcome email via Resend
        await fetch(`${process.env.APP_URL}/api/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'pro_welcome',
            to: email,
            data: { name },
          }),
        });

        console.log(`✅ User upgraded to Pro: ${email}`);
        break;
      }

      // ── Subscription cancelled ──
      case 'subscription.cancelled': {
        const sub = event.payload.subscription?.entity;
        if (!sub?.email_notify) break;

        // Downgrade to free plan
        await supabase
          .from('profiles')
          .update({
            plan: 'free',
            plan_cancelled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('razorpay_subscription_id', sub.id);

        console.log(`User downgraded to Free: subscription ${sub.id}`);
        break;
      }

      // ── Payment failed ──
      case 'payment.failed': {
        const payment = event.payload.payment?.entity;
        console.warn('Payment failed:', payment?.id, payment?.error_description);
        // Optionally: send failure notification email
        break;
      }

      default:
        console.log('Unhandled Razorpay event:', event.event);
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('Webhook handler error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
};

// ─────────────────────────────────────────────────────────
// /vercel.json
// PropLedger Vercel configuration
// ─────────────────────────────────────────────────────────

/*
Save this as vercel.json in your project root:

{
  "version": 2,
  "routes": [
    {
      "src": "/api/(.*)",
      "dest": "/api/$1"
    }
  ],
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "Access-Control-Allow-Origin", "value": "https://propledger.in" },
        { "key": "Access-Control-Allow-Methods", "value": "GET, POST, OPTIONS" },
        { "key": "Access-Control-Allow-Headers", "value": "Content-Type, Authorization" }
      ]
    }
  ],
  "env": {
    "ANTHROPIC_API_KEY": "@anthropic_api_key",
    "SUPABASE_URL": "@supabase_url",
    "SUPABASE_SERVICE_ROLE_KEY": "@supabase_service_role_key",
    "RAZORPAY_WEBHOOK_SECRET": "@razorpay_webhook_secret",
    "RESEND_API_KEY": "@resend_api_key",
    "ALLOWED_ORIGIN": "https://propledger.in",
    "APP_URL": "https://propledger.in"
  }
}
*/

// ─────────────────────────────────────────────────────────
// /api/check-plan.js
// Middleware: Check user plan before allowing API calls
// ─────────────────────────────────────────────────────────

// const { createClient } = require('@supabase/supabase-js');
// 
// module.exports = async function checkPlan(email, requiredPlan = 'free') {
//   const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
// 
//   const { data, error } = await supabase
//     .from('profiles')
//     .select('plan, agreements_this_month')
//     .eq('email', email)
//     .single();
// 
//   if (error || !data) return { allowed: false, reason: 'User not found' };
//
//   if (requiredPlan === 'pro' && data.plan !== 'pro') {
//     return { allowed: false, reason: 'Pro plan required', currentPlan: data.plan };
//   }
//
//   // Free plan limit: 1 agreement/month
//   if (data.plan === 'free' && data.agreements_this_month >= 1) {
//     return { allowed: false, reason: 'Monthly limit reached', limit: 1 };
//   }
//
//   return { allowed: true, plan: data.plan };
// };

// ─────────────────────────────────────────────────────────
// Supabase SQL — Run this in Supabase SQL editor to create tables
// ─────────────────────────────────────────────────────────

/*
-- profiles table
CREATE TABLE profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  agreements_this_month INTEGER DEFAULT 0,
  agreements_total INTEGER DEFAULT 0,
  razorpay_payment_id TEXT,
  razorpay_subscription_id TEXT,
  plan_activated_at TIMESTAMPTZ,
  plan_cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- agreements table
CREATE TABLE agreements (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email TEXT REFERENCES profiles(email),
  tenant_name TEXT NOT NULL,
  property_address TEXT NOT NULL,
  monthly_rent INTEGER NOT NULL,
  duration_months INTEGER DEFAULT 11,
  start_date DATE,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  agreement_text TEXT, -- stored for Pro users only
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE agreements ENABLE ROW LEVEL SECURITY;

-- Users can only read/update their own profile
CREATE POLICY "Users can view own profile" ON profiles FOR SELECT USING (auth.jwt() ->> 'email' = email);
CREATE POLICY "Users can update own profile" ON profiles FOR UPDATE USING (auth.jwt() ->> 'email' = email);

-- Users can only see their own agreements
CREATE POLICY "Users can view own agreements" ON agreements FOR SELECT USING (auth.jwt() ->> 'email' = user_email);
CREATE POLICY "Users can insert own agreements" ON agreements FOR INSERT WITH CHECK (auth.jwt() ->> 'email' = user_email);

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Reset monthly agreement count (run via pg_cron or Supabase Edge Function on 1st of each month)
-- UPDATE profiles SET agreements_this_month = 0;
*/
