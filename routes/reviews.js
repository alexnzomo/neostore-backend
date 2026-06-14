const express = require('express');
const Review = require('../models/Review');
const Order = require('../models/Order');
const { protect } = require('../middleware/auth');
const { sanitizeBody } = require('../middleware/sanitize');

const router = express.Router();

// Get reviews for a product (public)
router.get('/product/:productId', async (req, res) => {
  try {
    const reviews = await Review.find({ productId: req.params.productId }).sort({ createdAt: -1 });
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit a review (only if user purchased the product)
router.post('/', protect, sanitizeBody(['comment']), async (req, res) => {
  try {
    const { productId, rating, comment } = req.body;
    // Check if user has purchased this product
    const hasPurchased = await Order.findOne({
      customerId: req.user._id,
      'items.productId': productId,
      paymentStatus: { $in: ['fully_paid', 'cash_collected'] }
    });
    if (!hasPurchased) return res.status(403).json({ error: 'You can only review products you have purchased' });

    const existing = await Review.findOne({ productId, userId: req.user._id });
    if (existing) return res.status(400).json({ error: 'You have already reviewed this product' });

    const review = new Review({
      productId,
      userId: req.user._id,
      userName: req.user.fullName,
      rating,
      comment
    });
    await review.save();
    res.status(201).json(review);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin/owner can delete inappropriate reviews
router.delete('/:id', protect, async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    if (req.user.role !== 'admin' && req.user.role !== 'owner' && review.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    await review.deleteOne();
    res.json({ message: 'Review deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;