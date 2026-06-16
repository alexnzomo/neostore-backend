require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const SibApiV3Sdk = require('sib-api-v3-sdk');
const bcrypt = require('bcrypt');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const compression = require('compression');
const morgan = require('morgan');
const sanitizeHtml = require('sanitize-html');
const walletRoutes = require('./routes/wallet');
app.use('/api/wallet', walletRoutes);
const uploadRoutes = require('./routes/upload');


const app = express();

// ---------- Security & middleware ----------
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

// Compression and logging
app.use(compression());
app.use(morgan('combined'));

// Global rate limit
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use('/api/', limiter);

app.use('/api/upload', uploadRoutes);

// Stripe webhook (needs raw body) - MUST be before express.json()
app.post('/api/stripe/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.log(`⚠️ Webhook signature verification failed.`, err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    switch (event.type) {
        case 'payment_intent.succeeded':
            const paymentIntent = event.data.object;
            const orderId = paymentIntent.metadata.orderId;
            console.log(`PaymentIntent for Order ${orderId} succeeded!`);
            if (orderId) {
                const Order = require('./models/Order');
                await Order.findByIdAndUpdate(orderId, { paymentStatus: 'fully_paid', stripePaymentIntentId: paymentIntent.id });
            }
            break;
        case 'payment_intent.payment_failed':
            const failedIntent = event.data.object;
            console.log(`Payment failed for Order ${failedIntent.metadata.orderId}: ${failedIntent.last_payment_error?.message}`);
            if (failedIntent.metadata.orderId) {
                const Order = require('./models/Order');
                await Order.findByIdAndUpdate(failedIntent.metadata.orderId, { paymentStatus: 'payment_failed' });
            }
            break;
        default:
            console.log(`Unhandled event type ${event.type}`);
    }
    res.json({ received: true });
});

// ---------- MongoDB connection ----------
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// ---------- Import User model (needed for owner creation) ----------
const User = require('./models/User');

// ---------- Create owner from .env if not exists ----------
async function createOwnerIfNotExists() {
  const ownerEmail = process.env.OWNER_EMAIL;
  const ownerPasswordHash = process.env.OWNER_PASSWORD_HASH; // pre‑hashed password
  if (!ownerEmail) {
    console.log('⚠️ OWNER_EMAIL not set in .env, skipping owner creation');
    return;
  }
  const existingOwner = await User.findOne({ email: ownerEmail });
  if (!existingOwner) {
    console.log(`👑 Owner ${ownerEmail} not found, creating...`);
    const userId = await User.getNextUserId();
    const ownerUser = new User({
      userId,
      fullName: 'Platform Owner',
      email: ownerEmail,
      password: ownerPasswordHash || await bcrypt.hash('ChangeMe123!', 12), // fallback
      role: 'owner',
      emailVerified: true
    });
    await ownerUser.save();
    console.log('✅ Owner account created');
  } else {
    console.log('✅ Owner already exists');
  }
}

