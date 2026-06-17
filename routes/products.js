const express = require('express');
const Product = require('../models/Product');
const User = require('../models/User');
const Settings = require('../models/Settings');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const { body, validationResult } = require('express-validator');
const { sanitizeBody } = require('../middleware/sanitize');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const WalletService = require('../services/walletService');
const axios = require('axios');

const router = express.Router();

// ========== Helper: Get sponsorship fee per day ==========
async function getSponsorshipFeePerDay() {
  const setting = await Settings.findOne({ key: 'sponsorshipFeePerDay' });
  return setting ? setting.value : 500; // default 500 KES
}

// ========== Helper: Initiate M‑Pesa STK push ==========
async function initiateMpesaPayment(phoneNumber, amount, orderId) {
  const CONSUMER_KEY = process.env.CONSUMER_KEY;
  const CONSUMER_SECRET = process.env.CONSUMER_SECRET;
  const PASSKEY = process.env.PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
  const SHORTCODE = process.env.SHORTCODE || '174379';
  const CALLBACK_URL = process.env.CALLBACK_URL || 'https://your-ngrok-url.ngrok.io/callback';

  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const tokenRes = await axios.get(
    'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}` } }
  );
  const token = tokenRes.data.access_token;

  let formattedPhone = phoneNumber.toString().replace(/\D/g, '');
  if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.slice(1);
  if (!formattedPhone.startsWith('254')) formattedPhone = '254' + formattedPhone;

  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(SHORTCODE + PASSKEY + timestamp).toString('base64');

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
      AccountReference: `SPONSOR${orderId}`,
      TransactionDesc: 'Product sponsorship'
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return response.data;
}

// ========== Routes ==========

