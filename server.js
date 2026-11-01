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
const PickupStation = require('./models/PickupStation');
const Settlement = require('./models/Settlement');
const Withdrawal = require('./models/Withdrawal');

// ========== Services ==========
const WalletService = require('./services/walletService');
const { createNotification } = require('./utils/notifications');
const { sendOrderConfirmationEmail } = require('./utils/email'); // ✅ Email import
const { processReferralReward } = require('./utils/referral');

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
const verificationRoutes = require('./routes/verification');
const documentRoutes = require('./routes/documents');

// ========== Middleware ==========
const { protect } = require('./middleware/auth');
const { allowRoles } = require('./middleware/roleCheck');
const { setCsrfToken, verifyCsrfToken } = require('./middleware/csrf');

// ========== Environment Validation ==========
const requiredEnvVars = [
  'MONGO_URI',
  'JWT_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'BREVO_API_KEY',
  'BREVO_FROM_EMAIL',
  'CORS_ORIGIN',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];
const missing = requiredEnvVars.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// ========== App Setup ==========
const app = express();

// ---------- Security & middleware ----------
// ---------- Security & middleware ----------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://js.stripe.com"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
        connectSrc: [
          "'self'",
          "https://shimmering-brigadeiros-8c1154.netlify.app",
          "https://mwechestore.com",
          "https://www.mwechestore.com"
        ],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
  })
);

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim())
  : ['https://www.mwechestore.com'];

app.use(
  cors({
    origin: allowedOrigins,
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
    uptime: process.uptime(),
  });
});

// ========== Trust proxy (Render) ==========
app.set('trust proxy', 1);

// ---------- Rate limiting ----------
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 500,
  skip: (req) => req.path.startsWith('/api/notifications') || req.path === '/api/health',
});
app.use('/api/', globalLimiter);

// Stricter limits for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
});
app.use('/api/send-reset-code', resetLimiter);

app.use('/api/verify-reset-code', resetLimiter);
// PIN OTP rate limit — prevents email spam via /wallet/pin/request-otp
const pinOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: false,
});
app.use('/api/wallet/pin/request-otp', pinOtpLimiter);

