const express = require('express');
const Product = require('../models/Product');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const { body, validationResult } = require('express-validator');
const { sanitizeBody } = require('../middleware/sanitize');

const router = express.Router();

// Get all products (public – no auth needed)
router.get('/', async (req, res) => {
  try {
    const { category, minPrice, maxPrice, search, sponsored } = req.query;
    let filter = {};

    if (category && category !== 'all') filter.category = category;
    if (sponsored === 'true') filter.sponsored = true;
    if (search) {
      filter.name = { $regex: search, $options: 'i' };
    }
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
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

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
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const product = await Product.findById(req.params.id);
      if (!product) return res.status(404).json({ error: 'Product not found' });

      const isAuthorized = (req.user.role === 'owner' || req.user.role === 'admin' || product.vendorId.toString() === req.user._id.toString());
      if (!isAuthorized) return res.status(403).json({ error: 'Not authorized' });

      const updates = req.body;
      Object.assign(product, updates);
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

module.exports = router;