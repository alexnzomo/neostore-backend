# Mwechestore — Recovery Playbook

Common production issues and how to resolve them. For each: symptom → diagnosis → fix → prevention.

---

## 1. Order stuck in "pending" payment state

**Symptom:** Customer says "I paid but order shows pending" or "still waiting for payment confirmation."

**Diagnosis:**
```js
db.orders.findOne({ _id: ObjectId('<order-id>') })


Check:

    paymentMethod — mpesa, mpesa_deposit, mpesa_on_delivery, card, wallet?

    paymentStatus — pending, payment_failed?

    stripePaymentIntentId — does it exist?

    mpesaCheckoutRequestId — does it exist?

If M-Pesa:

    Check Safaricom M-Pesa portal (or the phone that receives the shortcode SMS) for the transaction.

    Search by mpesaTransactionId or by customer phone + amount + date.

    If payment was received but order shows pending:

        Cause: callback lost or failed

        Fix: wait 5 min for the STK recovery cron to fire (runs every 2 min)

        If still pending after 10 min: manually mark as paid:
        text

        PUT /api/orders/<order-id>/mark-paid
        (as owner only)

        Or via DB (last resort):
        js

        db.orders.updateOne(
          { _id: ObjectId('<order-id>') },
          { $set: {
            paymentStatus: 'fully_paid',
            remainingBalance: 0,
            balanceDue: 0,
            updatedAt: new Date()
          }}
        )

If Stripe:

    Check Stripe Dashboard → Payments → search by customer email or amount

    Verify the PaymentIntent status is succeeded

    If succeeded but order still pending:

        Cause: webhook failed or was skipped

        Fix:

            Go to Stripe Dashboard → Developers → Webhooks → your endpoint → Events

            Find the failed payment_intent.succeeded event

            Click "Resend"

            Or manual mark-paid (as owner, see above)

If Wallet:

    Wallet debits are synchronous — if paymentStatus is pending after wallet payment, something went wrong

    Check WalletTransaction collection for the debit:
    js

    db.wallettransactions.findOne({ referenceId: '<order-id>', referenceType: 'order' })

    If debit exists but order is pending → the atomic update in POST /api/wallet/pay failed

        Fix: as owner, mark-paid OR issue manual wallet refund + cancel order

Prevention:

    FIX 2.4 (M-Pesa callback amount validation + idempotency reorder)

    FIX 2.5 (STK recovery cron)

    FIX 4.16 (delivered guard blocks unpaid orders)

2. Order stuck at "delivered" but settlement never created

Symptom: Order marked delivered, payment collected, but vendor/agent/station never received settlement.

Diagnosis:
js

db.settlements.find({ orderId: ObjectId('<order-id>') })

Returns empty array? That's the issue.

Cause: Settlement creation failed silently. Possible reasons:

    E11000 race (fixed in FIX 2.7 but historical data may exist)

    Manual payment not verified (settlement blocked until manualPaymentVerificationStatus: 'verified')

    Cash not fully recorded — remainingBalance > 0

    deliveryStatus not 'delivered' — check actual state

Fix:
js

// As owner, verify order state
db.orders.findOne({
  _id: ObjectId('<order-id>'),
  deliveryStatus: 'delivered',
  paymentStatus: { $in: ['fully_paid', 'cash_collected'] }
})

If state is correct but no settlement exists, trigger via:
text

PUT /api/orders/<order-id>/status
{ "deliveryStatus": "delivered" }

If that returns "Invalid transition" (already delivered), create the settlement manually via a one-off Node.js script:
js

// Run in backend context
const Order = require('./models/Order');
const { createSettlementsForOrder } = require('./routes/orders');
const order = await Order.findById('<order-id>');
await createSettlementsForOrder(order);

Prevention: FIX 2.7 (E11000 catch), FIX 2.5-A (block after rejected manual payment).
3. Admin can't approve a withdrawal (403 "no permission")

Symptom: Admin clicks "Approve" on a withdrawal, gets 403.

Diagnosis: Check the admin's user record:
js

db.users.findOne({ _id: ObjectId('<admin-id>') }, { canApproveWithdrawals: 1, role: 1 })

Causes:

    canApproveWithdrawals: false (or missing) → owner never granted the flag

    Withdrawal amount > threshold → requires owner approval

Fix:

    If admin lacks flag:

        Owner logs in → Users tab → finds the admin row → checks "💰 Finance Approver"

        Or via DB:
        js

        db.users.updateOne(
          { _id: ObjectId('<admin-id>') },
          { $set: { canApproveWithdrawals: true } }
        )

    If amount > threshold:

        Owner needs to approve it

        Or temporarily raise threshold (Settings tab → "Withdrawal Approval Threshold")

        Or via DB:
        js

        db.settings.updateOne(
          { key: 'withdrawal_approval_threshold' },
          { $set: { value: 50000 } },
          { upsert: true }
        )

Prevention: None needed. This is by design.
4. Vendor can't see orders (empty dashboard)

Symptom: Vendor logs in → vendor.html shows "No orders for your products yet."

Diagnosis:

    Check the vendor actually has products:
    js

    db.products.countDocuments({ vendorId: ObjectId('<vendor-id>') })

    Check if any orders contain those products:
    js

    db.orders.countDocuments({ 'items.productId': { $in: <product-ids> } })

    Check the API returns orders (use browser DevTools → Network on vendor.html)

Causes:

    Vendor has no products (correct behavior — no orders)

    Orders exist but localStorage.user._id missing (FIX 1.1-1.3 — self-heal)

    Backend 403 or error

Fix:

    If localStorage is stale:

        Have vendor log out and log back in

        Or in browser console: localStorage.clear(); location.reload(); → re-login

    If backend error:

        Check Render logs for /api/orders errors

        Verify FIX 3.1-R deployed (vendor role in allowRoles)

Prevention: FIX 1.1-1.4 (auth _id + self-heal).
5. Wallet PIN forgotten

Symptom: User can't remember their PIN, can't authorize withdrawal/transfer/wallet payment.

Fix: User clicks "🆘 Forgot PIN" in account.html → wallet section.

Flow:

    Confirm reset (24h cooldown starts)

    Enter new 4-6 digit PIN

    OTP sent to email

    Enter OTP + new PIN

    PIN reset. Wallet ops disabled for 24h.

During cooldown:

    User can still receive money

    User can still top up wallet (Stripe, M-Pesa)

    User cannot transfer, withdraw, or pay from wallet

    User can pay via Stripe, M-Pesa STK, or cash

If user needs to bypass cooldown: Only owner can via DB:
js

db.walletpins.updateOne(
  { userId: ObjectId('<user-id>') },
  { $set: { pinChangedAt: null, pinChangeReason: null } }
)

Warning: this bypasses a security feature. Only do it if you've verified the user's identity beyond the OTP (e.g., called them, cross-referenced KYC, etc.).

Prevention: None — this is by design.
6. Stuck "Pending" pickup station application

Symptom: User submitted pickup application, owner never received notification, or application is stuck in pending.

Diagnosis:
js

db.pickupapplications.findOne({ _id: ObjectId('<app-id>') })

Check:

    status — should be 'pending'

    nationalId, idImageUrl, proofOfAddress, proofOfStationAddress, dob — all present?

If fields missing: Old application submitted before FIX 6.2 — requires manual review of the person.

Fix:

    Owner logs in → Applications tab → finds the application

    Click "📄 ID Document" etc. to review uploaded documents

    Click "✅ Approve" or "❌ Reject"

If documents fail to load (proxy error):

    Check backend /api/documents/pickup_application/:id/:field returns 200

    If 500, check Render logs for "Pickup application document proxy error"

    Likely cause: Cloudinary URL is malformed or Cloudinary is down

Prevention: FIX 6.2 (schema), FIX 6.5 (proxy), FIX 6.3 (owner notification).
7. KYC documents not accessible via proxy

Symptom: Admin clicks "📄 ID Photo" in KYC tab → new tab shows error or blank.

Diagnosis:

    Check the URL in the new tab: should be neostore-backend.onrender.com/api/documents/kyc/...

    If URL is res.cloudinary.com → proxy NOT applied (old admin.html cached or DB URL exposed)

    In new tab, check response status:

        401 → not logged in

        403 → not admin/owner

        404 → KYC record not found

        500 → backend failed to fetch from Cloudinary

Fix:

    401/403: Log in as admin/owner

    404: Verify kyc record exists and has idPhotoUrl populated

    500: Check Render logs. Common causes:

        Cloudinary account suspended or credential rotated

        Network issue between Render and Cloudinary

        URL stored is malformed

If URL is res.cloudinary.com: Hard-reload admin.html (Ctrl+Shift+R) to bypass cache. If it persists, the proxy code wasn't deployed.

Prevention: FIX 6.5 (proxy) — applied.
8. Order shows delivered but customer hasn't received

Symptom: Customer says "I never got the package but the order is marked delivered."

Diagnosis:

    Check collectedBy on the order:
    js

    db.orders.findOne(
      { _id: ObjectId('<order-id>') },
      { collectedBy: 1, assignedAgentId: 1, deliveryInfo: 1 }
    )

    Check the settlement to see who was paid:
    js

    db.settlements.findOne({ orderId: ObjectId('<order-id>') })

Causes:

    Agent marked delivered without actually delivering

    Pickup order: customer collected but no collectedBy recorded

    System error

Fix:

    For delivery order: Contact assigned agent, ask for proof of delivery (photo, signature, call log). If agent can't provide proof → issue refund and suspend agent.

    For pickup order: Contact station manager. Check collectedBy. If no record → customer may be mistaken (or order was fraudulently collected).

    Refund via admin:

        Admin/owner logs in → Orders tab → finds order → "Refund" button

        This reverses payment, restocks items, notifies customer

Prevention:

    Station manager should always record collectedBy before marking delivered

    Agent delivery: no current proof-of-delivery mechanism — post-launch improvement

9. Duplicate M-Pesa reference detected

Symptom: Agent tried to record a payment with a reference already used on another order.

What happens (FIX 2.5-A):

    Backend rejects with 400 "Reference X was already recorded on order #Y"

    Owner/admin receives notification "🚨 Duplicate M-Pesa reference attempted"

    Manual Payments tab shows the duplicate attempt

Investigation:
js

db.orders.find({
  manualPaymentMethod: 'manual_mpesa',
  manualPaymentReference: '<reference>'
})

Two orders with same reference? Fraud. One of them (usually the later one) is fake.

Fix:

    Verify in Safaricom portal which order the payment actually applies to (check the amount + date + customer phone)

    Reject the fraudulent recording (admin Manual Payments tab → "❌ Reject")

    Suspend the agent if fraud confirmed:

        Admin Users tab → find agent → "Suspend"

        Or investigate: check audit log for other suspicious activity by this agent

    Notify owner.

Prevention: FIX 2.5-A (backend rejection) + FIX 2.5-B (admin UI flags duplicates).
10. Service Worker won't update

Symptom: You deployed new code, but users still see old version.

Diagnosis:

    User's browser is serving from mwechestore-v2 cache (or current cache name)

    SW update requires page reload (sometimes 2 reloads)

Fix:

    Force update: Bump CACHE_NAME in sw.js and redeploy:
    js

    const CACHE_NAME = 'mwechestore-v3'; // was v2

    Or from DevTools: In the user's browser (or your testing browser):
    js

    navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister()));
    caches.keys().then(names => names.forEach(n => caches.delete(n)));
    location.reload();

    Or hard-reload: Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac)

Prevention: Bump CACHE_NAME on every deploy that touches HTML/CSS/JS.
11. Stripe webhook failing

Symptom: Card payments succeed in Stripe but orders stay pending.

Diagnosis:

    Stripe Dashboard → Developers → Webhooks → your endpoint → check delivery status

    Look for failed events

    Click the failed event → see error reason

Causes:

    STRIPE_WEBHOOK_SECRET mismatch (env var wrong)

    Endpoint URL changed

    Backend error during webhook processing (check Render logs)

    Webhook amount validation failing (FIX 2.3) — check for ❌ Stripe webhook amount mismatch in logs

Fix:

    Secret mismatch:

        Stripe Dashboard → Webhooks → endpoint → reveal "Signing secret"

        Update STRIPE_WEBHOOK_SECRET in Render environment variables

        Redeploy backend

    Backend error: check Render logs for the specific error, then either resend the webhook from Stripe dashboard or manual mark-paid

    Amount mismatch: FIX 2.3 intentionally blocks webhooks with wrong amount. Investigate the specific order — was the amount changed? Was the PaymentIntent created wrong?

        If legit, fix the order total and resend webhook

        If not, refund the customer and cancel order

Prevention: Monitor Stripe webhook dashboard weekly. FIX 2.3 (amount validation).
12. M-Pesa callbacks stopped working

Symptom: Customers complete STK push on their phone, but no callback comes back. Orders stay pending.

Diagnosis:

    Check Render logs for M-Pesa Callback received: — is it appearing?

    If not → Safaricom isn't reaching your backend

    Verify callback URL is reachable:
    bash

    curl -i https://neostore-backend.onrender.com/api/health

    Should return 200

Causes:

    Callback URL in Safaricom portal is wrong or outdated

    Ngrok tunnel expired (if using ngrok in dev)

    Safaricom temporary outage

    Your Render instance is down

Fix:

    Callback URL wrong: Safaricom Daraja portal → Lipa na M-Pesa Online → Callback URL — update to https://neostore-backend.onrender.com/api/mpesa/callback

    Safaricom outage: Check their status or contact support. Meanwhile, the STK recovery cron (every 2 min) will query status and credit orders

    Your instance is down: check Render dashboard → "Logs" → look for crashes or OOM

Prevention: Monitor M-Pesa callback success rate weekly. Ensure CALLBACK_URL env var matches your current deployment.
13. Cloudinary uploads failing

Symptom: KYC submission, product creation, or banner upload fails with "upload failed."

Diagnosis:

    Test the upload endpoint directly:
    bash

    curl -X POST https://neostore-backend.onrender.com/api/upload \
      -H "Cookie: token=<session>" \
      -H "X-CSRF-Token: <csrf>" \
      -F "image=@/path/to/test.jpg"

    Check Render logs for Cloudinary upload error: or credentials missing

Causes:

    Cloudinary credentials rotated

    Cloudinary account suspended or over quota

    Network issue between Render and Cloudinary

Fix:

    Credentials: Cloudinary Dashboard → Settings → API Keys → verify CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET in Render env

    Quota: Cloudinary Dashboard → Usage → check if over limit

    Network: retry, check Render status

Prevention: Monitor Cloudinary usage weekly. Have a backup payment method on Cloudinary account.
14. Settlement paid to wrong user

Symptom: Admin clicked "Pay Vendor" but money went to the wrong wallet, or admin manually credited wrong user.

Diagnosis:
js

db.wallettransactions.findOne({ referenceType: 'settlement', referenceId: ObjectId('<settlement-id>') })

Check userId — is it the intended recipient?

Fix: Only owner can reverse a transaction:
text

POST /api/wallet/reverse-transaction
{
  "transactionId": "<wallet-transaction-id>",
  "reason": "Incorrect settlement recipient"
}

Then re-credit the correct user via:
text

POST /api/wallet/topup (owner only)
{
  "userId": "<correct-recipient-id>",
  "amount": <same-amount>
}

And log the incident in the audit trail (post a manual note).

Prevention: Double-check settlement rows in admin Settlements tab before clicking "Pay." The vendor/agent/station name is displayed.
15. Login broken for all users

Symptom: No one can log in — "Invalid credentials" or 500.

Diagnosis:

    Check POST /api/auth/login in Render logs

    Check User collection:
    js

    db.users.countDocuments()

    If 0 → DB was wiped or wrong database

    Check MONGO_URI in Render env — did it change?

    Check JWT_SECRET in Render env — if it changed, all existing sessions invalidated (users need re-login, but new logins should work)

Causes:

    Wrong DB connection

    Users accidentally deleted

    JWT_SECRET changed (invalidates existing tokens, not new logins)

    Rate limit exhausted (429, not 401 — but user may report it as "can't log in")

Fix:

    Wrong DB: Render dashboard → Environment → verify MONGO_URI matches the correct Atlas cluster

    Users deleted: restore from Atlas backup (Atlas dashboard → Backup → Restore)

    JWT_SECRET changed: expected — users must re-login. No fix needed.

    Rate limit: wait 15 minutes, or clear rate limit via Redis (if used) or restart backend

Prevention: Never modify MONGO_URI or JWT_SECRET unless intentional. Enable Atlas automated backups.
16. Product images broken

Symptom: Product images show broken-image icon.

Diagnosis:

    Check the image URL in DB:
    js

    db.products.findOne({ _id: ObjectId('<product-id>') }, { imageUrl: 1 })

    Try opening the URL directly in browser

    Check if the URL is Cloudinary (res.cloudinary.com) or malformed

Causes:

    Cloudinary asset deleted

    URL is a placeholder (invalid)

    Cloudinary account suspended

Fix:

    Missing asset: Re-upload via admin Products tab → edit product → upload new image

    Malformed URL: same fix — re-upload

    Cloudinary suspended: resolve Cloudinary account issue, then re-upload any broken images

Prevention: Never delete Cloudinary assets directly — always update via admin panel (which handles re-upload).
17. Customer can't complete checkout (validation error)

Symptom: Customer says "It says something is missing but I filled everything."

Diagnosis:

    Ask customer to open DevTools → Network tab → attempt checkout → find the failed request

    Check request body vs. response

    Common error responses:

        "Delivery address is required for delivery orders" — address/city/country missing

        "Reference ... was already recorded" — for manual payments

        "Cash on delivery is currently disabled" — customer chose cash but it's off

        "KYC verification is required for orders above KES X" — threshold policy

Fix:

    Missing fields: customer's browser may have autofilled wrong fields — ask them to re-fill manually

    Cash disabled: customer should choose M-Pesa or card — this is intentional

    KYC required: customer must complete KYC first (in account.html)

    Duplicate reference: only relevant for manual payment agent flows, not customer checkout

Prevention: FIX 4.4 (delivery validation), FIX 4.15 (cash disabled check), FIX 4.5 (pickup stationId).
18. Owner locked out of account

Symptom: Owner can't log in. Password reset not working. Or owner accidentally changed their own role (blocked by FIX 3.5, but data could be corrupted).

Diagnosis:
js

db.users.findOne({ role: 'owner' })

    If missing → owner account doesn't exist

    If isSuspended: true → owner suspended

    If role: 'admin' → owner demoted

Fix:

    No owner: recreate via DB:
    js

    const bcrypt = require('bcrypt');
    const hashedPassword = await bcrypt.hash('NewPassword123!', 12);
    db.users.insertOne({
      userId: 'USR9999',
      fullName: 'Platform Owner',
      email: 'owner@mwechestore.com',
      password: hashedPassword,
      role: 'owner',
      isSuspended: false,
      walletBalance: 0,
      emailVerified: true,
      createdAt: new Date()
    })

    Owner suspended: set isSuspended: false

    Owner demoted: set role: 'owner'

Warning: Always verify the requesting person's identity before doing this. This bypasses all security.

Prevention: Owner should have a backup owner account (add a second owner via PUT /api/users/:id/role). Store credentials securely.
19. Reconciliation — daily wallet check

Symptom: You suspect money has been double-credited or lost.

Diagnosis — daily check:
js

// Sum of all credits
db.wallettransactions.aggregate([
  { $match: { type: { $in: ['credit', 'transfer_in'] } } },
  { $group: { _id: null, total: { $sum: '$amount' } } }
])

// Sum of all debits
db.wallettransactions.aggregate([
  { $match: { type: { $in: ['debit', 'transfer_out'] } } },
  { $group: { _id: null, total: { $sum: '$amount' } } }
])

// Sum of all wallet balances
db.users.aggregate([
  { $group: { _id: null, total: { $sum: '$walletBalance' } } }
])

Expected: credits - debits = sum(walletBalance)

Any mismatch = bug. Investigate by walking transactions chronologically for a specific user.

Fix: manual reverse-transaction per affected transaction (owner only). Log incidents.

Prevention: Run reconciliation daily. Compare against M-Pesa and Stripe receipts.
20. Emergency: Suspend all activity

Symptom: You suspect fraud, breach, or serious bug. Need to stop all withdrawals/transfers/orders immediately while you investigate.

Fix:

    Freeze withdrawals (owner only):

        Admin Settings tab → Withdrawals Freeze → "🔴 Freeze Withdrawals"

        Or via DB:
        js

        db.settings.updateOne(
          { key: 'withdrawals_frozen' },
          { $set: { value: 'true' } },
          { upsert: true }
        )

    Disable cash payments:

        Admin Settings tab → Enable Cash → "Disabled"

        Or via DB:
        js

        db.settings.updateOne(
          { key: 'cash_enabled' },
          { $set: { value: 'false' } },
          { upsert: true }
        )

    Disable order creation (extreme):

        Not built-in. Requires database intervention or redeploy with route disabled.

        Alternative: raise cash_max_per_order / cash_max_per_agent_per_day to 1 — effectively disables cash orders

        Or disable all payment methods except one

    Notify users: Use notification system or direct email to inform users of maintenance.

    Investigate: check audit log, wallet transactions, order status for the last 24 hours.

Prevention: Maintain a runbook and test freeze flows quarterly.
Common DB Queries for Debugging
js

// Find user by email
db.users.findOne({ email: 'user@example.com' })

// Find user by wallet PIN status
db.walletpins.findOne({ userId: ObjectId('<user-id>') })

// Find KYC for user
db.kycs.findOne({ userId: ObjectId('<user-id>') })

// Recent orders
db.orders.find().sort({ createdAt: -1 }).limit(10)

// Pending withdrawals over threshold
db.withdrawals.find({
  status: 'pending',
  amount: { $gt: 20000 }
})

// Recent audit logs
db.auditlogs.find().sort({ createdAt: -1 }).limit(20)

// All pending manual payments
db.orders.find({ manualPaymentVerificationStatus: 'pending' })

// Wallet transactions for a user
db.wallettransactions.find({ userId: ObjectId('<user-id>') }).sort({ createdAt: -1 })

// Orders stuck in pending payment (older than 24h)
db.orders.find({
  paymentStatus: 'pending',
  createdAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
})

// Duplicate M-Pesa references
db.orders.aggregate([
  { $match: { manualPaymentMethod: 'manual_mpesa', manualPaymentReference: { $ne: null } } },
  { $group: {
      _id: '$manualPaymentReference',
      count: { $sum: 1 },
      orders: { $push: '$orderId' }
  }},
  { $match: { count: { $gt: 1 } } }
])

// Duplicate settlements (should be 0)
db.settlements.aggregate([
  { $group: {
      _id: { orderId: '$orderId', vendorId: '$vendorId' },
      count: { $sum: 1 }
  }},
  { $match: { count: { $gt: 1 } } }
])

Escalation Contacts

    MongoDB Atlas support: via Atlas dashboard → "Support"

    Render support: support@render.com or via dashboard

    Stripe support: dashboard → Help → Contact support

    Safaricom Daraja support: daraja@safaricom.co.ke or the developer portal

    Cloudinary support: via dashboard → Support

    Owner (for escalated decisions): [owner phone / WhatsApp — add before launch]