// Order creation rate limit — prevents stock-depletion DoS via rapid order creation
const orderCreateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  message: { error: 'Too many orders in a short period. Please wait and try again.' },
});
app.use('/api/orders', (req, res, next) => {
  if (req.method === 'POST') return orderCreateLimiter(req, res, next);
  next();
});

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

        if (metadata.type === 'wallet_topup') {
          const userId = metadata.userId;
          const amount = parseFloat(metadata.amount);
          console.log(`🔍 Stripe wallet top-up: userId=${userId}, amount=${amount}`);
          if (userId && amount) {
            try {
              const result = await WalletService.credit(
                userId,
                amount,
                `Wallet top‑up via Stripe (${paymentIntent.id})`,
                paymentIntent.id,
                'topup'
              );
              console.log(`💰 Stripe wallet credited: ${amount} KES for user ${userId}. New balance: ${result.newBalance}`);
              await createNotification(
                userId,
                'system',
                'Wallet top‑up successful',
                `Your wallet has been credited with KES ${amount.toFixed(2)} via Stripe.`,
                '/account.html'
              );
            } catch (err) {
              console.error(`❌ Stripe wallet top-up FAILED for user ${userId}:`, err.message);
              console.error(err.stack);
            }
          } else {
            console.warn(`⚠️ Stripe wallet top-up missing userId or amount in metadata:`, metadata);
          }
        } else if (metadata.type === 'sponsorship') {
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
          // ✅ ORDER PAYMENT
          const orderId = metadata.orderId;
          if (orderId) {
            const existingOrder = await Order.findById(orderId);
            if (!existingOrder) {
              console.warn(`⚠️ Stripe webhook: order ${orderId} not found.`);
              break;
            }

            const isDeposit = ['card_deposit', 'mpesa_deposit', 'wallet_deposit'].includes(existingOrder.paymentMethod);
            const expectedDeposit = isDeposit
              ? Math.round(existingOrder.totalKES * ((existingOrder.depositPercentage || 0) / 100))
              : existingOrder.totalKES;

            // ✅ Verify webhook amount matches expected amount (in cents)
            // Stripe reports amounts in cents; we allow ±1 KES for rounding.
            const expectedCents = expectedDeposit * 100;
            if (Math.abs(paymentIntent.amount - expectedCents) > 100) {
              console.error(
                `❌ Stripe webhook amount mismatch for order ${orderId}: ` +
                `expected ${expectedCents} cents (KES ${expectedDeposit}), ` +
                `got ${paymentIntent.amount} cents. NOT marking paid.`
              );
              break;
            }

            const claimedOrder = await Order.findOneAndUpdate(
              { _id: orderId, paymentStatus: 'pending' },
              {
                $set: {
                  paymentStatus: isDeposit ? 'deposit_paid' : 'fully_paid',
                  stripePaymentIntentId: paymentIntent.id,
                  depositPaid: isDeposit ? expectedDeposit : existingOrder.totalKES,
                  balanceDue: isDeposit ? existingOrder.totalKES - expectedDeposit : 0,
                  remainingBalance: isDeposit ? existingOrder.totalKES - expectedDeposit : 0,
                  updatedAt: Date.now()
                }
              },
              { new: true }
            );

            if (!claimedOrder) {
              console.log(`⚠️ Stripe webhook: order ${orderId} already processed. Ignoring duplicate.`);
              break;
            }

            console.log(`✅ Order ${orderId} marked as ${claimedOrder.paymentStatus}.`);

            try {
              await processReferralReward(claimedOrder);
            } catch (err) {
              console.error('❌ Referral reward failed:', err.message);
            }

            try {
              await sendOrderConfirmationEmail(claimedOrder);
            } catch (err) {
              console.error('❌ Stripe confirmation email failed:', err.message);
            }
          }
        }
        break;
      }
      case 'payment_intent.payment_failed': {
        const failedIntent = event.data.object;
        const orderId = failedIntent.metadata.orderId;
        if (orderId) {
          await Order.findOneAndUpdate(
            { _id: orderId, paymentStatus: 'pending' },
            { $set: { paymentStatus: 'payment_failed', updatedAt: Date.now() } }
          );
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
app.use(express.json({ limit: '1mb' }));

// ========== ✅ Attach CSRF helper ==========
app.use((req, res, next) => {
  req.setCsrfToken = () => setCsrfToken(req, res);
  next();
});

// ========== ✅ CSRF Excluded Paths ==========
const csrfExcludedPaths = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/stripe/webhook',
  '/api/mpesa/callback',
  '/api/send-verification',
  '/api/verify-and-register',
  '/api/send-verification-generic',
  '/api/verify-code',
  '/api/send-reset-code',
  '/api/verify-reset-code',
];
app.use((req, res, next) => {
  const normalizedPath = req.path.replace(/\/+$/, '') || '/';
  if (csrfExcludedPaths.includes(normalizedPath)) {
    return next();
  }
  verifyCsrfToken(req, res, next);
});

// ---------- MongoDB connection ----------
// ========== Seed counters from existing data (one-time, idempotent) ==========
async function seedCounters() {
  const Counter = require('./models/Counter');

  const existingUserCounter = await Counter.findById('userId');
  if (!existingUserCounter) {
    const lastUser = await User.findOne({ userId: { $regex: /^USR\d+$/ } }).sort({ userId: -1 });
    let startSeq = 1000;
    if (lastUser && lastUser.userId) {
      const m = lastUser.userId.match(/\d+/);
      if (m) startSeq = parseInt(m[0], 10);
    }
    await Counter.create({ _id: 'userId', seq: startSeq });
    console.log(`✅ userId counter seeded at ${startSeq}`);
  }

  const existingProductCounter = await Counter.findById('productId');
  if (!existingProductCounter) {
    const lastProduct = await Product.findOne({ productId: { $regex: /^PRD\d+$/ } }).sort({ productId: -1 });
    let startSeq = 1000;
    if (lastProduct && lastProduct.productId) {
      const m = lastProduct.productId.match(/\d+/);
      if (m) startSeq = parseInt(m[0], 10);
    }
    await Counter.create({ _id: 'productId', seq: startSeq });
    console.log(`✅ productId counter seeded at ${startSeq}`);
  }
}

mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('✅ MongoDB connected');
    await Promise.all([
      Order.createIndexes(),
      User.createIndexes(),
      Product.createIndexes(),
      Settlement.createIndexes(),
      Withdrawal.createIndexes(),
      PickupStation.createIndexes(),
    ]);
    console.log('✅ Database indexes created');
    await seedCounters();
    console.log('✅ Counters seeded');
    await createOwnerIfNotExists();
    console.log('✅ Owner creation check complete');
  })
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
      fullName: 'Mwechestore Official',
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

