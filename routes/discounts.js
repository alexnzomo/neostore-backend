const express = require('express');
const Discount = require('../models/Discount');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');

const router = express.Router();

// Get all discounts (admin/owner only)
router.get('/', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const discounts = await Discount.find();
    res.json(discounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create discount (admin/owner)
router.post('/', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const { code, type, value, minOrder, expiry } = req.body;
  if (!code || !type || value === undefined) {
    return res.status(400).json({ error: 'Missing required fields: code, type, value' });
  }
  const existing = await Discount.findOne({ code: code.toUpperCase() });
  if (existing) return res.status(400).json({ error: 'Discount code already exists' });

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
  const { code } = req.params;
  await Discount.findOneAndDelete({ code: code.toUpperCase() });
  res.json({ message: 'Discount deleted' });
});

// Validate a promo code (public, used in checkout)
// Expects ?subtotal=1234 (in KES)
router.get('/validate/:code', async (req, res) => {
  const code = req.params.code.toUpperCase();
  const subtotal = parseFloat(req.query.subtotal);
  if (isNaN(subtotal)) {
    return res.status(400).json({ valid: false, message: 'Missing subtotal parameter' });
  }
  const discount = await Discount.findOne({ code });
  if (!discount) {
    return res.status(404).json({ valid: false, message: 'Invalid code' });
  }
  if (discount.expiry && new Date(discount.expiry) < new Date()) {
    return res.status(400).json({ valid: false, message: 'Code expired' });
  }
  if (discount.minOrder && subtotal < discount.minOrder) {
    return res.status(400).json({ valid: false, message: `Minimum order KES ${discount.minOrder}` });
  }
  let discountAmount = 0;
  if (discount.type === 'percentage') {
    discountAmount = subtotal * (discount.value / 100);
  } else {
    discountAmount = Math.min(discount.value, subtotal);
  }
  res.json({ valid: true, discountAmount, discountCode: discount.code });
});

module.exports = router;