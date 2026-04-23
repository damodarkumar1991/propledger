// payment.js — Reusable Razorpay payment helper for PropLedger
// Include this script on any page that needs payments

window.PropLedgerPayment = {

  // Main function — call this to trigger payment
  // type: 'esign' | 'screening' | 'bundle'
  // meta: { agreementId, userId, userName, userEmail }
  // onSuccess: callback after verified payment
  async charge(type, meta, onSuccess) {
    const LABELS = {
      esign:     { title: 'Aadhaar eSign',        price: '₹499', desc: 'Legally valid Aadhaar-based digital signature for both landlord and tenant. Sent directly to their email.' },
      screening: { title: 'Tenant Screening',     price: '₹199', desc: 'Full identity verification — Aadhaar, PAN, mobile, employment check. Instant report.' },
      bundle:    { title: 'eSign + Screening',    price: '₹599', desc: 'Screen your tenant first, then send agreement for Aadhaar eSign. Best value.' }
    };

    const info = LABELS[type];
    if (!info) { console.error('Unknown payment type:', type); return; }

    // Show confirmation modal first
    const confirmed = await this._showModal(info);
    if (!confirmed) return;

    try {
      // Step 1 — Create order server-side
      const orderRes = await fetch('/api/razorpay-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, agreementId: meta.agreementId, userId: meta.userId })
      });
      const orderData = await orderRes.json();
      if (!orderData.success) throw new Error(orderData.error || 'Could not create order');

      // Step 2 — Open Razorpay checkout
      const paymentId = await this._openCheckout(orderData, meta);

      // Step 3 — Verify server-side
      const verifyRes = await fetch('/api/razorpay-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          razorpay_order_id:    paymentId.orderId,
          razorpay_payment_id:  paymentId.paymentId,
          razorpay_signature:   paymentId.signature,
          type,
          agreementId: meta.agreementId,
          userId: meta.userId
        })
      });
      const verifyData = await verifyRes.json();
      if (!verifyData.success) throw new Error('Payment verification failed');

      // Step 4 — Call success handler
      onSuccess(verifyData);

    } catch (err) {
      console.error('Payment error:', err);
      this._showError(err.message || 'Payment failed. Please try again.');
    }
  },

  _showModal(info) {
    return new Promise((resolve) => {
      // Remove any existing modal
      document.getElementById('pl-pay-modal')?.remove();

      const modal = document.createElement('div');
      modal.id = 'pl-pay-modal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(8px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
      modal.innerHTML = `
        <div style="background:#0f1628;border:1px solid rgba(201,168,76,0.3);border-radius:20px;padding:32px;max-width:420px;width:100%;font-family:'Outfit',sans-serif;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
            <div>
              <div style="font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:700;color:#f8f6f0;">${info.title}</div>
              <div style="font-size:12px;color:#8892a4;margin-top:2px;">PropLedger · Secure Payment</div>
            </div>
            <div style="font-family:'Cormorant Garamond',serif;font-size:32px;font-weight:700;color:#c9a84c;">${info.price}</div>
          </div>

          <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:14px 16px;margin-bottom:24px;">
            <div style="font-size:13px;color:#e8e4d9;line-height:1.6;">${info.desc}</div>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px;">
            <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#8892a4;">
              <span style="color:#2dd4a0">✓</span> Secure payment via Razorpay
            </div>
            <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#8892a4;">
              <span style="color:#2dd4a0">✓</span> UPI, Cards, Net Banking accepted
            </div>
            <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#8892a4;">
              <span style="color:#2dd4a0">✓</span> Receipt sent to your email
            </div>
          </div>

          <div style="display:flex;gap:12px;">
            <button id="pl-pay-confirm" style="flex:1;background:#c9a84c;color:#0a0f1e;border:none;border-radius:9px;padding:13px;font-size:14px;font-weight:700;font-family:'Outfit',sans-serif;cursor:pointer;">
              Pay ${info.price} →
            </button>
            <button id="pl-pay-cancel" style="background:transparent;border:1px solid rgba(255,255,255,0.1);border-radius:9px;padding:13px 20px;font-size:13px;color:#8892a4;font-family:'Outfit',sans-serif;cursor:pointer;">
              Cancel
            </button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      document.getElementById('pl-pay-confirm').onclick = () => { modal.remove(); resolve(true); };
      document.getElementById('pl-pay-cancel').onclick  = () => { modal.remove(); resolve(false); };
      modal.onclick = (e) => { if (e.target === modal) { modal.remove(); resolve(false); } };
    });
  },

  _openCheckout(orderData, meta) {
    return new Promise((resolve, reject) => {
      if (!window.Razorpay) {
        reject(new Error('Razorpay SDK not loaded'));
        return;
      }
      const rzp = new window.Razorpay({
        key: orderData.keyId,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'PropLedger',
        description: orderData.label,
        order_id: orderData.orderId,
        prefill: {
          name:  meta.userName  || '',
          email: meta.userEmail || ''
        },
        theme: { color: '#c9a84c' },
        modal: { backdropclose: false },
        handler: (response) => {
          resolve({
            orderId:   response.razorpay_order_id,
            paymentId: response.razorpay_payment_id,
            signature: response.razorpay_signature
          });
        }
      });
      rzp.on('payment.failed', (resp) => {
        reject(new Error(resp.error?.description || 'Payment failed'));
      });
      rzp.open();
    });
  },

  _showError(msg) {
    document.getElementById('pl-pay-modal')?.remove();
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#1a1020;border:1px solid rgba(248,113,113,0.3);border-radius:10px;padding:14px 18px;font-size:13px;color:#f87171;font-family:Outfit,sans-serif;z-index:9999;max-width:320px;';
    el.textContent = '❌ ' + msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
};