// Get all products (public)
router.get('/', async (req, res) => {
  try {
    const { category, minPrice, maxPrice, search, sponsored } = req.query;
    let filter = {};
    if (category && category !== 'all') filter.category = category;
    if (sponsored === 'true') filter.sponsored = true;
    if (search) filter.name = { $regex: search, $options: 'i' };
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = parseFloat(minPrice);
      if (maxPrice) filter.price.$lte = parseFloat(maxPrice);
    }
    const products = await Product.find(filter).sort({ sponsored: -1, createdAt: -1 });
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single product
router.get('/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create product (vendor, admin, owner)
router.post('/', protect, allowRoles('vendor', 'admin', 'owner'), [
  sanitizeBody(['name', 'description']),
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('description').trim().notEmpty().withMessage('Description is required'),
  body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  body('salePrice').optional().isFloat({ min: 0 }).withMessage('Sale price must be positive')
    .custom((value, { req }) => {
      if (value !== undefined && value >= req.body.price) {
        throw new Error('Sale price must be less than regular price');
      }
      return true;
    }),
  body('stock').isInt({ min: 0 }).withMessage('Stock must be a non‑negative integer'),
  body('shippingFee').isFloat({ min: 0 }).withMessage('Shipping fee must be positive'),
  body('imageUrl').isURL().withMessage('Invalid image URL'),
  body('category').trim().notEmpty().withMessage('Category is required'),
  body('commissionOverride').optional().isFloat({ min: 0, max: 100 }).withMessage('Commission must be between 0 and 100'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { name, description, price, salePrice, stock, shippingFee, imageUrl, category, commissionOverride, sponsored } = req.body;
    const productId = await Product.getNextProductId();
    const newProduct = new Product({
      productId,
      name,
      description,
      price,
      salePrice: salePrice || null,
      stock,
      shippingFee,
      imageUrl,
      category,
      vendorId: req.user._id,
      vendorName: req.user.fullName,
      commissionOverride: commissionOverride || null,
      sponsored: sponsored || false
    });
    await newProduct.save();
    res.status(201).json(newProduct);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update product (vendor can update own, admin/owner any)
router.put('/:id', protect, 
  sanitizeBody(['name', 'description']),
  [
    body('name').optional().trim().notEmpty(),
    body('description').optional().trim().notEmpty(),
    body('price').optional().isFloat({ min: 0 }).withMessage('Price must be positive'),
    body('salePrice').optional().isFloat({ min: 0 }).withMessage('Sale price must be positive')
      .custom((value, { req }) => {
        if (value !== undefined && req.body.price !== undefined && value >= req.body.price) {
          throw new Error('Sale price must be less than regular price');
        }
        return true;
      }),
    body('stock').optional().isInt({ min: 0 }).withMessage('Stock must be non‑negative'),
    body('shippingFee').optional().isFloat({ min: 0 }).withMessage('Shipping fee must be positive'),
    body('imageUrl').optional().isURL().withMessage('Invalid image URL'),
    body('category').optional().trim().notEmpty(),
    body('commissionOverride').optional().isFloat({ min: 0, max: 100 }).withMessage('Commission must be between 0 and 100'),
    body('sponsored').optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const product = await Product.findById(req.params.id);
      if (!product) return res.status(404).json({ error: 'Product not found' });
      const isAuthorized = (req.user.role === 'owner' || req.user.role === 'admin' || product.vendorId.toString() === req.user._id.toString());
      if (!isAuthorized) return res.status(403).json({ error: 'Not authorized' });
      Object.assign(product, req.body);
      product.updatedAt = Date.now();
      await product.save();
      res.json(product);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Delete product (vendor can delete own, admin/owner any)
router.delete('/:id', protect, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const isAuthorized = (req.user.role === 'owner' || req.user.role === 'admin' || product.vendorId.toString() === req.user._id.toString());
    if (!isAuthorized) return res.status(403).json({ error: 'Not authorized' });
    await product.deleteOne();
    res.json({ message: 'Product deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== Sponsorship ==========

// Get sponsorship fee per day (public)
router.get('/sponsorship-fee', async (req, res) => {
  try {
    const fee = await getSponsorshipFeePerDay();
    res.json({ fee });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sponsor a product (vendor pays)
router.post('/:id/sponsor', protect, async (req, res) => {
  try {
    const { days, paymentMethod, phoneNumber } = req.body;
    if (!days || days <= 0) return res.status(400).json({ error: 'Invalid number of days' });

    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const isAdmin = ['admin', 'owner'].includes(req.user.role);
    if (!isAdmin && product.vendorId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Not authorized to sponsor this product' });
    }

    const feePerDay = await getSponsorshipFeePerDay();
    const totalAmount = feePerDay * days;

    // 1. Wallet payment
    if (paymentMethod === 'wallet') {
      const user = await User.findById(req.user._id);
      if (user.walletBalance < totalAmount) {
        return res.status(400).json({ error: 'Insufficient wallet balance' });
      }
      const result = await WalletService.debit(
        req.user._id,
        totalAmount,
        `Sponsorship for ${product.name} (${days} days)`,
        product._id,
        'sponsorship'
      );
      product.sponsored = true;
      product.sponsoredUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      await product.save();
      return res.json({
        success: true,
        product,
        transaction: result.transaction,
        message: `Product sponsored for ${days} days using wallet.`
      });
    }

    // 2. Stripe payment
    if (paymentMethod === 'stripe') {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(totalAmount * 100),
        currency: 'kes',
        metadata: {
          productId: product._id.toString(),
          userId: req.user._id.toString(),
          days: days.toString(),
          type: 'sponsorship'
        }
      });
      return res.json({
        success: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: totalAmount
      });
    }

    // 3. M‑Pesa payment
    if (paymentMethod === 'mpesa') {
      if (!phoneNumber) return res.status(400).json({ error: 'Phone number required for M‑Pesa' });
      const mpesaResponse = await initiateMpesaPayment(phoneNumber, totalAmount, product._id);
      if (mpesaResponse.ResponseCode === '0') {
        // Save pending sponsorship request
        const SponsorshipRequest = require('../models/SponsorshipRequest');
        await SponsorshipRequest.create({
          productId: product._id,
          userId: req.user._id,
          days,
          merchantRequestId: mpesaResponse.MerchantRequestID,
          status: 'pending'
        });
        return res.json({
          success: true,
          message: 'M‑Pesa STK push sent. Please complete payment on your phone.',
          merchantRequestId: mpesaResponse.MerchantRequestID
        });
      } else {
        return res.status(400).json({ error: 'Failed to initiate M‑Pesa payment' });
      }
    }

    return res.status(400).json({ error: 'Invalid payment method' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;