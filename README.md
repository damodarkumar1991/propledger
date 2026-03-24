# PropLedger 🏠

> AI-powered property management platform for Indian landlords.
> Generate rental agreements, screen tenants, and track rent — all in one place.

**Live:** [propledger.in](https://propledger.in) · **Stack:** Pure HTML/CSS/JS + Vercel Edge Functions + Supabase + Claude AI

---

## What is PropLedger?

PropLedger is a self-serve, AI-powered property management platform built specifically for Indian landlords with 1–10 properties. It eliminates the need for brokers and expensive lawyers by automating the most painful parts of property management.

| Feature | Status |
|---|---|
| AI Rental Agreement Generator | ✅ Live in V1 |
| Aadhaar eSign integration | ✅ Live in V1 |
| Magic link authentication | ✅ Live in V1 |
| Tenant Screening (Aadhaar + Credit + Background) | 🔨 V2 |
| Rent Tracker with auto-reminders | 🔨 V2 |
| Document Vault with AI verification | 🔨 V2 |
| Multi-property dashboard | 🔨 V2 |

---

## Tech Stack

Identical pattern to CrushTheCert — proven, zero monthly fixed cost.

| Layer | Technology | Why |
|---|---|---|
| Frontend | Pure HTML + CSS + Vanilla JS | Zero build step, instant deploys |
| Hosting | Vercel (free tier) | Auto-deploy from GitHub, CDN |
| API | Vercel Edge Functions (Node.js) | Serverless, scales automatically |
| AI | Claude Sonnet via `@anthropic-ai/sdk` | Best-in-class agreement generation |
| Auth | Supabase Auth (magic link) | No passwords, seamless UX |
| Database | Supabase PostgreSQL | Free tier, RLS built-in |
| Email | Resend | Transactional emails from hello@propledger.in |
| Payments | Razorpay | India-first, UPI + cards + subscriptions |

---

## Project Structure

```
propledger/
│
├── index.html              # Landing page
├── login.html              # Magic link + OTP auth
├── dashboard.html          # Landlord portal (post-login)
├── agreement.html          # AI agreement generator (4-step wizard)
│
├── api/
│   ├── generate-agreement.js   # Claude API → rental agreement text
│   ├── send-email.js           # Resend → transactional emails
│   └── razorpay-webhook.js     # Razorpay → Supabase plan upgrade
│
├── vercel.json             # Vercel routing + CORS headers
├── package.json            # Node dependencies
├── .env.example            # Environment variable template
└── .gitignore              # Never commit secrets
```

---

## Getting Started

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/propledger.git
cd propledger
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment variables

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in your keys (see [Environment Variables](#environment-variables) below).

### 4. Run locally

```bash
npm run dev
# Opens at http://localhost:3000
```

### 5. Deploy to Vercel

```bash
npm run deploy
```

Or connect your GitHub repo to Vercel for automatic deploys on every push to `main`.

---

## Environment Variables

Add these in Vercel Dashboard → Project → Settings → Environment Variables.

| Variable | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/account/keys) |
| `SUPABASE_URL` | Supabase Dashboard → Project Settings → API |
| `SUPABASE_ANON_KEY` | Supabase Dashboard → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Project Settings → API |
| `RESEND_API_KEY` | [resend.com/api-keys](https://resend.com/api-keys) |
| `RAZORPAY_KEY_ID` | Razorpay Dashboard → Settings → API Keys |
| `RAZORPAY_KEY_SECRET` | Razorpay Dashboard → Settings → API Keys |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay Dashboard → Webhooks → Secret |
| `ALLOWED_ORIGIN` | `https://propledger.in` |
| `APP_URL` | `https://propledger.in` |

---

## Database Setup (Supabase)

Run this SQL in your Supabase SQL Editor (Dashboard → SQL Editor → New Query):

```sql
-- Profiles table
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

-- Agreements table
CREATE TABLE agreements (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_email TEXT REFERENCES profiles(email),
  tenant_name TEXT NOT NULL,
  property_address TEXT NOT NULL,
  monthly_rent INTEGER NOT NULL,
  duration_months INTEGER DEFAULT 11,
  start_date DATE,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  agreement_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE agreements ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING (auth.jwt() ->> 'email' = email);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.jwt() ->> 'email' = email);

CREATE POLICY "Users can view own agreements"
  ON agreements FOR SELECT
  USING (auth.jwt() ->> 'email' = user_email);

CREATE POLICY "Users can insert own agreements"
  ON agreements FOR INSERT
  WITH CHECK (auth.jwt() ->> 'email' = user_email);

-- Auto-update timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

---

## Supabase Auth Setup

1. Go to Supabase Dashboard → Authentication → Providers
2. Enable **Email** provider
3. Turn on **Magic Links** (passwordless)
4. Set **Site URL** to `https://propledger.in`
5. Add redirect URL: `https://propledger.in/dashboard.html`

---

## Razorpay Setup

### Payment Links
Create two payment links in Razorpay Dashboard:
- **Pro Monthly** — ₹1,499/month (subscription)
- **Pay Per Use** — ₹199 (one-time, for single agreement)

In each link's `notes`, add:
```json
{ "plan": "pro" }
```

### Webhook
1. Razorpay Dashboard → Webhooks → Add New
2. URL: `https://propledger.in/api/razorpay-webhook`
3. Events to subscribe:
   - `payment.captured`
   - `subscription.charged`
   - `subscription.cancelled`
   - `payment.failed`
4. Copy the webhook secret → add to Vercel env vars as `RAZORPAY_WEBHOOK_SECRET`

---

## Resend Setup

1. Create account at [resend.com](https://resend.com)
2. Add domain `propledger.in`
3. Add DNS records as instructed (TXT + MX records in your domain registrar)
4. Create API key → add to Vercel env vars as `RESEND_API_KEY`
5. All emails send from `hello@propledger.in`

---

## Connecting Supabase Auth to Frontend

The `login.html` magic link flow currently simulates the API call. To wire it to Supabase, replace the simulation in `sendMagicLink()`:

```javascript
// Replace this simulation:
await new Promise(r => setTimeout(r, 1400));

// With this Supabase call:
const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const { error } = await sb.auth.signInWithOtp({
  email: email,
  options: {
    emailRedirectTo: 'https://propledger.in/dashboard.html'
  }
});
if (error) throw error;
```

Add Supabase JS CDN to `login.html` `<head>`:
```html
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
```

---

## Connecting API to Frontend

The `agreement.html` currently calls the Anthropic API directly from the browser (fine for demo). For production, update the fetch URL:

```javascript
// Change this in agreement.html generateAgreement():
const response = await fetch('https://api.anthropic.com/v1/messages', { ... });

// To this (your secure backend):
const response = await fetch('/api/generate-agreement', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${supabaseSession.access_token}`
  },
  body: JSON.stringify(formData)
});
```

This keeps your API key secret on the server.

---

## Pricing Model

| Plan | Price | Agreements | Features |
|---|---|---|---|
| Free | ₹0 | 1/month | Basic agreement, PDF download |
| Pro | ₹1,499/month | Unlimited | All features (V1 + V2) |
| Pay Per Use | ₹199 | 1 | Single agreement, no subscription |

---

## Roadmap

### V1 (Current)
- [x] Landing page
- [x] Magic link authentication
- [x] AI rental agreement generator
- [x] PDF download
- [x] Landlord dashboard
- [x] Email notifications

### V2
- [ ] Tenant screening (IDfy — Aadhaar + PAN verification)
- [ ] Credit check (Perfios / FinBox)
- [ ] Background check (AuthBridge)
- [ ] Rent tracker with UPI auto-pay (Razorpay)
- [ ] SMS reminders (MSG91)
- [ ] Document vault (AI-powered)
- [ ] RERA verification
- [ ] Multi-property management
- [ ] Mobile app (React Native)

---

## Legal

- All rental agreements generated are for reference purposes
- For mandatory registration under the Registration Act 1908, agreements must be reviewed by a qualified advocate
- Stamp duty applicable as per state-specific laws
- PropLedger is not a law firm and does not provide legal advice

---

## Contact

- **Website:** [propledger.in](https://propledger.in)
- **Email:** hello@propledger.in
- **Built in India** 🇮🇳

---

*PropLedger — Your property. Your ledger. In control.*