// ========== Routes ==========
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
app.use('/api', verificationRoutes);
app.use('/api/documents', documentRoutes);

// ---------- M‑Pesa Configuration ----------
const CONSUMER_KEY = process.env.CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const PASSKEY = process.env.PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const SHORTCODE = process.env.SHORTCODE || '174379';
const CALLBACK_URL = process.env.CALLBACK_URL || 'https://your-ngrok-url.ngrok.io/callback';

const MPESA_BASE_URL = process.env.MPESA_BASE_URL
  || (process.env.NODE_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke');

async function getAccessToken() {
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const response = await axios.get(
    `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return response.data.access_token;
}

async function initiateMpesaPayment(phoneNumber, amount, accountRef) {
  let formattedPhone = phoneNumber.toString().replace(/\D/g, '');
  if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.slice(1);
  if (!formattedPhone.startsWith('254')) formattedPhone = '254' + formattedPhone;

  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(SHORTCODE + PASSKEY + timestamp).toString('base64');

  const token = await getAccessToken();

  const response = await axios.post(
    `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
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

global.initiateMpesaPayment = initiateMpesaPayment;

// ---------- M‑Pesa STK Push endpoint ----------
app.post('/api/mpesa/stkpush', protect, async (req, res) => {
  const { phoneNumber, amount, orderId } = req.body;
  if (!phoneNumber || !amount) {
    return res.status(400).json({ error: 'Phone and amount required' });
  }

  try {
    let verifiedAmount = Number(amount);
    let verifiedOrderId = null;

    if (orderId) {
      const order = await Order.findById(orderId);
      if (!order) return res.status(404).json({ error: 'Order not found' });

      const uid = req.user._id.toString();
      const isOwner = order.customerId.toString() === uid;
      const isAssignedAgent = req.user.role === 'agent'
        && order.assignedAgentId
        && order.assignedAgentId.toString() === uid;
      const isAdmin = ['admin', 'owner'].includes(req.user.role);

      if (!isOwner && !isAssignedAgent && !isAdmin) {
        return res.status(403).json({ error: 'Not authorized to send STK for this order' });
      }

      const currentStatus = order.paymentStatus;
      if (['cancelled', 'delivered', 'refunded', 'fully_paid', 'cash_collected'].includes(currentStatus)) {
        return res.status(400).json({ error: `Order cannot accept payment (status: ${currentStatus})` });
      }

      if (currentStatus === 'payment_failed') {
        await Order.updateOne(
          { _id: orderId, paymentStatus: 'payment_failed' },
          { $set: { paymentStatus: 'pending', mpesaFailureReason: null, updatedAt: Date.now() } }
        );
      }

      const isDepositOrder = order.paymentMethod === 'mpesa_deposit';
      let expectedAmount;

  if ((currentStatus === 'pending' || currentStatus === 'payment_failed') && isDepositOrder) {
        const pct = order.depositPercentage || 0;
        if (pct <= 0 || pct > 100) {
          return res.status(400).json({ error: 'Order has invalid deposit configuration' });
        }
        expectedAmount = Math.round(order.totalKES * (pct / 100));
      } else {
        expectedAmount = order.remainingBalance > 0 ? order.remainingBalance : order.totalKES;
      }

      if (Math.abs(Number(amount) - expectedAmount) > 1) {
        return res.status(400).json({
          error: `Amount does not match. Expected KES ${expectedAmount}, got KES ${amount}.`
        });
      }

      verifiedAmount = Math.round(expectedAmount);
      verifiedOrderId = order._id;
    }

    const accountRef = `ORDER${verifiedOrderId || Date.now()}`;
    const response = await initiateMpesaPayment(phoneNumber, verifiedAmount, accountRef);

    if (response.ResponseCode !== '0') {
      console.error('STK push rejected by Safaricom:', response);
      return res.status(400).json({
        success: false,
        error: response.ResponseDescription || 'Safaricom rejected the STK push',
        details: response
      });
    }

    if (verifiedOrderId) {
      await Order.findByIdAndUpdate(verifiedOrderId, {
        mpesaMerchantRequestId: response.MerchantRequestID,
        mpesaCheckoutRequestId: response.CheckoutRequestID,
        mpesaFailureReason: null
      });
    }

    res.json({
      success: true,
      merchantRequestId: response.MerchantRequestID,
      data: response
    });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Payment initiation failed', details: error.response?.data });
  }
});

// ---------- M-Pesa STK status check (agent/station polls after sending STK) ----------
app.get('/api/mpesa/stkpush/status/:orderId', protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const uid = req.user._id.toString();

    // Authorization: order's customer, assigned agent, admin, owner, or pickup station manager
    const isCustomer = order.customerId?.toString() === uid;
    const isAssignedAgent = req.user.role === 'agent'
      && order.assignedAgentId?.toString() === uid;
    const isAdmin = ['admin', 'owner'].includes(req.user.role);
    const isStationMgr = req.user.role === 'station_manager'
      && order.deliveryInfo?.type === 'pickup'
      && order.deliveryInfo?.stationId?.toString() === req.user.stationId?.toString();

    if (!isCustomer && !isAssignedAgent && !isAdmin && !isStationMgr) {
      return res.status(403).json({ error: 'Not authorized to view this order status' });
    }

    let status;
    if (['fully_paid', 'deposit_paid', 'cash_collected'].includes(order.paymentStatus)) {
      status = 'paid';
    } else if (order.paymentStatus === 'payment_failed') {
      status = 'failed';
    } else {
      status = 'pending';
    }

    res.json({
      status,
      paymentStatus: order.paymentStatus,
      reason: order.mpesaFailureReason || null
    });
  } catch (err) {
    console.error('STK status check error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- M‑Pesa Callback ----------
app.post('/api/mpesa/callback', async (req, res) => {
  // ========== SECRET VERIFICATION ==========
  // Prevents spoofed callbacks. M-Pesa echoes the registered CALLBACK_URL,
  // which includes ?secret=... — any request without the correct secret is rejected.
  const expectedSecret = process.env.MPESA_CALLBACK_SECRET;
  const providedSecret = req.query.secret;
  if (!expectedSecret) {
    console.error('❌ MPESA_CALLBACK_SECRET not set — rejecting all callbacks for safety');
    return res.status(500).json({ ResultCode: 1, ResultDesc: 'Server misconfigured' });
  }
  if (!providedSecret || providedSecret !== expectedSecret) {
    console.warn('❌ M-Pesa callback rejected: missing or invalid secret', {
      ip: req.ip,
      hasSecret: !!providedSecret,
    });
    return res.status(403).json({ ResultCode: 1, ResultDesc: 'Forbidden' });
  }
  // ========== END SECRET VERIFICATION ==========

  // Log only non-PII fields. Full payload may contain phone numbers.
  try {
    const cb = req.body?.Body?.stkCallback;
    if (cb) {
      console.log('M-Pesa Callback:', JSON.stringify({
        MerchantRequestID: cb.MerchantRequestID,
        CheckoutRequestID: cb.CheckoutRequestID,
        ResultCode: cb.ResultCode,
        ResultDesc: cb.ResultDesc,
        Amount: cb.CallbackMetadata?.Item?.find(i => i.Name === 'Amount')?.Value,
        Receipt: cb.CallbackMetadata?.Item?.find(i => i.Name === 'MpesaReceiptNumber')?.Value
      }, null, 2));
    } else {
      console.log('M-Pesa Callback: malformed body');
    }
  } catch (e) {
    console.log('M-Pesa Callback: log error', e.message);
  }

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

    console.log(`🔍 MerchantRequestID: ${merchantRequestId}, accountRef: ${accountRef}`);

    // ===== STEP 1: Check if it's a wallet top-up (by MerchantRequestID) =====
    const topUp = await TopUpRequest.findOne({ merchantRequestId, status: 'pending' });
    if (topUp) {
      if (resultCode === 0) {
        console.log(`🔍 M-Pesa wallet top-up: userId=${topUp.userId}, amount=${topUp.amount}`);
        try {
          const result = await WalletService.credit(
            topUp.userId,
            topUp.amount,
            `Wallet top‑up via M‑Pesa (${transactionId})`,
            transactionId,
            'topup'
          );
          console.log(`💰 M-Pesa wallet credited: ${topUp.amount} KES for user ${topUp.userId}. New balance: ${result.newBalance}`);
          topUp.status = 'completed';
          await createNotification(
            topUp.userId,
            'system',
            'Wallet top‑up successful',
            `Your wallet has been credited with KES ${topUp.amount.toFixed(2)} via M‑Pesa.`,
            '/account.html'
          );
        } catch (err) {
          console.error(`❌ M-Pesa wallet top-up FAILED for user ${topUp.userId}:`, err.message);
          console.error(err.stack);
          topUp.status = 'failed';
        }
      } else {
        console.log(`❌ M-Pesa wallet top-up failed. ResultCode: ${resultCode}`);
        topUp.status = 'failed';
      }
      await topUp.save();
      return res.json({ ResultCode: 0, ResultDesc: 'Success' });
    }

    // ===== STEP 2: Sponsorship callback (lookup by MerchantRequestID) =====
    const SponsorshipRequest = require('./models/SponsorshipRequest');
    const pendingSponsor = await SponsorshipRequest.findOne({ merchantRequestId, status: 'pending' });
    if (pendingSponsor) {
      if (resultCode === 0) {
        const product = await Product.findById(pendingSponsor.productId);
        if (product) {
          product.sponsored = true;
          product.sponsoredUntil = new Date(Date.now() + pendingSponsor.days * 24 * 60 * 60 * 1000);
          await product.save();
          console.log(`⭐ Product ${product.name} (${product._id}) sponsored for ${pendingSponsor.days} days via M‑Pesa.`);
        }
        pendingSponsor.status = 'completed';
      } else {
        pendingSponsor.status = 'failed';
      }
      await pendingSponsor.save();
      return res.json({ ResultCode: 0, ResultDesc: 'Success' });
    }

    // ===== STEP 3: Otherwise, treat as order payment =====
    const Order = require('./models/Order');
    const order = await Order.findOne({ mpesaMerchantRequestId: merchantRequestId });
    if (!order) {
      console.error(`Order not found for MerchantRequestID: ${merchantRequestId}`);
      return res.status(404).json({ ResultCode: 1, ResultDesc: 'Order not found' });
    }

    // Idempotency: if this order is already in a terminal paid state, ignore duplicate callback
    if (['fully_paid', 'deposit_paid', 'cash_collected', 'refunded'].includes(order.paymentStatus)) {
      console.log(`⚠️ Duplicate M-Pesa callback for order ${order.orderId} (already ${order.paymentStatus}). Ignoring.`);
      return res.json({ ResultCode: 0, ResultDesc: 'Duplicate ignored' });
    }


    if (resultCode === 0) {
      const isDeposit = order.paymentMethod === 'mpesa_deposit';
      const expectedDeposit = isDeposit
        ? Math.round(order.totalKES * ((order.depositPercentage || 0) / 100))
        : order.totalKES;

      // ✅ Verify callback amount matches expected amount
      if (amount != null && Math.abs(Number(amount) - expectedDeposit) > 1) {
        console.error(
          `❌ M-Pesa amount mismatch for order ${order.orderId}: ` +
          `expected ${expectedDeposit}, got ${amount}. NOT marking paid.`
        );
        return res.json({ ResultCode: 1, ResultDesc: 'Amount mismatch' });
      }


      const claimed = await Order.findOneAndUpdate(
        { _id: order._id, paymentStatus: 'pending' },
        {
          $set: {
            paymentStatus: isDeposit ? 'deposit_paid' : 'fully_paid',
            mpesaTransactionId: transactionId,
            mpesaAmount: amount,
            depositPaid: isDeposit ? expectedDeposit : order.totalKES,
            balanceDue: isDeposit ? order.totalKES - expectedDeposit : 0,
            remainingBalance: isDeposit ? order.totalKES - expectedDeposit : 0,
            updatedAt: Date.now()
          }
        },
        { new: true }
      );

      if (!claimed) {
        console.log(`⚠️ Order ${order.orderId} already processed (status: ${order.paymentStatus}). Ignoring duplicate callback.`);
        return res.json({ ResultCode: 0, ResultDesc: 'Duplicate ignored' });
      }

      console.log(`Order ${order.orderId} payment confirmed via M-Pesa. Transaction ID: ${transactionId}`);

      try {
        await sendOrderConfirmationEmail(claimed);
      } catch (err) {
        console.error('❌ M-Pesa confirmation email failed:', err.message);
      }

      try {
        await processReferralReward(claimed);
      } catch (err) {
        console.error('❌ Referral reward failed for M-Pesa order:', err.message);
      }

    } else {
      await Order.findOneAndUpdate(
        { _id: order._id, paymentStatus: 'pending' },
        {
          $set: {
            paymentStatus: 'payment_failed',
            mpesaFailureReason: callbackData.ResultDesc,
            updatedAt: Date.now()
          }
        }
      );
      console.log(`Order ${order.orderId} M-Pesa payment failed: ${callbackData.ResultDesc}`);
    }

    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    console.error('M-Pesa callback error:', error);
    res.status(500).json({ ResultCode: 1, ResultDesc: 'Internal server error' });
  }
});

// ---------- Stripe Payment Intent ----------
app.post('/api/create-payment-intent', protect, async (req, res) => {
  const { amount, currency, paymentMethodId, orderId } = req.body;
  if (!amount || !paymentMethodId) {
    return res.status(400).json({ error: 'Missing amount or payment method' });
  }
  if (Number(amount) <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than 0' });
  }

  let verifiedAmount = Number(amount);

  if (orderId) {
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.customerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Order does not belong to you' });
    }

    const currentStatus = order.paymentStatus;
    if (['cancelled', 'delivered', 'refunded', 'fully_paid', 'cash_collected'].includes(currentStatus)) {
      return res.status(400).json({ error: `Order cannot accept payment (status: ${currentStatus})` });
    }

    if (currentStatus === 'payment_failed') {
      await Order.updateOne(
        { _id: orderId, paymentStatus: 'payment_failed' },
        { $set: { paymentStatus: 'pending', updatedAt: Date.now() } }
      );
    }

    const isDepositOrder = ['card_deposit'].includes(order.paymentMethod);
    let expectedAmount;

if ((currentStatus === 'pending' || currentStatus === 'payment_failed') && isDepositOrder) {
      const pct = order.depositPercentage || 0;
      if (pct <= 0 || pct > 100) {
        return res.status(400).json({ error: 'Order has invalid deposit configuration' });
      }
      expectedAmount = Math.round(order.totalKES * (pct / 100));
    } else {
      expectedAmount = order.remainingBalance > 0 ? order.remainingBalance : order.totalKES;
    }

    if (Math.abs(Number(amount) - expectedAmount) > 1) {
      return res.status(400).json({
        error: `Amount does not match. Expected KES ${expectedAmount}, got KES ${amount}.`
      });
    }

    verifiedAmount = Math.round(expectedAmount);
  }

  const amountInCents = Math.round(verifiedAmount * 100);
  if (currency === 'kes' || currency === 'KES' || !currency) {
    if (amountInCents < 5000) {
      return res.status(400).json({ error: 'Minimum payment amount is KES 50' });
    }
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

// ---------- Cloudinary test route ----------
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
  const message = process.env.NODE_ENV === 'production' ? 'Something went wrong!' : err.message;
  res.status(500).json({ error: message });
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

// ---------- Sponsor expiry cron (daily at 1:00 AM) ----------
cron.schedule('0 1 * * *', async () => {
  console.log('Running sponsor expiry cron...');
  try {
    const result = await Product.updateMany(
      { sponsored: true, sponsoredUntil: { $lt: new Date() } },
      { sponsored: false, sponsoredUntil: null }
    );
    console.log(`Expired ${result.modifiedCount} sponsorships.`);
  } catch (err) {
    console.error('Sponsor expiry cron error:', err);
  }
});

// ---------- Permanent delete archived products ----------
const PERMANENT_DELETE_DAYS = parseInt(process.env.PERMANENT_DELETE_DAYS) || 30;

cron.schedule('0 2 * * *', async () => {
  console.log('Running permanent delete cron for archived products...');
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - PERMANENT_DELETE_DAYS);

    const Order = require('./models/Order');
    const Product = require('./models/Product');

    const archivedProducts = await Product.find({
      isDeleted: true,
      deletedAt: { $lt: cutoffDate }
    });

    let deletedCount = 0;
    for (const product of archivedProducts) {
      const pendingOrders = await Order.find({
        'items.productId': product._id,
        deliveryStatus: { $nin: ['delivered', 'cancelled'] }
      });
      if (pendingOrders.length === 0) {
        await product.deleteOne();
        deletedCount++;
        console.log(`Permanently deleted product ${product.name} (${product._id})`);
      } else {
        console.log(`Skipped deleting product ${product.name} because it has pending orders.`);
      }
    }
    console.log(`Permanent delete cron completed. Deleted ${deletedCount} products.`);
  } catch (err) {
    console.error('Permanent delete cron error:', err);
  }
});

// ============================================================
// STK-QUERY RECOVERY CRON
// Recovers orders/top-ups when Safaricom's callback is lost.
// Runs every 2 minutes; queries Safaricom for stuck payments
// that have been pending longer than 3 minutes.
// ============================================================

async function queryStkStatus(checkoutRequestId) {
  const baseUrl = process.env.MPESA_BASE_URL
    || (process.env.NODE_ENV === 'production'
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke');
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(SHORTCODE + PASSKEY + timestamp).toString('base64');
  const token = await getAccessToken();
  const response = await axios.post(
    `${baseUrl}/mpesa/stkpushquery/v1/query`,
    {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return response.data;
}

async function recoverOrderViaStkQuery(order) {
  let result;
  try {
    result = await queryStkStatus(order.mpesaCheckoutRequestId);
  } catch (e) {
    console.error(`[STK recovery] query failed for ${order.orderId}: ${e.message}`);
    return;
  }

  // Safaricom returns errorCode when transaction is still processing
  if (result.errorCode) {
    console.log(`[STK recovery] ${order.orderId} still processing (${result.errorCode}).`);
    return;
  }

  const rc = String(result.ResultCode);

  if (rc === '0') {
    const isDeposit = order.paymentMethod === 'mpesa_deposit';
    const expectedDeposit = isDeposit
      ? Math.round(order.totalKES * ((order.depositPercentage || 0) / 100))
      : order.totalKES;
    const transactionId = result.MpesaReceiptNumber || result.CheckoutRequestID;

    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, paymentStatus: 'pending' },
      {
        $set: {
          paymentStatus: isDeposit ? 'deposit_paid' : 'fully_paid',
          mpesaTransactionId: transactionId,
          mpesaAmount: result.Amount || order.totalKES,
          depositPaid: isDeposit ? expectedDeposit : order.totalKES,
          balanceDue: isDeposit ? order.totalKES - expectedDeposit : 0,
          remainingBalance: isDeposit ? order.totalKES - expectedDeposit : 0,
          updatedAt: Date.now()
        }
      },
      { new: true }
    );

    if (!claimed) {
      console.log(`[STK recovery] ${order.orderId} already processed by callback.`);
      return;
    }

    console.log(`[STK recovery] ${order.orderId} recovered as ${claimed.paymentStatus}.`);

    try {
      await sendOrderConfirmationEmail(claimed);
    } catch (err) {
      console.error('[STK recovery] confirmation email failed:', err.message);
    }

    try {
      await processReferralReward(claimed);
    } catch (err) {
      console.error('[STK recovery] referral reward failed:', err.message);
    }
  } else if (['1032', '1037', '2001'].includes(rc)) {
    await Order.findOneAndUpdate(
      { _id: order._id, paymentStatus: 'pending' },
      {
        $set: {
          paymentStatus: 'payment_failed',
          mpesaFailureReason: result.ResultDesc || `Safaricom ResultCode ${rc}`,
          updatedAt: Date.now()
        }
      }
    );
    console.log(`[STK recovery] ${order.orderId} marked failed (${rc}: ${result.ResultDesc}).`);
  } else {
    console.log(`[STK recovery] ${order.orderId} unknown ResultCode ${rc}. Leaving pending.`);
  }
}

async function recoverTopUpViaStkQuery(topUp) {
  let result;
  try {
    result = await queryStkStatus(topUp.checkoutRequestId);
  } catch (e) {
    console.error(`[STK recovery] query failed for topup ${topUp._id}: ${e.message}`);
    return;
  }

  if (result.errorCode) return;

  const rc = String(result.ResultCode);

  if (rc === '0') {
    const claimed = await TopUpRequest.findOneAndUpdate(
      { _id: topUp._id, status: 'pending' },
      { $set: { status: 'completed' } },
      { new: true }
    );
    if (!claimed) return;

    try {
      await WalletService.credit(
        claimed.userId,
        claimed.amount,
        //`Wallet top-up via M-Pesa (${result.MpesaReceiptNumber || 'recovery'})`,
        `Wallet top-up via M-Pesa (Recovered via STK Query)`,
        claimed._id.toString(),
        'topup'
      );
      await createNotification(
        claimed.userId,
        'system',
        'Wallet top-up successful',
        `Your wallet has been credited with KES ${claimed.amount.toFixed(2)} via M-Pesa.`,
        '/account.html'
      );
      console.log(`[STK recovery] Topup ${claimed._id} recovered.`);
    } catch (err) {
      console.error(`[STK recovery] wallet credit failed for topup ${claimed._id}:`, err.message);
      await TopUpRequest.updateOne({ _id: claimed._id }, { $set: { status: 'failed' } });
    }
  } else if (['1032', '1037', '2001'].includes(rc)) {
    await TopUpRequest.updateOne(
      { _id: topUp._id, status: 'pending' },
      { $set: { status: 'failed' } }
    );
    console.log(`[STK recovery] Topup ${topUp._id} marked failed (${rc}).`);
  }
}

cron.schedule('*/2 * * * *', async () => {
  try {
    const cutoff = new Date(Date.now() - 3 * 60 * 1000);

    const stuckOrders = await Order.find({
      paymentMethod: { $in: ['mpesa', 'mpesa_deposit'] },
      paymentStatus: 'pending',
      mpesaCheckoutRequestId: { $ne: null },
      createdAt: { $lt: cutoff }
    }).limit(10);

    for (const order of stuckOrders) {
      await recoverOrderViaStkQuery(order);
    }

    const stuckTopUps = await TopUpRequest.find({
      status: 'pending',
      checkoutRequestId: { $ne: null },
      createdAt: { $lt: cutoff }
    }).limit(10);

    for (const topUp of stuckTopUps) {
      await recoverTopUpViaStkQuery(topUp);
    }
  } catch (e) {
    console.error('[STK recovery] cron error:', e.message);
  }
});

console.log('✅ STK recovery cron scheduled (every 2 minutes)');

// ---------- Start server ----------
const PORT = process.env.PORT || 5000;

async function start() {
  try {
    // Wait for Mongo connection to be ready.
    // Note: createOwnerIfNotExists() runs inside the mongoose.connect().then() chain
    // above, so by the time asPromise() resolves AND the .then() handler completes,
    // the owner has been created. But asPromise() may resolve before .then() finishes,
    // so we don't rely on it here — the connect chain handles owner creation.
    await mongoose.connection.asPromise();

    app.listen(PORT, () => {
      console.log(`🚀 Backend running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ Startup failed:', err);
    process.exit(1);
  }
}

start();