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
const { cancelOrder } = require('../utils/orderUtils');

const router = express.Router();

// ========== Helpers ==========

// Helper to check if a station manager is allowed to manage a given order
async function canStationManageOrder(stationManagerId, order) {
  if (order.deliveryInfo.type !== 'pickup') return false;
  const user = await User.findById(stationManagerId).select('stationId');
  if (!user || !user.stationId) return false;
  const station = await PickupStation.findById(user.stationId);
  if (!station) return false;
  return order.deliveryInfo.stationName === station.name;
}

// Helper to get a setting value
async function getSetting(key) {
  const setting = await Settings.findOne({ key });
  return setting ? setting.value : null;
}

// Helper to create settlements for all vendors in an order
async function createSettlementsForOrder(order) {
  // Group order items by vendor
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
    // Calculate commission for this item
    const rate = product.commissionOverride !== null ? product.commissionOverride : (categories.find(c => c.name === product.category)?.commission || 5);
    const commissionAmount = item.priceUSD * item.quantity * (rate / 100);
    vendorMap[vendorId].totalCommissionUSD += commissionAmount;
  }

  // Fetch agent and station fees
  const agentFee = await getSetting('agentDeliveryFee') || 0;
  const stationFee = await getSetting('stationPickupFee') || 0;

  const isPickup = order.deliveryInfo.type === 'pickup';
  const agentEarnings = order.assignedAgentId ? agentFee : 0;
  const stationEarnings = isPickup ? stationFee : 0;

  // Create one settlement per vendor
  const settlements = [];
  for (const vendorId in vendorMap) {
    const data = vendorMap[vendorId];
    const vendorEarningsKES = (data.subtotalUSD - data.totalCommissionUSD) * 130;
    const platformCommissionKES = data.totalCommissionUSD * 130;

    // Check if settlement already exists (idempotent)
    let settlement = await Settlement.findOne({
      orderId: order._id,
      vendorId: data.vendorId
    });
    if (settlement) {
      // Optional: update existing settlement
      continue;
    }

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
        const station = await PickupStation.findById(user.stationId);
        if (station) {
          query = { 'deliveryInfo.type': 'pickup', 'deliveryInfo.stationName': station.name };
        } else {
          return res.json([]);
        }
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
router.post('/', protect, async (req, res) => {
  try {
    const {
      items,
      deliveryInfo,
      paymentMethod,
      depositPercentage,
      discountCode,
      discountAmountKES
    } = req.body;

    // Validate discount and deposit values
    if (discountAmountKES !== undefined && discountAmountKES < 0) {
      return res.status(400).json({ error: 'Discount amount cannot be negative' });
    }
    if (depositPercentage !== undefined && (depositPercentage < 0 || depositPercentage > 100)) {
      return res.status(400).json({ error: 'Deposit percentage must be between 0 and 100' });
    }

    // Validate items and quantities
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }
    for (const item of items) {
      if (!item.productId || !item.quantity || item.quantity <= 0) {
        return res.status(400).json({ error: 'Each item must have a valid product ID and positive quantity' });
      }
    }

    // Validate stock and calculate totals
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

    const subtotalKES = subtotalUSD * 130; // fixed rate, can be dynamic later
    let totalKES = subtotalKES - (discountAmountKES || 0) + shippingFeeKES;
    if (totalKES < 0) totalKES = 0;

    let depositPaid = 0;
    let balanceDue = 0;
    let paymentStatus = 'pending';
    if (paymentMethod === 'card_deposit' || paymentMethod === 'mpesa_deposit') {
      depositPaid = totalKES * (depositPercentage / 100);
      balanceDue = totalKES - depositPaid;
      paymentStatus = 'deposit_paid';
    } else if (paymentMethod === 'card' || paymentMethod === 'mpesa') {
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
      remainingBalance: balanceDue
    });

    // Deduct stock
    for (const item of items) {
      await Product.updateOne({ _id: item.productId }, { $inc: { stock: -item.quantity } });
    }

    await newOrder.save();
    res.status(201).json(newOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

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
router.put('/:id/assign-agent', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const { agentId } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  order.assignedAgentId = agentId || null;
  await order.save();
  res.json(order);
});

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
router.put('/:id/status', protect, allowRoles('agent', 'admin', 'owner', 'station_manager'), async (req, res) => {
  try {
    const { deliveryStatus } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Station manager validation
    if (req.user.role === 'station_manager') {
      const allowed = await canStationManageOrder(req.user._id, order);
      if (!allowed) {
        return res.status(403).json({ error: 'You can only update pickup orders for your station' });
      }
    }

    order.deliveryStatus = deliveryStatus;
    order.updatedAt = Date.now();
    await order.save();

    // If order is delivered and payment is complete, create settlements
    if (deliveryStatus === 'delivered' && (order.paymentStatus === 'fully_paid' || order.paymentStatus === 'cash_collected')) {
      await createSettlementsForOrder(order);
    }

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Refund an order (admin/owner)
router.post('/:id/refund', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.paymentStatus === 'refunded') return res.status(400).json({ error: 'Already refunded' });
    if (!['fully_paid', 'cash_collected', 'deposit_paid'].includes(order.paymentStatus)) {
      return res.status(400).json({ error: 'Order not eligible for refund' });
    }

    // Reverse stock
    for (const item of order.items) {
      await Product.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity } });
    }

    // Refund logic for online payments (Stripe/M-Pesa) would go here – for now we just mark refunded
    // In production, you would call Stripe refund API or M-Pesa reversal.

    order.paymentStatus = 'refunded';
    order.deliveryStatus = 'cancelled';
    await order.save();

    // Reverse settlement if exists
    const settlement = await Settlement.findOne({ orderId: order._id });
    if (settlement) {
      // Optionally reverse settlement (or mark as reversed)
      // For simplicity, we can delete or mark reversed
      await Settlement.deleteOne({ _id: settlement._id });
    }

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Legacy confirm cash (marks entire order as cash_collected)
router.put('/:id/confirm-cash', protect, allowRoles('agent', 'admin', 'owner', 'station_manager'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.paymentMethod !== 'cash_on_delivery') {
      return res.status(400).json({ error: 'Only cash on delivery orders can be confirmed this way' });
    }

    // Station manager validation
    if (req.user.role === 'station_manager') {
      const allowed = await canStationManageOrder(req.user._id, order);
      if (!allowed) {
        return res.status(403).json({ error: 'You can only manage pickup orders for your station' });
      }
    }

    order.paymentStatus = 'cash_collected';
    order.updatedAt = Date.now();
    await order.save();

    // If order is delivered and payment is complete, create settlements
    if (order.deliveryStatus === 'delivered' && (order.paymentStatus === 'fully_paid' || order.paymentStatus === 'cash_collected')) {
      await createSettlementsForOrder(order);
    }

    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record cash payment (partial/full) – agent/admin/owner/station_manager
router.put('/:id/record-cash', protect, allowRoles('agent', 'admin', 'owner', 'station_manager'), async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Station manager validation
    if (req.user.role === 'station_manager') {
      const allowed = await canStationManageOrder(req.user._id, order);
      if (!allowed) {
        return res.status(403).json({ error: 'You can only manage pickup orders for your station' });
      }
    }

    // Only allow if there is a remaining balance
    if (!order.remainingBalance || order.remainingBalance <= 0) {
      return res.status(400).json({ error: 'No remaining balance to collect' });
    }
    if (amount > order.remainingBalance) {
      return res.status(400).json({ error: 'Amount exceeds remaining balance' });
    }

    order.cashCollected += amount;
    order.remainingBalance -= amount;
    if (order.remainingBalance === 0) {
      order.paymentStatus = 'fully_paid';
    }
    await order.save();

    // If order is delivered and payment is complete, create settlements
    if (order.deliveryStatus === 'delivered' && (order.paymentStatus === 'fully_paid' || order.paymentStatus === 'cash_collected')) {
      await createSettlementsForOrder(order);
    }

    res.json({ success: true, cashCollected: order.cashCollected, remainingBalance: order.remainingBalance, paymentStatus: order.paymentStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel order (customer, admin, owner)
router.put('/:id/cancel', protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Check permissions
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
    res.json({ success: true, order: cancelledOrder });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;

module.exports = router;