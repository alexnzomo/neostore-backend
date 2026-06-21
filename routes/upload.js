const express = require('express');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;
const { protect } = require('../middleware/auth');

// ========== Validate Cloudinary configuration ==========
const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

if (!cloudName || !apiKey || !apiSecret) {
  console.error('❌ Cloudinary credentials missing! Check your .env file:');
  console.error('   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET');
  console.error('   Uploads will fail without these.');
} else {
  console.log('✅ Cloudinary configured with cloud_name:', cloudName);
}

// Configure Cloudinary
cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret
});

// ========== Storage config ==========
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'neostore/products',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    transformation: [{ width: 800, height: 800, crop: 'limit' }]
  }
});

// ========== Multer instance with limits ==========
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

const router = express.Router();

// ========== Helper to handle Multer errors ==========
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Max size is 5MB.' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Unexpected field. Please use field name "image".' });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
};

// ========== Upload endpoint ==========
router.post(
  '/',
  protect,
  (req, res, next) => {
    upload.single('image')(req, res, (err) => {
      if (err) {
        return handleMulterError(err, req, res, next);
      }
      next();
    });
  },
  async (req, res) => {
    console.log('📸 Upload request received');
    console.log('📸 req.file:', req.file);
    console.log('📸 req.body:', req.body);

    try {
      // Check if file was uploaded
      if (!req.file) {
        console.error('❌ No file in request');
        return res.status(400).json({ error: 'No file uploaded. Field name must be "image".' });
      }

      // Extract the URL – CloudinaryStorage provides `path` and `secure_url`
      const imageUrl = req.file.path || req.file.secure_url;
      
      if (!imageUrl) {
        console.error('❌ Cloudinary did not return a URL. req.file:', req.file);
        return res.status(500).json({ 
          error: 'Cloudinary upload succeeded but no URL was returned. Check Cloudinary configuration.' 
        });
      }

      console.log('✅ File uploaded successfully:', imageUrl);
      res.json({ 
        success: true, 
        imageUrl,
        // Include additional info for debugging if needed
        public_id: req.file.filename || req.file.public_id,
        format: req.file.format
      });

    } catch (err) {
      console.error('❌ Upload error:', err);
      // Check if it's a Cloudinary specific error
      if (err.message && err.message.includes('Cloudinary')) {
        return res.status(500).json({ 
          error: 'Cloudinary upload failed: ' + err.message,
          hint: 'Check your Cloudinary credentials and network connection.'
        });
      }
      res.status(500).json({ error: 'Upload failed: ' + err.message });
    }
  }
);

module.exports = router;