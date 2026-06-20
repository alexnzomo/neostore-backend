const express = require('express');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;
const { protect } = require('../middleware/auth');

// Configure Cloudinary (ensure env vars are set)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

console.log('🔧 Cloudinary configured with cloud_name:', process.env.CLOUDINARY_CLOUD_NAME);

// Storage config
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'neostore/products',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    transformation: [{ width: 800, height: 800, crop: 'limit' }]
  }
});

// Multer instance with limits
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

const router = express.Router();

// Helper to handle Multer errors
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    // Multer-specific errors
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Max size is 5MB.' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Unexpected field. Please use field name "image".' });
    }
    // Other multer errors
    return res.status(400).json({ error: err.message });
  }
  // Other errors (e.g., Cloudinary)
  next(err);
};

// Upload endpoint
router.post(
  '/',
  protect,
  (req, res, next) => {
    // Use multer with error handling
    upload.single('image')(req, res, (err) => {
      if (err) {
        // Pass to our custom handler
        return handleMulterError(err, req, res, next);
      }
      // No error – proceed
      next();
    });
  },
  async (req, res) => {
    console.log('📸 Upload request received');
    console.log('📸 req.file:', req.file);
    console.log('📸 req.body:', req.body);

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded. Field name must be "image".' });
      }
      const imageUrl = req.file.path || req.file.secure_url;
      console.log('✅ File uploaded successfully:', imageUrl);
      res.json({ success: true, imageUrl });
    } catch (err) {
      console.error('❌ Upload error:', err);
      res.status(500).json({ error: 'Upload failed: ' + err.message });
    }
  }
);

module.exports = router;