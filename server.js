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
const cron = require('node-cron');

// ========== Models ==========
const User = require('./models/User');
const Order = require('./models/Order');
const Product = require('./models/Product');
const SponsorshipRequest = require('./models/SponsorshipRequest');
const notificationRoutes = require('./routes/notifications');

// ========== Utils ==========
const { cancelOrder } = require('./utils/orderUtils');

// ========== Routes ==========
const walletRoutes = require('./routes/wallet');
const uploadRoutes = require('./routes/upload');
const settlementRoutes = require('./routes/settlements');
const withdrawalRoutes = require('./routes/withdrawals');
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
const kycRoutes = require('./routes/kyc');

const app = express();

// ---------- Security & middleware ----------
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));

app.use(compression());
app.use(morgan('combined'));

// Global rate limit
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  }
});
app.use('/api/', limiter);

// ---------- Stripe webhook (raw body) ----------
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
    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object;
      const metadata = paymentIntent.metadata;
      console.log(`✅ PaymentIntent succeeded: ${paymentIntent.id}`);

      if (metadata.type === 'sponsorship') {
        const productId = metadata.productId;
        const days = parseInt(metadata.days);
        if (productId && days) {
          const product = await Product.findById(productId);
          if (product) {
            product.sponsored = true;
            product.sponsoredUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
            await product.save();
            console.log(`⭐ Product ${product.name} (${productId}) sponsored for ${days} days via Stripe.`);
          }
        }
      } else {
        const orderId = metadata.orderId;
        if (orderId) {
          await Order.findByIdAndUpdate(orderId, {
            paymentStatus: 'fully_paid',
            stripePaymentIntentId: paymentIntent.id
          });
          console.log(`✅ Order ${orderId} marked as fully paid.`);
        }
      }
      break;
    }
    case 'payment_intent.payment_failed': {
      const failedIntent = event.data.object;
      const orderId = failedIntent.metadata.orderId;
      if (orderId) {
        await Order.findByIdAndUpdate(orderId, { paymentStatus: 'payment_failed' });
        console.log(`❌ Order ${orderId} payment failed.`);
      }
      break;
    }
    default:
      console.log(`Unhandled event type ${event.type}`);
  }
  res.json({ received: true });
});

// ---------- MongoDB connection ----------
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// ---------- Owner creation ----------
async function createOwnerIfNotExists() {
  const ownerEmail = process.env.OWNER_EMAIL;
  const ownerPasswordHash = process.env.OWNER_PASSWORD_HASH;
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
      password: ownerPasswordHash || await bcrypt.hash('ChangeMe123!', 12),
      role: 'owner',
      emailVerified: true
    });
    await ownerUser.save();
    console.log('✅ Owner account created');
  } else {
    console.log('✅ Owner already exists');
  }
}

// ---------- Register routes ----------
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
app.use('/api/wallet', walletRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/settlements', settlementRoutes);
app.use('/api/withdrawals', withdrawalRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/notifications', notificationRoutes);

// ---------- Auth middleware for payment endpoints ----------
const { protect } = require('./middleware/auth');

// ========== Payment endpoints ==========

// Stripe Payment Intent
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
      confirmation_method: 'manual', // frontend will confirm
      confirm: false,                // do not confirm here
      metadata: { orderId: orderId || 'unknown' },
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'never'    // prevent redirects – we will handle them manually
      }
    });
    res.json({ success: true, clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
});

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

// M-Pesa STK Push
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
      const { orderId } = req.body;
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

// M-Pesa Callback
app.post('/api/mpesa/callback', async (req, res) => {
  console.log('M-Pesa Callback received:', JSON.stringify(req.body, null, 2));
  try {
    const callbackData = req.body.Body.stkCallback;
    const resultCode = callbackData.ResultCode;
    const merchantRequestId = callbackData.MerchantRequestID;
    const transactionId = callbackData.CallbackMetadata?.Item?.find(item => item.Name === "MpesaReceiptNumber")?.Value;
    const amount = callbackData.CallbackMetadata?.Item?.find(item => item.Name === "Amount")?.Value;
    const accountRef = callbackData.AccountReference; // if available

    // Check if it's a sponsorship callback
    if (accountRef && accountRef.startsWith('SPONSOR')) {
      const pendingRequest = await SponsorshipRequest.findOne({ merchantRequestId, status: 'pending' });
      if (pendingRequest) {
        if (resultCode === 0) {
          const product = await Product.findById(pendingRequest.productId);
          if (product) {
            product.sponsored = true;
            product.sponsoredUntil = new Date(Date.now() + pendingRequest.days * 24 * 60 * 60 * 1000);
            await product.save();
            console.log(`⭐ Product ${product.name} (${product._id}) sponsored for ${pendingRequest.days} days via M‑Pesa.`);
          }
          pendingRequest.status = 'completed';
        } else {
          pendingRequest.status = 'failed';
        }
        await pendingRequest.save();
      } else {
        console.log(`No pending sponsorship request for MerchantRequestID: ${merchantRequestId}`);
      }
      return res.json({ ResultCode: 0, ResultDesc: 'Success' });
    }

    // Regular order handling
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

// ---------- Email endpoints (your existing ones – unchanged) ----------
// (I'll keep the placeholder, but you need to paste your full email code here)
// For brevity, I'm leaving a comment, but in your actual file, you have the full code.

// ---------- Basic error handler ----------
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// ---------- Auto-cancel cron ----------
const AUTO_CANCEL_DAYS = parseInt(process.env.AUTO_CANCEL_DAYS) || 7;
cron.schedule('0 0 * * *', async () => {
  console.log('Running auto-cancel cron job...');
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - AUTO_CANCEL_DAYS);

    const ordersToCancel = await Order.find({
      deliveryStatus: { $in: ['pending', 'processing'] },
      createdAt: { $lt: cutoffDate },
      paymentStatus: { $ne: 'refunded' }
    });

    for (const order of ordersToCancel) {
      console.log(`Auto-cancelling order ${order.orderId} (created ${order.createdAt})`);
      try {
        await cancelOrder(order._id, `Auto-cancelled after ${AUTO_CANCEL_DAYS} days`);
      } catch (err) {
        console.error(`Failed to auto-cancel order ${order.orderId}:`, err.message);
      }
    }
    console.log(`Auto-cancel cron completed. Cancelled ${ordersToCancel.length} orders.`);
  } catch (err) {
    console.error('Auto-cancel cron error:', err);
  }
});

// ---------- Start server ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  await createOwnerIfNotExists();
});