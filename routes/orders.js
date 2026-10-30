// routes/orders.js
const express = require('express');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const PickupStation = require('../models/PickupStation');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const Settlement = require('../models/Settlement');
const Category = require('../models/Category');
const Settings = require('../models/Settings');
const Notification = require('../models/Notification');
const { cancelOrder, processRefund } = require('../utils/orderUtils');
const { createNotification } = require('../utils/notifications');
const { logAction } = require('../utils/audit');
const { sanitizeBody } = require('../middleware/sanitize');
const { body, validationResult } = require('express-validator');
const { sendOrderConfirmationEmail } = require('../utils/email');
const { processReferralReward } = require('../utils/referral');
const CashRecord = require('../models/CashRecord');
const KYC = require('../models/KYC');

const router = express.Router();

// ========== Helpers ==========

async function canStationManageOrder(stationManagerId, order) {
  if (order.deliveryInfo.type !== 'pickup') return false;
  const user = await User.findById(stationManagerId).select('stationId');
  if (!user || !user.stationId) return false;
  return order.deliveryInfo.stationId && order.deliveryInfo.stationId.toString() === user.stationId.toString();
}

async function getSetting(key) {
  const setting = await Settings.findOne({ key });
  return setting ? setting.value : null;
}

async function createSettlementsForOrder(order) {
  // 🔴 FRAUD PREVENTION: Block settlements for unverified manual payments
  if (order.manualPaymentMethod && order.manualPaymentMethod !== 'cash' && order.manualPaymentVerificationStatus !== 'verified') {
    console.log(`⛔ Order ${order.orderId} has pending manual payment verification. Settlements blocked.`);
    return;
  }  
  const vendorMap = {};
  const categories = await Category.find();

  // Read global commission setting — this is the fallback for products without
  // a per-product override OR a matching category. Aligns settlement calculation
  // with utils/commission.js (referral rewards) so both paths agree.
  const globalCommissionSetting = await Settings.findOne({ key: 'global_commission' });
  const globalCommission = globalCommissionSetting ? globalCommissionSetting.value : 5;

  for (const item of order.items) {
    const product = await Product.findById(item.productId);
    if (!product) continue;
    const vendorId = product.vendorId.toString();
    if (!vendorMap[vendorId]) {
      vendorMap[vendorId] = {
        vendorId: product.vendorId,
        items: [],
        subtotalUSD: 0,
        totalCommissionUSD: 0
      };
    }
    vendorMap[vendorId].items.push(item);
    vendorMap[vendorId].subtotalUSD += item.priceUSD * item.quantity;
    // Explicitly preserve 0% commission — `|| 5` would treat 0 as missing
    const categoryCommission = categories.find(c => c.name === product.category)?.commission;
    const rate = product.commissionOverride !== null
      ? product.commissionOverride
      : (categoryCommission !== undefined ? categoryCommission : globalCommission);
    const commissionAmount = item.priceUSD * item.quantity * (rate / 100);
    vendorMap[vendorId].totalCommissionUSD += commissionAmount;
  }

  const agentFee = await getSetting('agentDeliveryFee') || 0;
  const stationFee = await getSetting('stationPickupFee') || 0;

  const isPickup = order.deliveryInfo.type === 'pickup';
  const agentEarnings = order.assignedAgentId ? agentFee : 0;
  const stationEarnings = isPickup ? stationFee : 0;

  const settlements = [];
  for (const vendorId in vendorMap) {
    const data = vendorMap[vendorId];
    const vendorEarningsKES = (data.subtotalUSD - data.totalCommissionUSD) * 130;
    const platformCommissionKES = data.totalCommissionUSD * 130;

    // Idempotent upsert — safe against concurrent triggers.
    // MongoDB findOneAndUpdate with upsert can throw E11000 under concurrent calls;
    // catch it and re-read the existing settlement (created by the winning caller).
    let settlement;
    try {
      settlement = await Settlement.findOneAndUpdate(
        { orderId: order._id, vendorId: data.vendorId },
        {
          $setOnInsert: {
            orderId: order._id,
            vendorId: data.vendorId,
            agentId: order.assignedAgentId,
            stationId: isPickup ? order.deliveryInfo.stationId : null,
            vendorEarnings: vendorEarningsKES,
            agentEarnings: agentEarnings,
            stationEarnings: stationEarnings,
            platformCommission: platformCommissionKES,
            vendorPaid: false,
            agentPaid: false,
            stationPaid: false
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (upsertErr) {
      if (upsertErr.code === 11000) {
        // Concurrent upsert won the race — read the settlement it created
        settlement = await Settlement.findOne({ orderId: order._id, vendorId: data.vendorId });
      } else {
        throw upsertErr;
      }
    }

    if (settlement) {
      settlements.push(settlement);
    }
  }
  return settlements;
}

// ========== Routes ==========

// Get orders (role-scoped) – PAGINATED
router.get('/', protect, allowRoles('admin', 'owner', 'station_manager', 'agent', 'vendor'), async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const skip = parseInt(req.query.skip) || 0;

    const query = {};

    // ----  search filter ----
    if (req.query.search) {
      const rawSearch = req.query.search.trim();
      // Escape regex metacharacters to prevent ReDoS (catastrophic backtracking)
      // and regex syntax errors from user input.
      const search = rawSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      if (search.length > 0) {
        query.$or = [
          { orderId: { $regex: search, $options: 'i' } },
          { customerName: { $regex: search, $options: 'i' } },
          { customerPhone: { $regex: search, $options: 'i' } },
          { mpesaTransactionId: { $regex: search, $options: 'i' } },
          { stripePaymentIntentId: { $regex: search, $options: 'i' } },
          { manualPaymentReference: { $regex: search, $options: 'i' } }
        ];
      }
    }
    // ---- End search filter ----

    let vendorProductIds = null; // set only for vendor role

    if (req.user.role === 'station_manager') {
      const user = await User.findById(req.user._id).select('stationId');
      if (user && user.stationId) {
        // Merge with search filter (do NOT replace)
        query['deliveryInfo.type'] = 'pickup';
        query['deliveryInfo.stationId'] = user.stationId;
      } else {
        return res.json({ orders: [], total: 0, limit, skip });
      }
    } else if (req.user.role === 'agent') {
      // Agents only see orders assigned to them
      query.assignedAgentId = req.user._id;
    
    } else if (req.user.role === 'vendor') {
      // Vendors only see orders that contain at least one of their products
      vendorProductIds = await Product.find({ vendorId: req.user._id }).distinct('_id');
      query['items.productId'] = { $in: vendorProductIds };
    }

    const [orders, total] = await Promise.all([
      Order.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Order.countDocuments(query)
    ]);

    // Vendor projection: only their items and only the fields they need
    if (req.user.role === 'vendor' && vendorProductIds) {
      const myIdSet = new Set(vendorProductIds.map(id => id.toString()));
      const projected = orders.map(order => {
        const myItems = order.items.filter(it => myIdSet.has(it.productId.toString()));
        const mySubtotalUSD = myItems.reduce((s, it) => s + it.priceUSD * it.quantity, 0);
        const myVendorKES = Math.round(mySubtotalUSD * 130);
        const paidEnough = ['fully_paid', 'cash_collected', 'deposit_paid'].includes(order.paymentStatus);

        return {
          _id: order._id,
          orderId: order.orderId,
          createdAt: order.createdAt,
          items: myItems.map(it => ({
            productId: it.productId,
            name: it.name,
            priceUSD: it.priceUSD,
            quantity: it.quantity
          })),
          vendorSubtotalKES: myVendorKES,
          paymentReadyToShip: paidEnough,
          deliveryStatus: order.deliveryStatus
        };
      });
      return res.json({ orders: projected, total, limit, skip });
    }

    res.json({ orders, total, limit, skip });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create order (checkout) – protected
router.post(
  '/',
  protect,
  sanitizeBody(['customerPhone']),
  [
    body('items').isArray({ min: 1 }).withMessage('At least one item required'),
    body('items.*.productId').isMongoId().withMessage('Invalid product ID'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be positive'),
    body('deliveryInfo.type').isIn(['delivery', 'pickup']).withMessage('Invalid delivery type'),
    body('paymentMethod').isIn([
      'card', 'mpesa', 'cash_on_delivery',
      'card_deposit', 'mpesa_deposit', 'wallet', 'wallet_deposit',
      'mpesa_on_delivery'
    ]).withMessage('Invalid payment method'),
    body('depositPercentage').optional().isFloat({ min: 0, max: 100 }).withMessage('Deposit must be 0-100'),
    body('discountAmountKES').optional().isFloat({ min: 0 }).withMessage('Discount must be non‑negative'),
    body('customerPhone').trim().notEmpty().withMessage('Phone required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const {
        items,
        deliveryInfo,
        paymentMethod,
        depositPercentage,
        discountCode,
        discountAmountKES,
        idempotencyKey
      } = req.body;

      // Re-validate discount server-side; ignore any client-sent amount.
      let validatedDiscountAmountKES = 0;
      if (discountCode) {
        try {
          const Discount = require('../models/Discount');
          const discount = await Discount.findOne({ code: String(discountCode).toUpperCase() });
          if (discount) {
            const expired = discount.expiry && new Date(discount.expiry) < new Date();
            // subtotal will be computed below — validate after we know it
            // For now, just remember we have a discount to check.
            // (We'll compute the amount after subtotal is known.)
            validatedDiscountAmountKES = { discount }; // temporary holder
          }
        } catch (e) { /* ignore */ }
      }
      if (discountAmountKES !== undefined && discountAmountKES < 0) {
        return res.status(400).json({ error: 'Discount amount cannot be negative' });
      }
      
      if (depositPercentage !== undefined && (depositPercentage < 0 || depositPercentage > 100)) {
        return res.status(400).json({ error: 'Deposit percentage must be between 0 and 100' });
      }

      // Validate items
      for (const item of items) {
        if (!item.productId || !item.quantity || item.quantity <= 0) {
          return res.status(400).json({ error: 'Each item must have a valid product ID and positive quantity' });
        }
      }

      // Idempotency check
      if (idempotencyKey) {
        const existingOrder = await Order.findOne({
          customerId: req.user._id,
          idempotencyKey
        });
        if (existingOrder) {
          return res.status(409).json({ error: 'Duplicate order attempt' });
        }
      }

      // Validate delivery info based on type
      if (deliveryInfo.type === 'delivery') {
        if (!deliveryInfo.address || !String(deliveryInfo.address).trim()) {
          return res.status(400).json({ error: 'Delivery address is required for delivery orders' });
        }
        if (!deliveryInfo.city || !String(deliveryInfo.city).trim()) {
          return res.status(400).json({ error: 'Delivery city is required for delivery orders' });
        }
        if (!deliveryInfo.country || !String(deliveryInfo.country).trim()) {
          return res.status(400).json({ error: 'Delivery country is required for delivery orders' });
        }
      }


      // Resolve pickup station (prefer stationId, fallback to name for backward compatibility)
      if (deliveryInfo.type === 'pickup') {
        let station = null;

        if (deliveryInfo.stationId) {
          try {
            station = await PickupStation.findById(deliveryInfo.stationId);
          } catch (e) {
            // Invalid ObjectId format — fall through to name lookup
            station = null;
          }
        }

        if (!station && deliveryInfo.stationName) {
          station = await PickupStation.findOne({ name: deliveryInfo.stationName });
        }

        if (!station) {
          return res.status(400).json({ error: 'Pickup station not found' });
        }

        deliveryInfo.stationId = station._id;
        deliveryInfo.stationName = station.name;
        deliveryInfo.stationAddress = station.address;
        deliveryInfo.stationCity = station.city;
      }

      // Calculate totals
      let subtotalUSD = 0;
      let shippingFeeKES = 0;
      const orderItems = [];

      for (const item of items) {
        const product = await Product.findById(item.productId);
        if (!product) return res.status(400).json({ error: `Product ${item.productId} not found` });
        if (product.stock < item.quantity) {
          return res.status(400).json({ error: `Insufficient stock for ${product.name}` });
        }
        const effectivePrice = product.salePrice && product.salePrice < product.price ? product.salePrice : product.price;
        if (effectivePrice < 0) {
          return res.status(400).json({ error: `Product ${product.name} has an invalid price` });
        }
        subtotalUSD += effectivePrice * item.quantity;
        //shippingFeeKES += (product.shippingFee || 100) * item.quantity;
        orderItems.push({
          productId: product._id,
          name: product.name,
          priceUSD: effectivePrice,
          quantity: item.quantity,
          vendorName: product.vendorName || null
        });
      }

      const subtotalKES = subtotalUSD * 130;

      // Resolve discount server-side
      let finalDiscountAmount = 0;
      let finalDiscountCode = null;
      if (discountCode) {
        try {
          const Discount = require('../models/Discount');
          const discount = await Discount.findOne({ code: String(discountCode).toUpperCase() });
          if (discount) {
            const expired = discount.expiry && new Date(discount.expiry) < new Date();
            const meetsMin = !discount.minOrder || subtotalKES >= discount.minOrder;
            if (!expired && meetsMin) {
              if (discount.type === 'percentage') {
                finalDiscountAmount = Math.round(subtotalKES * (discount.value / 100));
              } else {
                finalDiscountAmount = Math.min(discount.value, subtotalKES);
              }
              finalDiscountCode = discount.code;
            }
          }
        } catch (e) { /* invalid code → no discount */ }
      }

      let totalKES = subtotalKES - finalDiscountAmount + shippingFeeKES;
      if (totalKES < 0) totalKES = 0;

      // ===== KYC ENFORCEMENT (INSERTED HERE) =====
      const kyc = await KYC.findOne({ userId: req.user._id });
      const isKycVerified = kyc && kyc.status === 'verified';

      const deliveryRequiredSetting = await Settings.findOne({ key: 'kyc_required_for_delivery' });
      const kycRequiredForDelivery = deliveryRequiredSetting ? deliveryRequiredSetting.value === 'true' : false;
      if (kycRequiredForDelivery && deliveryInfo.type === 'delivery' && !isKycVerified) {
        return res.status(403).json({
          error: 'KYC verification is required for door delivery. Please complete KYC in your account settings.'
        });
      }

      const thresholdSetting = await Settings.findOne({ key: 'kyc_order_threshold' });
      const threshold = thresholdSetting ? thresholdSetting.value : 0;
      if (threshold > 0 && totalKES >= threshold && !isKycVerified) {
        return res.status(403).json({
          error: `KYC verification is required for orders above KES ${threshold}. Please complete KYC in your account settings.`
        });
      }
      // ===== END KYC ENFORCEMENT =====

      // ===== DYNAMIC SHIPPING =====
      //const shippingSettings = await Settings.findOne({ key: 'shipping_rates' });
      //const rates = shippingSettings ? shippingSettings.value : {
      //  delivery_region_fees: { default: 600 },
      //  pickup_region_fees: { default: 100 },
      //  volume_surcharges: { small: 0, medium: 150, large: 350 }
      // };

      //let shippingFeeKES = 0;
      //const zone = req.body.zone || 'default';

      //if (deliveryInfo.type === 'pickup') {
      //  const regionFee = rates.pickup_region_fees?.[zone] || rates.pickup_region_fees?.default || 100;
      //  shippingFeeKES = regionFee; // No volume surcharge for pickup (customer does last mile)
      //} else {
      //  const regionFee = rates.delivery_region_fees?.[zone] || rates.delivery_region_fees?.default || 600;
      //  // Sum surcharges per item × quantity
        //let totalSurcharge = 0;
        //for (const item of items) {
        //  const product = await Product.findById(item.productId);
        //  if (product && product.volumeCategory) {
        //    const surcharge = rates.volume_surcharges?.[product.volumeCategory] || 0;
        //    totalSurcharge += surcharge * item.quantity;
        //  }
        //}
        //shippingFeeKES = regionFee + totalSurcharge;
      //}
      // ===== END DYNAMIC SHIPPING =====

      // ===== PER‑VENDOR SHIPPING =====
      const shippingSettings = await Settings.findOne({ key: 'shipping_rates' });

      const defaultRates = {
        delivery_region_fees: {
          'Zone 0': 150,
          'Zone 1': 250,
          'Zone 2': 400,
          'Zone 3': 500,
          'Zone 4': 600,
          'Zone 5': 700,
          'Zone 6': 900,
          default: 600
        },
        pickup_region_fees: {
          'Zone 0': 100,
          'Zone 1': 100,
          'Zone 2': 150,
          'Zone 3': 200,
          'Zone 4': 250,
          'Zone 5': 300,
          'Zone 6': 400,
          default: 100
        },
        volume_surcharges: {
          small: 0,
          medium: 150,
          large: 350
        }
      };

      let rates;
      if (shippingSettings && typeof shippingSettings.value === 'object' && shippingSettings.value !== null) {
        // Merge exactly like GET /api/settings/shipping-rates does
        const merged = { ...defaultRates, ...shippingSettings.value };
        merged.delivery_region_fees = { ...defaultRates.delivery_region_fees, ...merged.delivery_region_fees };
        merged.pickup_region_fees = { ...defaultRates.pickup_region_fees, ...merged.pickup_region_fees };
        merged.volume_surcharges = { ...defaultRates.volume_surcharges, ...merged.volume_surcharges };
        rates = merged;
      } else {
        rates = defaultRates;
      }

      shippingFeeKES = 0;
      const zone = req.body.zone || 'default';

      if (deliveryInfo.type === 'pickup') {
        // Pickup: single fee for the whole order
        const regionFee = rates.pickup_region_fees?.[zone] || rates.pickup_region_fees?.default || 100;
        shippingFeeKES = regionFee;
      } else {
        // Delivery: calculate shipping per vendor and sum
        const vendorGroups = {};

        // Group items by vendor
        for (const item of items) {
          const product = await Product.findById(item.productId);
          const vendorId = product.vendorId.toString();
          if (!vendorGroups[vendorId]) vendorGroups[vendorId] = [];
          vendorGroups[vendorId].push({ ...item, product });
        }

        const regionFee = rates.delivery_region_fees?.[zone] || rates.delivery_region_fees?.default || 600;

        for (const vendorId in vendorGroups) {
          const vendorItems = vendorGroups[vendorId];
          let vendorSurcharge = 0;

          for (const item of vendorItems) {
            const product = item.product;
            if (product && product.volumeCategory) {
              const surcharge = rates.volume_surcharges?.[product.volumeCategory] || 0;
              vendorSurcharge += surcharge * item.quantity;
            }
          }

          // Each vendor pays the same region fee + their surcharge
          shippingFeeKES += regionFee + vendorSurcharge;
        }
      }
      // ===== END PER‑VENDOR SHIPPING =====

      // Recalculate total with dynamic shipping
      totalKES = subtotalKES - (discountAmountKES || 0) + shippingFeeKES;
      if (totalKES < 0) totalKES = 0;

      let depositPaid = 0;
      let balanceDue = totalKES;
      let paymentStatus = 'pending';

      if (paymentMethod === 'card_deposit' || paymentMethod === 'mpesa_deposit' || paymentMethod === 'wallet_deposit') {
        // Deposit amount expected, but not yet collected.
        // Gateway callback / webhook will set depositPaid + balanceDue.
        balanceDue = totalKES;
        paymentStatus = 'pending';
      } else if (paymentMethod === 'card' || paymentMethod === 'mpesa' || paymentMethod === 'wallet') {
        // Full amount expected, but not yet collected.
        balanceDue = totalKES;
        paymentStatus = 'pending';
      } else if (paymentMethod === 'mpesa_on_delivery') {
        // Payment via STK when agent arrives — not collected now.
        balanceDue = totalKES;
        paymentStatus = 'pending';
      } else if (paymentMethod === 'cash_on_delivery') {
        // Reject if cash is disabled by owner
        const cashEnabledSetting = await Settings.findOne({ key: 'cash_enabled' });
        const cashEnabled = cashEnabledSetting ? cashEnabledSetting.value === 'true' : true;
        if (!cashEnabled) {
          return res.status(400).json({
            error: 'Cash on delivery is currently disabled. Please pay online or via M-Pesa on delivery.'
          });
        }
        balanceDue = totalKES;
        paymentStatus = 'pending';
      } else {
        return res.status(400).json({ error: 'Invalid payment method' });
      }

      const orderId = await Order.getNextOrderId();
      const newOrder = new Order({
        orderId,
        customerId: req.user._id,
        customerName: req.user.fullName,
        customerEmail: req.user.email,
        customerPhone: req.body.customerPhone,
        deliveryInfo,
        zone: zone || 'default',
        items: orderItems,
        subtotalUSD,
        discountAmountKES: finalDiscountAmount,
        discountCode: finalDiscountCode,
        shippingFeeKES,
        totalKES,
        paymentStatus,
        deliveryStatus: 'pending',
        paymentMethod,
        depositPaid,
        balanceDue,
        depositPercentage: depositPercentage || 0,
        assignedAgentId: null,
        cashCollected: 0,
        remainingBalance: balanceDue,
        idempotencyKey: idempotencyKey || null
      });

      // === ATOMIC STOCK DECREMENT ===
      // Guards against overselling (concurrent decrements) and restores stock
      // if the order save fails afterward (no phantom loss).
      const deductedItems = [];
      try {
        for (const item of items) {
          const result = await Product.updateOne(
            { _id: item.productId, stock: { $gte: item.quantity } },
            { $inc: { stock: -item.quantity } }
          );
          if (result.modifiedCount === 0) {
            throw new Error(`Insufficient stock for product ${item.productId}`);
          }
          deductedItems.push(item);
        }

        if (req.body.location) {
          newOrder.location = req.body.location;
        }

        await newOrder.save();
      } catch (saveErr) {
        // Rollback any stock we already decremented
        for (const item of deductedItems) {
          try {
            await Product.updateOne(
              { _id: item.productId },
              { $inc: { stock: item.quantity } }
            );
          } catch (rollbackErr) {
            console.error('Stock rollback failed:', rollbackErr.message);
          }
        }
        throw saveErr;
      }

      // Order confirmation email is sent by the payment webhook/callback
      // once the payment is confirmed. Do not send here.

      await logAction(req, 'order_created', req.user._id, { orderId: newOrder._id, total: totalKES });

      res.status(201).json(newOrder);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Get current user's orders
router.get('/my', protect, async (req, res) => {
  try {
    const orders = await Order.find({ customerId: req.user._id }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign agent to order (admin/owner only)
router.put(
  '/:id/assign-agent',
  protect,
  allowRoles('admin', 'owner'),
  sanitizeBody(['agentId']),
  [
    body('agentId').optional().isMongoId().withMessage('Invalid agent ID'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { agentId } = req.body;
      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      order.assignedAgentId = agentId || null;
      await order.save();

      await logAction(req, 'assign_agent', order.customerId, { orderId: order._id, agentId });

      res.json(order);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Assign station to order (admin/owner only)
router.put(
  '/:id/assign-station',
  protect,
  allowRoles('admin', 'owner'),
  sanitizeBody(['stationId']),
  [
    body('stationId').isMongoId().withMessage('Invalid station ID'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { stationId } = req.body;
      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      const station = await PickupStation.findById(stationId);
      if (!station) return res.status(404).json({ error: 'Station not found' });
      order.deliveryInfo.stationId = stationId;
      order.deliveryInfo.stationName = station.name;
      await order.save();

      await logAction(req, 'assign_order_station', order.customerId, { orderId: order._id, stationId });

      res.json(order);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Get single order
router.get('/:id', protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const userId = req.user._id.toString();
    const role = req.user.role;

    // Admins/owners see all
    if (role === 'admin' || role === 'owner') {
      return res.json(order);
    }

    // Customers see their own
    if (order.customerId.toString() === userId) {
      return res.json(order);
    }

    // Agents only see orders assigned to them
    if (role === 'agent') {
      if (order.assignedAgentId && order.assignedAgentId.toString() === userId) {
        return res.json(order);
      }
      return res.status(403).json({ error: 'Not assigned to this order' });
    }

    // Station managers only see pickup orders at their station
    if (role === 'station_manager') {
      const user = await User.findById(req.user._id).select('stationId');
      const matchesStation =
        user &&
        user.stationId &&
        order.deliveryInfo &&
        order.deliveryInfo.type === 'pickup' &&
        order.deliveryInfo.stationId &&
        order.deliveryInfo.stationId.toString() === user.stationId.toString();

      if (matchesStation) {
        return res.json(order);
      }
      return res.status(403).json({ error: 'Not authorized for this order' });
    }

    return res.status(403).json({ error: 'Not authorized' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update delivery status (agent/admin/owner/station_manager) – creates settlements on delivery + payment
router.put(
  '/:id/status',
  protect,
  allowRoles('agent', 'admin', 'owner', 'station_manager', 'vendor'),
  sanitizeBody(['deliveryStatus']),
  [
    body('deliveryStatus')
      .isIn(['pending', 'processing', 'shipped', 'out_for_delivery', 'ready_for_pickup', 'delivered', 'cancelled'])
      .withMessage('Invalid delivery status'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { deliveryStatus } = req.body;
      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });

      // ===== VENDOR SCOPE + RESTRICTION =====
      if (req.user.role === 'vendor') {
        const myProductIds = await Product.find({ vendorId: req.user._id }).distinct('_id');
        const myIdSet = new Set(myProductIds.map(id => id.toString()));
        const hasMyProduct = order.items.some(it => myIdSet.has(it.productId.toString()));
        if (!hasMyProduct) {
          return res.status(403).json({ error: 'Order does not contain your products' });
        }
        if (deliveryStatus !== 'processing') {
          return res.status(403).json({ error: 'Vendors can only mark orders as processing' });
        }
      }
      // ===== END VENDOR SCOPE =====

      // ===== AGENT ASSIGNMENT CHECK =====
      if (req.user.role === 'agent') {
        if (!order.assignedAgentId || order.assignedAgentId.toString() !== req.user._id.toString()) {
          return res.status(403).json({ error: 'You are not assigned to this order' });
        }
      }
      // ===== END CHECK =====

      if (req.user.role === 'station_manager') {
        const allowed = await canStationManageOrder(req.user._id, order);
        if (!allowed) {
          return res.status(403).json({ error: 'You can only update pickup orders for your station' });
        }
      }

      // ===== STATUS TRANSITION VALIDATION =====
      const transitions = {
        'pending': ['processing', 'ready_for_pickup', 'cancelled'],
        'processing': ['shipped', 'ready_for_pickup', 'cancelled'],
        'shipped': ['out_for_delivery', 'delivered', 'cancelled'],
        'out_for_delivery': ['delivered', 'cancelled'],
        'ready_for_pickup': ['delivered', 'cancelled'],
        'delivered': [],
        'cancelled': []
      };

      const current = order.deliveryStatus;
      const next = deliveryStatus;
      if (current === next) return res.json(order);
      if (!transitions[current]?.includes(next)) {
        return res.status(400).json({ error: `Invalid transition from ${current} to ${next}` });
      }
      // ===== END TRANSITION VALIDATION =====

      // ===== PAYMENT GUARD FOR DELIVERY =====
      // Block transition to 'delivered' if any money is still owed.
      // Covers cash_on_delivery, mpesa_on_delivery, and deposit orders with
      // outstanding balance. Forces payment collection before delivery.
      if (deliveryStatus === 'delivered' && order.remainingBalance > 0) {
        return res.status(400).json({
          error: `Cannot mark delivered: KES ${order.remainingBalance.toFixed(0)} still due. Collect payment first (record-cash or send STK push).`
        });
      }
      // ===== END PAYMENT GUARD =====

      order.deliveryStatus = deliveryStatus;
      order.updatedAt = Date.now();
      await order.save();

      await logAction(req, 'order_status_update', order.customerId, { orderId: order._id, newStatus: deliveryStatus });

      if (deliveryStatus === 'delivered' && (order.paymentStatus === 'fully_paid' || order.paymentStatus === 'cash_collected')) {
        await createSettlementsForOrder(order);
      }

      res.json(order);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Refund an order (admin/owner only)
router.post(
  '/:id/refund',
  protect,
  allowRoles('admin', 'owner'),
  sanitizeBody(['reason']),
  [
    body('reason').optional().trim().isLength({ max: 500 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { reason } = req.body;
      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.paymentStatus === 'refunded') return res.status(400).json({ error: 'Already refunded' });
      if (!['fully_paid', 'cash_collected', 'deposit_paid'].includes(order.paymentStatus)) {
        return res.status(400).json({ error: 'Order not eligible for refund' });
      }

      const REFUND_DAYS_LIMIT = parseInt(process.env.REFUND_DAYS_LIMIT) || 30;
      const now = new Date();
      const orderDate = new Date(order.createdAt);
      const daysDiff = (now - orderDate) / (1000 * 60 * 60 * 24);
      if (daysDiff > REFUND_DAYS_LIMIT) {
        return res.status(400).json({ error: `Refund only allowed within ${REFUND_DAYS_LIMIT} days of order creation` });
      }

      // Atomic claim — only one admin can execute the refund.
      const claimed = await Order.findOneAndUpdate(
        {
          _id: order._id,
          paymentStatus: { $in: ['fully_paid', 'cash_collected', 'deposit_paid'] }
        },
        {
          $set: {
            paymentStatus: 'refunded',
            deliveryStatus: 'cancelled',
            refundReason: reason || 'Refund requested by admin',
            refundedBy: req.user._id,
            refundedAt: new Date(),
            updatedAt: Date.now()
          }
        },
        { new: true }
      );

      if (!claimed) {
        return res.status(400).json({ error: 'Order was already refunded by another admin' });
      }

      // Restock — only reached by the winner
      for (const item of claimed.items) {
        await Product.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity } });
      }

      await processRefund(claimed);
      await Settlement.deleteMany({ orderId: claimed._id });

      await createNotification(
        claimed.customerId,
        'system',
        'Refund processed',
        `Your order #${claimed.orderId} has been refunded. Reason: ${claimed.refundReason}`,
        '/account.html'
      );

      await logAction(req, 'order_refund', claimed.customerId, { orderId: claimed._id, amount: claimed.totalKES });

      res.json({ success: true, order: claimed });
    } catch (err) {
      console.error('Refund error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Legacy confirm cash (marks entire order as cash_collected)
router.put(
  '/:id/confirm-cash',
  protect,
  allowRoles('agent', 'admin', 'owner', 'station_manager'),
  async (req, res) => {
    try {
      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (order.paymentMethod !== 'cash_on_delivery') {
        return res.status(400).json({ error: 'Only cash on delivery orders can be confirmed this way' });
      }

      if (req.user.role === 'station_manager') {
        const allowed = await canStationManageOrder(req.user._id, order);
        if (!allowed) {
          return res.status(403).json({ error: 'You can only manage pickup orders for your station' });
        }
      }

      order.paymentStatus = 'cash_collected';
      order.updatedAt = Date.now();
      await order.save();

      await logAction(req, 'confirm_cash', order.customerId, { orderId: order._id });

      if (order.deliveryStatus === 'delivered' && (order.paymentStatus === 'fully_paid' || order.paymentStatus === 'cash_collected')) {
        await createSettlementsForOrder(order);
      }

      res.json(order);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Record cash payment (partial/full) – agent/admin/owner/station_manager
router.put(
  '/:id/record-cash',
  protect,
  allowRoles('agent', 'admin', 'owner', 'station_manager'),
  sanitizeBody(['amount', 'manualPaymentMethod', 'manualPaymentReference']),
  [
    body('amount').isFloat({ min: 1 }).withMessage('Amount must be positive'),
    body('manualPaymentMethod').isIn(['cash', 'bank_transfer', 'manual_mpesa']).withMessage('Invalid payment method'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { amount, manualPaymentMethod, manualPaymentReference } = req.body;
      const verified = req.body.verified === true; // checkbox from frontend

      let order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });

      // ===== AGENT ASSIGNMENT CHECK =====
      if (req.user.role === 'agent') {
        if (!order.assignedAgentId || order.assignedAgentId.toString() !== req.user._id.toString()) {
          return res.status(403).json({ error: 'You are not assigned to this order' });
        }
      }
      // ===== END CHECK =====

      // Station manager permission check
      if (req.user.role === 'station_manager') {
        const allowed = await canStationManageOrder(req.user._id, order);
        if (!allowed) {
          return res.status(403).json({ error: 'You can only manage pickup orders for your station' });
        }
      }

      // 🔴 FOR BANK / M-PESA: Verification and reference are MANDATORY
      if (['bank_transfer', 'manual_mpesa'].includes(manualPaymentMethod)) {
        if (!verified) {
          return res.status(400).json({
            error: 'You must verify the payment (check your bank/MPesa statement) before recording.'
          });
        }
        if (!manualPaymentReference || manualPaymentReference.trim() === '') {
          return res.status(400).json({
            error: 'Reference number (e.g., M-Pesa code, Bank ref) is required for this payment method.'
          });
        }
      }

      // 🔴 BLOCK: Rejected manual payments cannot be re-recorded without admin intervention
      // Prevents infinite reject→resubmit loops and forces escalation to admin.
      // Also logs each attempt for pattern analysis.
      if (order.manualPaymentVerificationStatus === 'rejected' &&
          ['bank_transfer', 'manual_mpesa'].includes(manualPaymentMethod)) {
        try {
          await logAction(req, 'record_rejected_payment_blocked', order.customerId, {
            orderId: order._id,
            attemptedMethod: manualPaymentMethod,
            attemptedReference: manualPaymentReference || null,
            attemptedAmount: amount
          });
        } catch (e) {
          console.error('Failed to log rejected-payment attempt:', e.message);
        }

        return res.status(400).json({
          error: 'A previous manual payment for this order was rejected by admin. Please contact admin before recording a new payment. If this is a legitimate payment, admin can clear the rejection.'
        });
      }


      // 🔴 FRAUD PREVENTION: Reject duplicate M-Pesa references
      if (manualPaymentMethod === 'manual_mpesa' && manualPaymentReference) {
        const trimmedRef = manualPaymentReference.trim();
        const existingWithRef = await Order.findOne({
          _id: { $ne: order._id },
          manualPaymentMethod: 'manual_mpesa',
          manualPaymentReference: trimmedRef
        });

        if (existingWithRef) {
          // Alert admins/owners — possible fraud attempt
          try {
            const adminsAndOwners = await User.find({ role: { $in: ['admin', 'owner'] } });
            for (const recipient of adminsAndOwners) {
              await createNotification(
                recipient._id,
                'system',
                '🚨 Duplicate M-Pesa reference attempted',
                `${req.user.fullName} (${req.user.role}) tried to record M-Pesa reference "${trimmedRef}" on order #${order.orderId}, but it is already used on order #${existingWithRef.orderId}.`,
                '/admin.html?tab=manual_payments'
              );
            }
          } catch (notifyErr) {
            console.error('Duplicate-reference admin notification failed:', notifyErr.message);
          }

          return res.status(400).json({
            error: `Reference "${trimmedRef}" was already recorded on order #${existingWithRef.orderId}. A payment reference can only be used once. If this is a mistake, contact admin.`
          });
        }
      }

      // ---------- CASH ENABLED & LIMIT CHECKS ----------
      if (manualPaymentMethod === 'cash') {
        // 1. Master toggle
        const enabledSetting = await Settings.findOne({ key: 'cash_enabled' });
        const cashEnabled = enabledSetting ? enabledSetting.value === 'true' : true;
        if (!cashEnabled) {
          return res.status(403).json({ error: 'Cash payments are currently disabled by the owner.' });
        }

        // 2. Per‑order limit
        const perOrderSetting = await Settings.findOne({ key: 'cash_max_per_order' });
        const maxPerOrder = perOrderSetting ? perOrderSetting.value : 0;
        if (maxPerOrder > 0 && amount > maxPerOrder) {
          return res.status(400).json({
            error: `Cash amount (KES ${amount}) exceeds per‑order limit of KES ${maxPerOrder}.`
          });
        }

        // 3. Per‑agent daily limit
        const perDaySetting = await Settings.findOne({ key: 'cash_max_per_agent_per_day' });
        const maxPerDay = perDaySetting ? perDaySetting.value : 0;
        if (maxPerDay > 0) {
          const startOfDay = new Date();
          startOfDay.setHours(0, 0, 0, 0);
          const todayTotal = await CashRecord.aggregate([
            { $match: { userId: req.user._id, recordedAt: { $gte: startOfDay } } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
          ]);
          const currentDayTotal = todayTotal.length > 0 ? todayTotal[0].total : 0;
          if (currentDayTotal + amount > maxPerDay) {
            return res.status(400).json({
              error: `Daily cash limit (KES ${maxPerDay}) exceeded. Already collected KES ${currentDayTotal} today.`
            });
          }
        }
      }
      // ---------- END CASH CHECKS ----------

      // Check remaining balance (fast fail before the atomic update)
      if (!order.remainingBalance || order.remainingBalance <= 0) {
        return res.status(400).json({ error: 'No remaining balance to collect' });
      }
      if (amount > order.remainingBalance) {
        return res.status(400).json({ error: 'Amount exceeds remaining balance' });
      }

      // Atomic update: guard on remainingBalance so two concurrent
      // recordings can't both pass. Only one wins.
      const updatedOrder = await Order.findOneAndUpdate(
        { _id: order._id, remainingBalance: { $gte: amount } },
        {
          $inc: { cashCollected: amount, remainingBalance: -amount },
          $set: {
            manualPaymentMethod,
            manualPaymentReference: manualPaymentReference || null,
            manualPaymentVerificationStatus: manualPaymentMethod === 'cash' ? 'verified' : 'pending',
            manualPaymentVerifiedBy: req.user._id,
            manualPaymentVerifiedAt: new Date(),
            updatedAt: Date.now()
          }
        },
        { new: true }
      );

      if (!updatedOrder) {
        return res.status(409).json({
          error: 'Balance changed. Please refresh and try again.'
        });
      }

      // If fully paid, transition payment status
      if (updatedOrder.remainingBalance === 0) {
        await Order.updateOne(
          { _id: updatedOrder._id, remainingBalance: 0, paymentStatus: { $ne: 'fully_paid' } },
          { $set: { paymentStatus: 'fully_paid', updatedAt: Date.now() } }
        );
        updatedOrder.paymentStatus = 'fully_paid';
      }

      // Reassign `order` so the downstream code (CashRecord, settlements,
      // notifications) sees the updated document.
      order = updatedOrder;

      // If cash was recorded, save a CashRecord
      if (manualPaymentMethod === 'cash') {
        await CashRecord.create({
          userId: req.user._id,
          orderId: order._id,
          amount
        });
      }

      // ✅ Only trigger settlements if FULLY PAID, DELIVERED, and VERIFIED (cash only at this stage)
      if (order.paymentStatus === 'fully_paid' && order.deliveryStatus === 'delivered') {
        if (order.manualPaymentVerificationStatus === 'verified') {
          try {
            await createSettlementsForOrder(order);
          } catch (e) {
            console.error('Settlement creation failed after record-cash:', e.message);
          }
        }
      }

      await logAction(req, 'record_manual_payment', order.customerId, {
        amount,
        method: manualPaymentMethod,
        verified,
        reference: manualPaymentReference,
        status: order.manualPaymentVerificationStatus
      });

      res.json({
        success: true,
        cashCollected: order.cashCollected,
        remainingBalance: order.remainingBalance,
        paymentStatus: order.paymentStatus,
        verificationStatus: order.manualPaymentVerificationStatus
      });
    } catch (err) {
      console.error('Record cash error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// ============================================================
// ADMIN VERIFIES OR REJECTS A MANUAL PAYMENT
// ============================================================
router.put(
  '/:id/verify-manual-payment',
  protect,
  allowRoles('admin', 'owner'),
  [
    body('verified').isBoolean().withMessage('Verified must be true or false')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { verified } = req.body;
      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });

      // Cannot verify if it's not pending
      if (order.manualPaymentVerificationStatus !== 'pending') {
        return res.status(400).json({ error: 'This payment is not pending verification.' });
      }

      // Capture the original recorder BEFORE overwriting manualPaymentVerifiedBy
      const recorderId = order.manualPaymentVerifiedBy;

      // Update status
      order.manualPaymentVerificationStatus = verified ? 'verified' : 'rejected';
      order.manualPaymentVerifiedBy = req.user._id;
      order.manualPaymentVerifiedAt = new Date();

      // ✅ If verified and fully paid/delivered, trigger settlements NOW
      if (verified && order.paymentStatus === 'fully_paid' && order.deliveryStatus === 'delivered') {
        await createSettlementsForOrder(order);
      }

      await order.save();

      // Notify the agent who recorded it (not the admin who verified)
      if (recorderId) {
        await createNotification(
          recorderId,
          'system',
          verified ? '✅ Manual Payment Verified' : '❌ Manual Payment Rejected',
          verified
            ? `Order #${order.orderId} manual payment has been verified by admin.`
            : `Order #${order.orderId} manual payment was rejected by admin. Please check the reference.`,
          '/account.html'
        );
      }

      res.json({
        success: true,
        verificationStatus: order.manualPaymentVerificationStatus
      });
    } catch (err) {
      console.error('Verify manual payment error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Cancel order (customer, admin, owner)
router.put(
  '/:id/cancel',
  protect,
  sanitizeBody(['reason']),
  [
    body('reason').optional().trim().isLength({ max: 500 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });

      const isAdmin = ['admin', 'owner'].includes(req.user.role);
      if (!isAdmin && order.customerId.toString() !== req.user._id.toString()) {
        return res.status(403).json({ error: 'Not authorized to cancel this order' });
      }

      const { reason } = req.body;
      const cancelledOrder = await cancelOrder(
        order._id,
        reason || 'Order cancelled',
        req.user._id
      );

      // Notify customer
      await createNotification(
        order.customerId,
        'system',
        'Order Cancelled',
        `Your order #${order.orderId} has been cancelled. Reason: ${cancelledOrder.cancellationReason || 'No reason provided'}`,
        '/account.html'
      );

      // Notify admins/owners
      const admins = await User.find({ role: { $in: ['admin', 'owner'] } });
      for (const admin of admins) {
        await createNotification(
          admin._id,
          'system',
          'Order Cancelled by Customer',
          `Order #${order.orderId} was cancelled by ${req.user.fullName} (${req.user.email}). Reason: ${cancelledOrder.cancellationReason || 'N/A'}`,
          '/admin.html?tab=orders'
        );
      }

      await logAction(req, 'order_cancel', order.customerId, { orderId: order._id, reason });

      res.json({ success: true, order: cancelledOrder });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// Mark order as fully paid (owner only)
router.put(
  '/:id/mark-paid',
  protect,
  allowRoles('owner'),
  async (req, res) => {
    try {
      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });

      // Atomic — prevents double-marking and keeps remainingBalance consistent.
      const updated = await Order.findOneAndUpdate(
        { _id: order._id, paymentStatus: { $ne: 'fully_paid' } },
        {
          $set: {
            paymentStatus: 'fully_paid',
            remainingBalance: 0,
            balanceDue: 0,
            updatedAt: Date.now()
          }
        },
        { new: true }
      );

      if (!updated) {
        return res.status(400).json({ error: 'Order is already fully paid' });
      }

      await logAction(req, 'mark_paid', updated.customerId, { orderId: updated._id });

      try {
        await processReferralReward(updated);
      } catch (err) {
        console.error('❌ Referral reward failed for admin mark-paid:', err.message);
      }

      res.json({ success: true, order: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Get today's cash total for the logged‑in user (agent/station manager)
router.get('/cash/today-total', protect, async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const result = await CashRecord.aggregate([
    { $match: { userId: req.user._id, recordedAt: { $gte: startOfDay } } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);
  res.json({ total: result.length > 0 ? result[0].total : 0 });
});

// Record who collected a pickup order
router.put(
  '/:id/collected-by',
  protect,
  sanitizeBody(['collectedBy.name', 'collectedBy.phone']),
  [
    body('collectedBy.name').optional().trim().isLength({ max: 100 }),
    body('collectedBy.phone').optional().trim().isLength({ max: 20 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { collectedBy } = req.body;
      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      if (!['station_manager', 'admin', 'owner'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      if (req.user.role === 'station_manager') {
        const allowed = await canStationManageOrder(req.user._id, order);
        if (!allowed) {
          return res.status(403).json({ error: 'You can only record collection for your station' });
        }
      }
      order.collectedBy = collectedBy;
      await order.save();

      await logAction(req, 'record_collection', order.customerId, { orderId: order._id, collectedBy });

      res.json({ success: true, order });
    } catch (err) {
      console.error('Error recording collector info:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;