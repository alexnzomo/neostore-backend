require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const bcrypt = require('bcrypt');
const cron = require('node-cron');

// ========== Models ==========
const User = require('./models/User');
const Order = require('./models/Order');
const Product = require('./models/Product');
const TopUpRequest = require('./models/TopUpRequest');

// ========== Services ==========
const WalletService = require('./services/walletService');
const { createNotification } = require('./utils/notifications');

// ========== Routes ==========
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
const walletRoutes = require('./routes/wallet');
const uploadRoutes = require('./routes/upload');
const settlementRoutes = require('./routes/settlements');
const withdrawalRoutes = require('./routes/withdrawals');
const notificationRoutes = require('./routes/notifications');
const auditRoutes = require('./routes/audit');
const reportRoutes = require('./routes/reports');

// ========== Middleware ==========
const { protect } = require('./middleware/auth');
const { allowRoles } = require('./middleware/roleCheck');
const { setCsrfToken, verifyCsrfToken } = require('./middleware/csrf');

// ========== App Setup ==========
const app = express();

// ---------- Security & middleware ----------
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'https://shimmering-brigadeiros-8c1154.netlify.app',
    credentials: true,
  })
);
app.use(cookieParser());
app.use(compression());
app.use(morgan('combined'));

// ========== Health check (no rate limit) ==========
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ========== Trust proxy (Render) ==========
app.set('trust proxy', 1); // ✅ Prevents permissive warning

// ---------- Rate limiting ----------
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  skip: (req) => req.path.startsWith('/api/notifications') || req.path === '/api/health',
});
app.use('/api/', limiter);

// ---------- Stripe webhook (raw body) ----------
app.post(
  '/api/stripe/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log(`⚠️ Webhook signature verification failed.`, err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object;
        const metadata = paymentIntent.metadata;
        console.log(`✅ PaymentIntent succeeded: ${paymentIntent.id}`);

        // ===== WALLET TOP‑UP =====
        if (metadata.type === 'wallet_topup') {
          const userId = metadata.userId;
          const amount = parseFloat(metadata.amount);
          if (userId && amount) {
            await WalletService.credit(
              userId,
              amount,
              `Wallet top‑up via Stripe (${paymentIntent.id})`,
              paymentIntent.id,
              'topup'
            );
            await createNotification(
              userId,
              'system',
              'Wallet top‑up successful',
              `Your wallet has been credited with KES ${amount.toFixed(2)} via Stripe.`,
              '/account.html'
            );
            console.log(`💰 Wallet credited: ${amount} KES for user ${userId}`);
          }
        }
        // ===== SPONSORSHIP =====
        else if (metadata.type === 'sponsorship') {
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
        }
        // ===== ORDER PAYMENT =====
        else {
          const orderId = metadata.orderId;
          if (orderId) {
            await Order.findByIdAndUpdate(orderId, {
              paymentStatus: 'fully_paid',
              stripePaymentIntentId: paymentIntent.id,
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
  }
);

// ---------- JSON parser (after webhook) ----------
app.use(express.json({ limit: '10mb' }));

// ========== ✅ MIDDLEWARE ORDER FIX – BEFORE ROUTES ==========

// 1. Attach `req.setCsrfToken()` so auth routes can use it
app.use((req, res, next) => {
  req.setCsrfToken = () => setCsrfToken(req, res);
  next();
});

// 2. CSRF verification (excluding whitelisted paths)
const csrfExcludedPaths = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/logout',
  '/api/stripe/webhook',
  '/api/mpesa/callback'
];
app.use((req, res, next) => {
  if (csrfExcludedPaths.includes(req.path)) {
    return next();
  }
  verifyCsrfToken(req, res, next);
});

// ---------- MongoDB connection ----------
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => console.error('❌ MongoDB connection error:', err));

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
      password: ownerPasswordHash || (await bcrypt.hash('ChangeMe123!', 12)),
      role: 'owner',
      emailVerified: true,
    });
    await ownerUser.save();
    console.log('✅ Owner account created');
  } else {
    console.log('✅ Owner already exists');
  }
}