// ---------- Import routes ----------
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const categoryRoutes = require('./routes/categories');
const bannerRoutes = require('./routes/banners');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const pickupRoutes = require('./routes/pickup');
const applicationRoutes = require('./routes/applications');
const reviewRoutes = require('./routes/reviews');
const settingsRoutes = require('./routes/settings');
const discountRoutes = require('./routes/discounts');
const pickupApplicationRoutes = require('./routes/pickupApplications');

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/banners', bannerRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/pickup', pickupRoutes);
app.use('/api/applications', applicationRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/discounts', discountRoutes);
app.use('/api/pickup/applications', pickupApplicationRoutes);

// ---------- Auth middleware for payment endpoints ----------
const { protect } = require('./middleware/auth');

// ========== YOUR EXISTING PAYMENT & EMAIL CODE (FULL, UNCHANGED) ==========

// ---------- Brevo Email Setup ----------
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const transactionalEmailsApi = new SibApiV3Sdk.TransactionalEmailsApi();
const FROM_EMAIL = process.env.BREVO_FROM_EMAIL;

console.log('🔧 Brevo configured with FROM_EMAIL:', FROM_EMAIL);
console.log('🔧 BREVO_API_KEY starts with:', process.env.BREVO_API_KEY ? process.env.BREVO_API_KEY.substring(0, 10) + '...' : 'MISSING');

// ---------- M-Pesa Configuration ----------
const CONSUMER_KEY = process.env.CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const PASSKEY = process.env.PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const SHORTCODE = process.env.SHORTCODE || '174379';
const CALLBACK_URL = process.env.CALLBACK_URL || 'https://your-ngrok-url.ngrok.io/callback';

async function getAccessToken() {
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const response = await axios.get(
    'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return response.data.access_token;
}

// M-Pesa STK Push (protected – requires login)
app.post('/api/mpesa/stkpush', protect, async (req, res) => {
  const { phoneNumber, amount, orderId } = req.body;
  if (!phoneNumber || !amount) return res.status(400).json({ error: 'Phone and amount required' });
  let formattedPhone = phoneNumber.toString().replace(/\D/g, '');
  if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.slice(1);
  if (!formattedPhone.startsWith('254')) formattedPhone = '254' + formattedPhone;
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(SHORTCODE + PASSKEY + timestamp).toString('base64');
  try {
    const token = await getAccessToken();
    const response = await axios.post(
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      {
        BusinessShortCode: SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: Math.round(amount),
        PartyA: formattedPhone,
        PartyB: SHORTCODE,
        PhoneNumber: formattedPhone,
        CallBackURL: CALLBACK_URL,
        AccountReference: `ORDER${orderId || Date.now()}`,
        TransactionDesc: 'NeoStore payment'
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

  const mpesaResponse = response.data;
  if (mpesaResponse.ResponseCode === "0") {
      const { orderId } = req.body; // Make sure frontend sends orderId
      if (orderId) {
          const Order = require('./models/Order');
          await Order.findByIdAndUpdate(orderId, {
              mpesaMerchantRequestId: mpesaResponse.MerchantRequestID,
              mpesaCheckoutRequestId: mpesaResponse.CheckoutRequestID
          });
      }
  }
    res.json({ success: true, data: response.data });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Payment initiation failed', details: error.response?.data });
  }
});

// M-Pesa Callback (Safaricom calls this)
app.post('/api/mpesa/callback', async (req, res) => {
    console.log('M-Pesa Callback received:', JSON.stringify(req.body, null, 2));
    try {
        const callbackData = req.body.Body.stkCallback;
        const resultCode = callbackData.ResultCode; // 0 = success
        const merchantRequestId = callbackData.MerchantRequestID;
        const transactionId = callbackData.CallbackMetadata?.Item?.find(item => item.Name === "MpesaReceiptNumber")?.Value;
        const amount = callbackData.CallbackMetadata?.Item?.find(item => item.Name === "Amount")?.Value;

        const Order = require('./models/Order');
        const order = await Order.findOne({ mpesaMerchantRequestId: merchantRequestId });
        if (!order) {
            console.error(`Order not found for MerchantRequestID: ${merchantRequestId}`);
            return res.status(404).json({ ResultCode: 1, ResultDesc: "Order not found" });
        }

        if (resultCode === 0) {
            order.paymentStatus = 'fully_paid';
            order.mpesaTransactionId = transactionId;
            order.mpesaAmount = amount;
            await order.save();
            console.log(`Order ${order.orderId} payment confirmed via M-Pesa. Transaction ID: ${transactionId}`);
        } else {
            order.paymentStatus = 'payment_failed';
            order.mpesaFailureReason = callbackData.ResultDesc;
            await order.save();
            console.log(`Order ${order.orderId} M-Pesa payment failed: ${callbackData.ResultDesc}`);
        }
        res.json({ ResultCode: 0, ResultDesc: "Success" });
    } catch (error) {
        console.error('M-Pesa callback error:', error);
        res.status(500).json({ ResultCode: 1, ResultDesc: "Internal server error" });
    }
});

// ---------- Email endpoints (full, as in your original) ----------
const pendingVerifications = new Map();

app.post('/api/send-verification', async (req, res) => {
  console.log('📨 /api/send-verification called, body:', req.body);
  const { email } = req.body;
  if (!email) {
    console.log('❌ No email provided');
    return res.status(400).json({ error: 'Email required' });
  }
  // Clean expired codes
  for (let [key, value] of pendingVerifications.entries()) {
    if (Date.now() > value.expiresAt) pendingVerifications.delete(key);
  }
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  pendingVerifications.set(email, { code, expiresAt });
  console.log(`🔑 Generated code ${code} for ${email}, expires at ${new Date(expiresAt).toISOString()}`);
  try {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.sender = { email: FROM_EMAIL };
    sendSmtpEmail.subject = 'Your NeoStore verification code';
    sendSmtpEmail.htmlContent = `<p>Your verification code is: <strong>${code}</strong></p><p>This code expires in 5 minutes.</p>`;
    const response = await transactionalEmailsApi.sendTransacEmail(sendSmtpEmail);
    console.log('✅ Brevo success, messageId:', response.messageId);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Brevo error:', error.response?.body || error.message);
    res.status(500).json({ error: 'Failed to send email', details: error.message });
  }
});

app.get('/api/test-email', async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).send('Missing ?to=email');
  try {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.to = [{ email: to }];
    sendSmtpEmail.sender = { email: FROM_EMAIL };
    sendSmtpEmail.subject = 'Test from NeoStore backend';
    sendSmtpEmail.htmlContent = '<p>If you see this, Brevo is working.</p>';
    const response = await transactionalEmailsApi.sendTransacEmail(sendSmtpEmail);
    res.send(`Email sent to ${to}, messageId: ${response.messageId}`);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error: ' + (error.response?.body?.message || error.message));
  }
});

app.post('/api/verify-and-register', (req, res) => {
  const { email, code } = req.body;
  const pending = pendingVerifications.get(email);
  if (!pending) return res.status(400).json({ error: 'No pending verification' });
  if (Date.now() > pending.expiresAt) {
    pendingVerifications.delete(email);
    return res.status(400).json({ error: 'Code expired' });
  }
  if (pending.code !== code) return res.status(400).json({ error: 'Invalid code' });
  pendingVerifications.delete(email);
  res.json({ success: true });
});

const passwordResetCodes = new Map();
app.post('/api/send-reset-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  for (let [key, value] of passwordResetCodes.entries()) {
    if (Date.now() > value.expiresAt) passwordResetCodes.delete(key);
  }
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  passwordResetCodes.set(email, { code, expiresAt });
  try {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.sender = { email: FROM_EMAIL };
    sendSmtpEmail.subject = 'Password reset request';
    sendSmtpEmail.htmlContent = `<p>Your password reset code is: <strong>${code}</strong></p><p>This code expires in 5 minutes.</p>`;
    await transactionalEmailsApi.sendTransacEmail(sendSmtpEmail);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

app.post('/api/verify-reset-code', (req, res) => {
  const { email, code } = req.body;
  const pending = passwordResetCodes.get(email);
  if (!pending) return res.status(400).json({ error: 'No reset request' });
  if (Date.now() > pending.expiresAt) {
    passwordResetCodes.delete(email);
    return res.status(400).json({ error: 'Code expired' });
  }
  if (pending.code !== code) return res.status(400).json({ error: 'Invalid code' });
  passwordResetCodes.delete(email);
  res.json({ success: true });
});

app.post('/api/send-order-confirmation', async (req, res) => {
  const { email, fullName, orderId, total, items, paymentMethod, status } = req.body;
  if (!email || !fullName || !orderId) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const itemsList = Array.isArray(items) ? items.join(', ') : items;
  try {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.sender = { email: FROM_EMAIL };
    sendSmtpEmail.subject = `Your NeoStore Order #${orderId} Confirmation`;
    sendSmtpEmail.htmlContent = `
      <h2>Thank you for your order, ${fullName}!</h2>
      <p><strong>Order #:</strong> ${orderId}</p>
      <p><strong>Total:</strong> KES ${total}</p>
      <p><strong>Payment method:</strong> ${paymentMethod}</p>
      <p><strong>Status:</strong> ${status}</p>
      <p><strong>Items:</strong> ${itemsList}</p>
    `;
    await transactionalEmailsApi.sendTransacEmail(sendSmtpEmail);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

app.post('/api/send-verification-generic', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  for (let [key, value] of pendingVerifications.entries()) {
    if (Date.now() > value.expiresAt) pendingVerifications.delete(key);
  }
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000;
  pendingVerifications.set(email, { code, expiresAt });
  try {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.to = [{ email }];
    sendSmtpEmail.sender = { email: FROM_EMAIL };
    sendSmtpEmail.subject = 'Your verification code';
    sendSmtpEmail.htmlContent = `<p>Your verification code is: <strong>${code}</strong></p><p>This code expires in 5 minutes.</p>`;
    await transactionalEmailsApi.sendTransacEmail(sendSmtpEmail);
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

app.post('/api/verify-code', (req, res) => {
  const { email, code } = req.body;
  const pending = pendingVerifications.get(email);
  if (!pending) return res.status(400).json({ error: 'No pending verification' });
  if (Date.now() > pending.expiresAt) {
    pendingVerifications.delete(email);
    return res.status(400).json({ error: 'Code expired' });
  }
  if (pending.code !== code) return res.status(400).json({ error: 'Invalid code' });
  pendingVerifications.delete(email);
  res.json({ success: true });
});

// ---------- Stripe Payment Intent (protected) ----------


app.post('/api/create-payment-intent', protect, async (req, res) => {
  const { amount, currency, paymentMethodId, orderId } = req.body;
  if (!amount || !paymentMethodId) {
    return res.status(400).json({ error: 'Missing amount or payment method' });
  }
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency: currency || 'kes',
      payment_method: paymentMethodId,
      confirmation_method: 'manual',
      confirm: true,
      metadata: { orderId: orderId || 'unknown' }
    });
    res.json({ success: true, paymentIntent });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------- Basic error handler ----------
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// ---------- Start server & create owner ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  await createOwnerIfNotExists();
});