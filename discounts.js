const express = require('express');
const Discount = require('../models/Discount');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');

const router = express.Router();

// Get all discounts (admin/owner only)
router.get('/', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const discounts = await Discount.find();
  res.json(discounts);
});

// Create discount (admin/owner)
router.post('/', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const { code, type, value, minOrder, expiry } = req.body;
  if (!code || !type || value === undefined) return res.status(400).json({ error: 'Missing fields' });
  const existing = await Discount.findOne({ code: code.toUpperCase() });
  if (existing) return res.status(400).json({ error: 'Code already exists' });
  const discount = new Discount({
    code: code.toUpperCase(),
    type,
    value,
    minOrder: minOrder || 0,
    expiry: expiry || null
  });
  await discount.save();
  res.status(201).json(discount);
});

// Delete discount (admin/owner)
router.delete('/:code', protect, allowRoles('admin', 'owner'), async (req, res) => {
  await Discount.findOneAndDelete({ code: req.params.code.toUpperCase() });
  res.json({ message: 'Deleted' });
});

// Validate promo code (public, used in checkout)
router.get('/validate/:code', async (req, res) => {
  const code = req.params.code.toUpperCase();
  const discount = await Discount.findOne({ code });
  if (!discount) return res.status(404).json({ valid: false, message: 'Invalid code' });
  if (discount.expiry && new Date(discount.expiry) < new Date()) {
    return res.status(400).json({ valid: false, message: 'Code expired' });
  }
  // For validation without order total, we return the discount details; frontend will compute discountAmount.
  // But the frontend expects discountAmount. We'll compute a sample amount? Better to return discount details.
  // Our frontend uses `data.discountAmount`. We'll compute assuming a dummy subtotal? Not ideal.
  // Actually, the frontend should send the subtotal to calculate the exact discount.
  // For simplicity, we return the discount object and let frontend compute.
  // But the frontend currently expects `discountAmount`. I'll adjust the endpoint to accept a `subtotal` query parameter.
  const subtotal = parseFloat(req.query.subtotal);
  if (isNaN(subtotal)) {
    return res.json({ valid: true, discount, discountAmount: 0, message: 'Code valid (provide subtotal for amount)' });
  }
  let discountAmount = 0;
  if (discount.type === 'percentage') discountAmount = subtotal * (discount.value / 100);
  else discountAmount = Math.min(discount.value, subtotal);
  if (discount.minOrder && subtotal < discount.minOrder) {
    return res.status(400).json({ valid: false, message: `Minimum order KES ${discount.minOrder} required` });
  }
  res.json({ valid: true, discountAmount, discountCode: discount.code });
});

module.exports = router;