// components/TenantVerification.jsx
// Reusable component — works on Dashboard (standalone) and post-agreement screen
// Props:
//   agreementId: string | null  (null = standalone dashboard use)
//   onComplete: (result) => void

import { useState } from 'react';

const STEPS = {
  INTRO:        'intro',
  PAYMENT:      'payment',
  PAN:          'pan',
  AADHAAR:      'aadhaar',
  OTP:          'otp',
  RESULT:       'result',
};

export default function TenantVerification({ agreementId = null, onComplete }) {
  const [step, setStep]                     = useState(STEPS.INTRO);
  const [verificationId, setVerificationId] = useState(null);
  const [panInput, setPanInput]             = useState('');
  const [aadhaarInput, setAadhaarInput]     = useState('');
  const [otpInput, setOtpInput]             = useState('');
  const [result, setResult]                 = useState(null);
  const [panResult, setPanResult]           = useState(null);
  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState('');

  const authToken = () => {
    // Get Supabase session token
    const session = JSON.parse(localStorage.getItem('sb-plumsrlhachflnsmwpsh-auth-token') || '{}');
    return session?.access_token || '';
  };

  // Step: Payment confirmed → create verification session
  const handlePaymentSuccess = async (paymentId) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/kyc/create-verification', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken()}`,
        },
        body: JSON.stringify({
          agreement_id: agreementId,
          payment_id:   paymentId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setVerificationId(data.verification_id);
      setStep(STEPS.PAN);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Step: Verify PAN
  const handlePANVerify = async () => {
    if (!panInput || panInput.length !== 10) {
      setError('Enter a valid 10-character PAN');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/kyc/pan-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pan_number: panInput.toUpperCase(), verification_id: verificationId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.detail);
      setPanResult(data.data);
      setStep(STEPS.AADHAAR);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Step: Generate Aadhaar OTP
  const handleAadhaarOTP = async () => {
    const cleaned = aadhaarInput.replace(/\s/g, '');
    if (cleaned.length !== 12) {
      setError('Aadhaar must be 12 digits');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/kyc/aadhaar-generate-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aadhaar_number: cleaned, verification_id: verificationId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.detail);
      setStep(STEPS.OTP);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Step: Submit OTP
  const handleOTPSubmit = async () => {
    if (otpInput.length !== 6) {
      setError('Enter the 6-digit OTP');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/kyc/aadhaar-submit-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp: otpInput, verification_id: verificationId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.detail);
      setResult(data.data);
      setStep(STEPS.RESULT);
      if (onComplete) onComplete(data.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Simulate Razorpay for now ──────────────────────────────────────────────
  const handleSimulatePayment = () => {
    // TODO: Replace with real Razorpay integration
    handlePaymentSuccess('pay_test_' + Date.now());
  };

  const matchBadge = (status, score) => {
    const config = {
      matched:  { color: '#16a34a', bg: '#dcfce7', icon: '✅', label: `${score}% Match — High Confidence` },
      review:   { color: '#d97706', bg: '#fef3c7', icon: '🟡', label: `${score}% Match — Review Needed` },
      mismatch: { color: '#dc2626', bg: '#fee2e2', icon: '🔴', label: `${score}% Match — Name Mismatch` },
      pending:  { color: '#6b7280', bg: '#f3f4f6', icon: '⏳', label: 'PAN not verified yet' },
    };
    const c = config[status] || config.pending;
    return (
      <span style={{
        background: c.bg, color: c.color,
        padding: '4px 12px', borderRadius: 20,
        fontWeight: 600, fontSize: 13,
      }}>
        {c.icon} {c.label}
      </span>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{
      maxWidth: 480, margin: '0 auto',
      fontFamily: "'Segoe UI', sans-serif",
      background: '#fff', borderRadius: 16,
      boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ background: '#1a2e4a', padding: '20px 24px', color: '#fff' }}>
        <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4, letterSpacing: 1, textTransform: 'uppercase' }}>
          PropLedger · KYC
        </div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>Tenant Verification</div>
        <div style={{ fontSize: 13, opacity: 0.7, marginTop: 4 }}>
          Aadhaar + PAN · ₹199
        </div>
      </div>

      {/* Progress */}
      {step !== STEPS.INTRO && step !== STEPS.RESULT && (
        <div style={{ display: 'flex', gap: 4, padding: '12px 24px', background: '#f8fafc' }}>
          {[STEPS.PAYMENT, STEPS.PAN, STEPS.AADHAAR, STEPS.OTP].map((s, i) => (
            <div key={s} style={{
              flex: 1, height: 4, borderRadius: 2,
              background: [STEPS.PAYMENT, STEPS.PAN, STEPS.AADHAAR, STEPS.OTP].indexOf(step) >= i
                ? '#1a2e4a' : '#e2e8f0',
            }} />
          ))}
        </div>
      )}

      <div style={{ padding: 24 }}>
        {error && (
          <div style={{
            background: '#fee2e2', color: '#dc2626',
            padding: '10px 14px', borderRadius: 8,
            marginBottom: 16, fontSize: 14,
          }}>
            ⚠️ {error}
          </div>
        )}

        {/* INTRO */}
        {step === STEPS.INTRO && (
          <div>
            <p style={{ color: '#475569', fontSize: 14, lineHeight: 1.6, marginBottom: 20 }}>
              Verify your tenant's identity using their Aadhaar and PAN cards.
              A cross-verification report will be generated and saved to your account.
            </p>
            <div style={{ background: '#f8fafc', borderRadius: 10, padding: 16, marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#1a2e4a', marginBottom: 8 }}>
                What you get:
              </div>
              {['✅ Aadhaar identity verification (OTP-based)', '✅ PAN card verification', '✅ Name cross-match report', '✅ Saved to your PropLedger account'].map(t => (
                <div key={t} style={{ fontSize: 13, color: '#475569', padding: '4px 0' }}>{t}</div>
              ))}
            </div>
            <button onClick={() => setStep(STEPS.PAYMENT)} style={btnStyle('#1a2e4a')}>
              Continue to Payment · ₹199
            </button>
          </div>
        )}

        {/* PAYMENT */}
        {step === STEPS.PAYMENT && (
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>Complete Payment</div>
            <div style={{
              border: '1px solid #e2e8f0', borderRadius: 10,
              padding: 16, marginBottom: 20, display: 'flex',
              justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ color: '#475569', fontSize: 14 }}>Tenant Verification (Aadhaar + PAN)</span>
              <span style={{ fontWeight: 700, fontSize: 16 }}>₹199</span>
            </div>
            <button
              onClick={handleSimulatePayment}
              disabled={loading}
              style={btnStyle('#1a2e4a')}
            >
              {loading ? 'Processing...' : 'Pay ₹199 via Razorpay'}
            </button>
          </div>
        )}

        {/* PAN */}
        {step === STEPS.PAN && (
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Step 1 — PAN Verification</div>
            <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
              Enter the tenant's PAN card number
            </p>
            <input
              type="text"
              placeholder="e.g. ABCDE1234F"
              maxLength={10}
              value={panInput}
              onChange={e => setPanInput(e.target.value.toUpperCase())}
              style={inputStyle}
            />
            <button onClick={handlePANVerify} disabled={loading} style={btnStyle('#1a2e4a')}>
              {loading ? 'Verifying...' : 'Verify PAN'}
            </button>
          </div>
        )}

        {/* AADHAAR */}
        {step === STEPS.AADHAAR && (
          <div>
            {panResult && (
              <div style={{ background: '#dcfce7', borderRadius: 10, padding: 12, marginBottom: 16, fontSize: 13 }}>
                ✅ PAN Verified — <strong>{panResult.full_name}</strong>
              </div>
            )}
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Step 2 — Aadhaar Verification</div>
            <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
              Enter the tenant's Aadhaar number. An OTP will be sent to their registered mobile.
            </p>
            <input
              type="text"
              placeholder="XXXX XXXX XXXX"
              maxLength={14}
              value={aadhaarInput}
              onChange={e => {
                const digits = e.target.value.replace(/\D/g, '').slice(0, 12);
                setAadhaarInput(digits.replace(/(\d{4})(?=\d)/g, '$1 ').trim());
              }}
              style={inputStyle}
            />
            <button onClick={handleAadhaarOTP} disabled={loading} style={btnStyle('#1a2e4a')}>
              {loading ? 'Sending OTP...' : 'Send OTP to Tenant\'s Mobile'}
            </button>
          </div>
        )}

        {/* OTP */}
        {step === STEPS.OTP && (
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Step 3 — Enter OTP</div>
            <p style={{ fontSize: 13, color: '#64748b', marginBottom: 16 }}>
              OTP sent to tenant's Aadhaar-linked mobile. Ask them to share it with you.
            </p>
            <input
              type="text"
              placeholder="6-digit OTP"
              maxLength={6}
              value={otpInput}
              onChange={e => setOtpInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
              style={{ ...inputStyle, letterSpacing: 8, fontSize: 22, textAlign: 'center' }}
            />
            <button onClick={handleOTPSubmit} disabled={loading} style={btnStyle('#1a2e4a')}>
              {loading ? 'Verifying...' : 'Confirm OTP'}
            </button>
            <button
              onClick={() => { setStep(STEPS.AADHAAR); setOtpInput(''); setError(''); }}
              style={{ ...btnStyle('#64748b'), marginTop: 8 }}
            >
              Resend OTP
            </button>
          </div>
        )}

        {/* RESULT */}
        {step === STEPS.RESULT && result && (
          <div>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>🎉</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#1a2e4a' }}>Verification Complete</div>
            </div>

            <div style={{ background: '#f8fafc', borderRadius: 12, padding: 16, marginBottom: 16 }}>
              <Row label="Name (Aadhaar)" value={result.full_name} />
              {result.pan_name && <Row label="Name (PAN)" value={result.pan_name} />}
              <Row label="Date of Birth" value={result.dob} />
              <Row label="Gender" value={result.gender} />
              {result.address?.house && (
                <Row label="Address" value={[
                  result.address.house,
                  result.address.street,
                  result.address.landmark,
                  result.address.dist,
                  result.address.state,
                  result.address.pincode,
                ].filter(Boolean).join(', ')} />
              )}
            </div>

            <div style={{ marginBottom: 16 }}>
              {matchBadge(result.name_match_status, result.name_match_score)}
            </div>

            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
              ✅ Aadhaar Verified &nbsp;·&nbsp; ✅ PAN Verified &nbsp;·&nbsp; Saved to your account
            </div>

            <button
              onClick={() => {
                setStep(STEPS.INTRO);
                setVerificationId(null);
                setPanInput('');
                setAadhaarInput('');
                setOtpInput('');
                setResult(null);
                setPanResult(null);
                setError('');
              }}
              style={btnStyle('#475569')}
            >
              Verify Another Tenant
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #e2e8f0', fontSize: 13 }}>
      <span style={{ color: '#64748b' }}>{label}</span>
      <span style={{ fontWeight: 500, color: '#1e293b', textAlign: 'right', maxWidth: '60%' }}>{value || '—'}</span>
    </div>
  );
}

const btnStyle = (bg) => ({
  width: '100%', padding: '12px 0',
  background: bg, color: '#fff',
  border: 'none', borderRadius: 8,
  fontSize: 14, fontWeight: 600,
  cursor: 'pointer', display: 'block',
  marginTop: 4,
});

const inputStyle = {
  width: '100%', padding: '12px 14px',
  border: '1.5px solid #e2e8f0',
  borderRadius: 8, fontSize: 15,
  marginBottom: 12, boxSizing: 'border-box',
  outline: 'none', fontFamily: 'inherit',
};
