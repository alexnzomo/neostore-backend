const express = require('express');
const Banner = require('../models/Banner');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');

const router = express.Router();

// Get all active banners (public)
router.get('/', async (req, res) => {
  try {
    const banners = await Banner.find({ active: true }).sort({ order: 1 });
    res.json(banners);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin CRUD
router.post('/', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const { title, imageUrl, link, order } = req.body;

    // Manual URL scheme validation — banners have no express-validator chain
    if (!title || !imageUrl || !link) {
      return res.status(400).json({ error: 'Missing required fields: title, imageUrl, link' });
    }
    if (!/^https?:\/\//i.test(imageUrl) || !/^https?:\/\//i.test(link)) {
      return res.status(400).json({ error: 'imageUrl and link must be http/https URLs' });
    }

    const banner = new Banner({ title, imageUrl, link, order: order || 0 });
    await banner.save();
    res.status(201).json(banner);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const { title, imageUrl, link, order } = req.body;
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (imageUrl !== undefined) {
      if (!/^https?:\/\//i.test(imageUrl)) {
        return res.status(400).json({ error: 'imageUrl must be an http/https URL' });
      }
      updates.imageUrl = imageUrl;
    }
    if (link !== undefined) {
      if (!/^https?:\/\//i.test(link)) {
        return res.status(400).json({ error: 'link must be an http/https URL' });
      }
      updates.link = link;
    }
    if (order !== undefined) updates.order = order;
    updates.updatedAt = Date.now();

    const banner = await Banner.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!banner) return res.status(404).json({ error: 'Banner not found' });
    res.json(banner);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    await Banner.findByIdAndDelete(req.params.id);
    res.json({ message: 'Banner deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;