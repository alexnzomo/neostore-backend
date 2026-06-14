const express = require('express');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');

const router = express.Router();

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
      assignedAgentId: null
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

// Get single order
router.get('/:id', protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.customerId.toString() !== req.user._id.toString() && !['admin', 'owner', 'agent'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update delivery status (agent/admin/owner)
router.put('/:id/status', protect, allowRoles('agent', 'admin', 'owner'), async (req, res) => {
  try {
    const { deliveryStatus } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    order.deliveryStatus = deliveryStatus;
    order.updatedAt = Date.now();
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirm cash payment (agent marks as cash collected)
router.put('/:id/confirm-cash', protect, allowRoles('agent', 'admin', 'owner'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.paymentMethod !== 'cash_on_delivery') {
      return res.status(400).json({ error: 'Only cash on delivery orders can be confirmed this way' });
    }
    order.paymentStatus = 'cash_collected';
    order.updatedAt = Date.now();
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;