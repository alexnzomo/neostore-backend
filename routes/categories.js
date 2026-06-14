const express = require('express');
const Category = require('../models/Category');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');

const router = express.Router();

// Get all categories (public)
router.get('/', async (req, res) => {
  try {
    const categories = await Category.find().sort({ name: 1 });
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create category (admin/owner only)
router.post('/', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const { name, commission } = req.body;
    if (!name || commission === undefined) return res.status(400).json({ error: 'Name and commission required' });
    const existing = await Category.findOne({ name });
    if (existing) return res.status(400).json({ error: 'Category already exists' });
    const category = new Category({ name, commission });
    await category.save();
    res.status(201).json(category);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update category (admin/owner only)
router.put('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const { name, commission } = req.body;
    const category = await Category.findById(req.params.id);
    if (!category) return res.status(404).json({ error: 'Category not found' });
    if (name) category.name = name;
    if (commission !== undefined) category.commission = commission;
    category.updatedAt = Date.now();
    await category.save();
    res.json(category);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete category (admin/owner only)
router.delete('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    if (!category) return res.status(404).json({ error: 'Category not found' });
    await category.deleteOne();
    res.json({ message: 'Category deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;