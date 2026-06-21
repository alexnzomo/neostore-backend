const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { protect } = require('../middleware/auth');

const router = express.Router();

// Trim environment variables to remove accidental whitespace
const cloudName = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const apiKey = (process.env.CLOUDINARY_API_KEY || '').trim();
const apiSecret = (process.env.CLOUDINARY_API_SECRET || '').trim();

if (!cloudName || !apiKey || !apiSecret) {
  console.error('❌ Cloudinary credentials missing! Check Render env.');
  console.error('   cloudName:', cloudName ? 'present' : 'missing');
  console.error('   apiKey:', apiKey ? 'present' : 'missing');
  console.error('   apiSecret:', apiSecret ? 'present' : 'missing');
} else {
  console.log('✅ Cloudinary configured with cloud_name:', cloudName);
}

cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret
});

// Use memory storage
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }
});

const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Max 5MB.' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Unexpected field. Use "image".' });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
};

// Upload endpoint
router.post(
  '/',
  protect,
  (req, res, next) => {
    upload.single('image')(req, res, (err) => {
      if (err) return handleMulterError(err, req, res, next);
      next();
    });
  },
  async (req, res) => {
    console.log('📸 Upload request received');
    console.log('📸 req.file:', req.file ? 'present' : 'missing');

    try {
      if (!req.file) {
        console.error('❌ No file in request');
        return res.status(400).json({ error: 'No file uploaded. Field name must be "image".' });
      }

      // Upload buffer to Cloudinary
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: 'neostore/products',
            allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
            transformation: [{ width: 800, height: 800, crop: 'limit' }]
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(req.file.buffer);
      });

      console.log('✅ File uploaded successfully:', result.secure_url);
      res.json({
        success: true,
        imageUrl: result.secure_url,
        public_id: result.public_id,
        format: result.format
      });

    } catch (err) {
      console.error('❌ Upload error:', err);
      res.status(500).json({
        error: err.message || 'Upload failed',
        stack: process.env.NODE_ENV === 'production' ? undefined : err.stack
      });
    }
  }
);

module.exports = router;