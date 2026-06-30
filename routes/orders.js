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
    const rate = product.commissionOverride !== null ? product.commissionOverride : (categories.find(c => c.name === product.category)?.commission || 5);
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

    let settlement = await Settlement.findOne({
      orderId: order._id,
      vendorId: data.vendorId
    });
    if (settlement) continue;

    settlement = new Settlement({
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
    });
    await settlement.save();
    settlements.push(settlement);
  }
  return settlements;
}

// ========== Routes ==========

// Get all orders (admin, owner, station_manager)
router.get('/', protect, allowRoles('admin', 'owner', 'station_manager'), async (req, res) => {
  try {
    let query = {};
    if (req.user.role === 'station_manager') {
      const user = await User.findById(req.user._id).select('stationId');
      if (user && user.stationId) {
        query = { 'deliveryInfo.type': 'pickup', 'deliveryInfo.stationId': user.stationId };
      } else {
        return res.json([]);
      }
    }
    const orders = await Order.find(query).sort({ createdAt: -1 });
    res.json(orders);
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
      'card_deposit', 'mpesa_deposit', 'wallet', 'wallet_deposit'
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

      // Resolve pickup station
      if (deliveryInfo.type === 'pickup' && deliveryInfo.stationName) {
        const station = await PickupStation.findOne({ name: deliveryInfo.stationName });
        if (station) {
          deliveryInfo.stationId = station._id;
        } else {
          return res.status(400).json({ error: 'Pickup station not found' });
        }
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
        shippingFeeKES += (product.shippingFee || 100) * item.quantity;
        orderItems.push({
          productId: product._id,
          name: product.name,
          priceUSD: effectivePrice,
          quantity: item.quantity
        });
      }

      const subtotalKES = subtotalUSD * 130;
      let totalKES = subtotalKES - (discountAmountKES || 0) + shippingFeeKES;
      if (totalKES < 0) totalKES = 0;

      let depositPaid = 0;
      let balanceDue = 0;
      let paymentStatus = 'pending';

      if (paymentMethod === 'card_deposit' || paymentMethod === 'mpesa_deposit' || paymentMethod === 'wallet_deposit') {
        depositPaid = totalKES * (depositPercentage / 100);
        balanceDue = totalKES - depositPaid;
        paymentStatus = 'deposit_paid';
      } else if (paymentMethod === 'card' || paymentMethod === 'mpesa' || paymentMethod === 'wallet') {
        depositPaid = totalKES;
        balanceDue = 0;
        paymentStatus = 'fully_paid';
      } else if (paymentMethod === 'cash_on_delivery') {
        depositPaid = 0;
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
        items: orderItems,
        subtotalUSD,
        discountAmountKES: discountAmountKES || 0,
        discountCode: discountCode || null,
        shippingFeeKES,
        totalKES,
        paymentStatus,
        deliveryStatus: 'pending',
        paymentMethod,
        depositPaid,
        balanceDue,
        assignedAgentId: null,
        cashCollected: 0,
        remainingBalance: balanceDue,
        idempotencyKey: idempotencyKey || null
      });

      // Deduct stock
      for (const item of items) {
        await Product.updateOne({ _id: item.productId }, { $inc: { stock: -item.quantity } });
      }

      await newOrder.save();
      // ✅ Send order confirmation email
      try {
        await sendOrderConfirmationEmail(newOrder);
      } catch (err) {
        console.error('Order confirmation email failed:', err.message);
      }      
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
    if (order.customerId.toString() !== req.user._id.toString() && !['admin', 'owner', 'agent', 'station_manager'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update delivery status (agent/admin/owner/station_manager) – creates settlements on delivery + payment
router.put(
  '/:id/status',
  protect,
  allowRoles('agent', 'admin', 'owner', 'station_manager'),
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

      if (req.user.role === 'station_manager') {
        const allowed = await canStationManageOrder(req.user._id, order);
        if (!allowed) {
          return res.status(403).json({ error: 'You can only update pickup orders for your station' });
        }
      }

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

      for (const item of order.items) {
        await Product.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity } });
      }

      await processRefund(order);

      order.paymentStatus = 'refunded';
      order.deliveryStatus = 'cancelled';
      order.refundReason = reason || 'Refund requested by admin';
      order.refundedBy = req.user._id;
      order.refundedAt = new Date();
      await order.save();

      await Settlement.deleteMany({ orderId: order._id });

      // Notify customer
      await createNotification(
        order.customerId,
        'system',
        'Refund processed',
        `Your order #${order.orderId} has been refunded. Reason: ${order.refundReason}`,
        '/account.html'
      );

      await logAction(req, 'order_refund', order.customerId, { orderId: order._id, amount: order.totalKES });

      res.json({ success: true, order });
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

      const order = await Order.findById(req.params.id);
      if (!order) return res.status(404).json({ error: 'Order not found' });

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

      // Check remaining balance
      if (!order.remainingBalance || order.remainingBalance <= 0) {
        return res.status(400).json({ error: 'No remaining balance to collect' });
      }
      if (amount > order.remainingBalance) {
        return res.status(400).json({ error: 'Amount exceeds remaining balance' });
      }

      // Update financial fields
      order.cashCollected += amount;
      order.remainingBalance -= amount;
      if (order.remainingBalance === 0) {
        order.paymentStatus = 'fully_paid';
      }

      // Store manual payment details
      order.manualPaymentMethod = manualPaymentMethod;
      order.manualPaymentReference = manualPaymentReference || null;

      // ✅ Cash is verified instantly. Bank/M-Pesa goes to Admin queue.
      order.manualPaymentVerificationStatus = manualPaymentMethod === 'cash' ? 'verified' : 'pending';
      order.manualPaymentVerifiedBy = req.user._id;
      order.manualPaymentVerifiedAt = new Date();

      await order.save();

      // ✅ Only trigger settlements if FULLY PAID, DELIVERED, and VERIFIED (cash only at this stage)
      if (order.paymentStatus === 'fully_paid' && order.deliveryStatus === 'delivered') {
        if (order.manualPaymentVerificationStatus === 'verified') {
          await createSettlementsForOrder(order);
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

      // Update status
      order.manualPaymentVerificationStatus = verified ? 'verified' : 'rejected';
      order.manualPaymentVerifiedBy = req.user._id;
      order.manualPaymentVerifiedAt = new Date();

      // ✅ If verified and fully paid/delivered, trigger settlements NOW
      if (verified && order.paymentStatus === 'fully_paid' && order.deliveryStatus === 'delivered') {
        await createSettlementsForOrder(order);
      }

      await order.save();

      // Notify the agent who recorded it
      await createNotification(
        order.manualPaymentVerifiedBy,
        'system',
        verified ? '✅ Manual Payment Verified' : '❌ Manual Payment Rejected',
        verified
          ? `Order #${order.orderId} manual payment has been verified by admin.`
          : `Order #${order.orderId} manual payment was rejected by admin. Please check the reference.`,
        '/admin.html'
      );

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
      order.paymentStatus = 'fully_paid';
      order.updatedAt = Date.now();
      await order.save();

      await logAction(req, 'mark_paid', order.customerId, { orderId: order._id });

      res.json({ success: true, order });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

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