// ---------- Routes (NOW AFTER MIDDLEWARE) ----------
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
app.use('/api/kyc', kycRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/settlements', settlementRoutes);
app.use('/api/withdrawals', withdrawalRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/reports', reportRoutes);

// ---------- M‑Pesa Configuration ----------
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

// ===== M‑Pesa initiation helper =====
async function initiateMpesaPayment(phoneNumber, amount, accountRef) {
  let formattedPhone = phoneNumber.toString().replace(/\D/g, '');
  if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.slice(1);
  if (!formattedPhone.startsWith('254')) formattedPhone = '254' + formattedPhone;

  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(SHORTCODE + PASSKEY + timestamp).toString('base64');

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
      AccountReference: accountRef,
      TransactionDesc: 'NeoStore payment',
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return response.data;
}

// ===== Attach helper to global so wallet.js can use it =====
global.initiateMpesaPayment = initiateMpesaPayment;

// ---------- M‑Pesa STK Push endpoint (order payments) ----------
app.post('/api/mpesa/stkpush', protect, async (req, res) => {
  const { phoneNumber, amount, orderId } = req.body;
  if (!phoneNumber || !amount)
    return res.status(400).json({ error: 'Phone and amount required' });

  try {
    const accountRef = `ORDER${orderId || Date.now()}`;
    const response = await initiateMpesaPayment(phoneNumber, amount, accountRef);
    if (response.ResponseCode === '0') {
      if (orderId) {
        await Order.findByIdAndUpdate(orderId, {
          mpesaMerchantRequestId: response.MerchantRequestID,
          mpesaCheckoutRequestId: response.CheckoutRequestID,
        });
      }
    }
    res.json({ success: true, data: response });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Payment initiation failed', details: error.response?.data });
  }
});

// ---------- M‑Pesa Callback ----------
app.post('/api/mpesa/callback', async (req, res) => {
  console.log('M-Pesa Callback received:', JSON.stringify(req.body, null, 2));
  try {
    const callbackData = req.body.Body.stkCallback;
    const resultCode = callbackData.ResultCode;
    const merchantRequestId = callbackData.MerchantRequestID;
    const transactionId = callbackData.CallbackMetadata?.Item?.find(
      (item) => item.Name === 'MpesaReceiptNumber'
    )?.Value;
    const amount = callbackData.CallbackMetadata?.Item?.find(
      (item) => item.Name === 'Amount'
    )?.Value;
    const accountRef = callbackData.AccountReference;

    // ===== WALLET TOP‑UP =====
    if (accountRef && accountRef.startsWith('TOPUP-')) {
      const topUp = await TopUpRequest.findOne({ merchantRequestId, status: 'pending' });
      if (topUp) {
        if (resultCode === 0) {
          await WalletService.credit(
            topUp.userId,
            topUp.amount,
            `Wallet top‑up via M‑Pesa (${transactionId})`,
            transactionId,
            'topup'
          );
          topUp.status = 'completed';
          await createNotification(
            topUp.userId,
            'system',
            'Wallet top‑up successful',
            `Your wallet has been credited with KES ${topUp.amount.toFixed(2)} via M‑Pesa.`,
            '/account.html'
          );
          console.log(`💰 Wallet credited via M‑Pesa for user ${topUp.userId}`);
        } else {
          topUp.status = 'failed';
        }
        await topUp.save();
      }
      return res.json({ ResultCode: 0, ResultDesc: 'Success' });
    }

    // ===== SPONSORSHIP =====
    if (accountRef && accountRef.startsWith('SPONSOR')) {
      const SponsorshipRequest = require('./models/SponsorshipRequest');
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
      }
      return res.json({ ResultCode: 0, ResultDesc: 'Success' });
    }

    // ===== ORDER PAYMENT =====
    const Order = require('./models/Order');
    const order = await Order.findOne({ mpesaMerchantRequestId: merchantRequestId });
    if (!order) {
      console.error(`Order not found for MerchantRequestID: ${merchantRequestId}`);
      return res.status(404).json({ ResultCode: 1, ResultDesc: 'Order not found' });
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
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    console.error('M-Pesa callback error:', error);
    res.status(500).json({ ResultCode: 1, ResultDesc: 'Internal server error' });
  }
});

// ---------- Payment Intent endpoint (Stripe) ----------
app.post('/api/create-payment-intent', protect, async (req, res) => {
  const { amount, currency, paymentMethodId, orderId } = req.body;
  if (!amount || !paymentMethodId)
    return res.status(400).json({ error: 'Missing amount or payment method' });
  if (amount <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });

  let amountInCents = Math.round(amount * 100);
  if (currency === 'kes' || currency === 'KES') {
    if (amountInCents < 5000) return res.status(400).json({ error: 'Minimum payment amount is KES 50' });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: currency || 'kes',
      payment_method: paymentMethodId,
      confirm: false,
      metadata: { orderId: orderId || 'unknown' },
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'never',
      },
    });
    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------- Cloudinary test route (optional, temporary) ----------
app.get('/api/test-cloudinary', async (req, res) => {
  const cloudinary = require('cloudinary').v2;
  try {
    const result = await cloudinary.api.ping();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

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

    const { cancelOrder } = require('./utils/orderUtils');
    const ordersToCancel = await Order.find({
      deliveryStatus: { $in: ['pending', 'processing'] },
      createdAt: { $lt: cutoffDate },
      paymentStatus: { $ne: 'refunded' },
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