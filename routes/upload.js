const express = require('express');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('cloudinary').v2;
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

console.log('🔧 Cloudinary configured with cloud_name:', process.env.CLOUDINARY_CLOUD_NAME);

// Configure Multer storage with Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'neostore/products',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    transformation: [{ width: 800, height: 800, crop: 'limit' }]
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

const router = express.Router();

// Upload endpoint (admin/owner/vendor) – but we also allow for KYC
router.post('/', protect, upload.single('image'), async (req, res) => {
  console.log('📸 Upload request received');
  console.log('📸 req.file:', req.file);
  console.log('📸 req.body:', req.body);
  console.log('📸 Content-Type:', req.headers['content-type']);

  try {
    if (!req.file) {
      console.error('❌ No file received. Check that the field name is "image".');
      return res.status(400).json({ error: 'No file uploaded. Field name must be "image".' });
    }
    // Cloudinary returns the URL in req.file.path or req.file.secure_url
    const imageUrl = req.file.path || req.file.secure_url;
    console.log('✅ File uploaded successfully:', imageUrl);
    res.json({ success: true, imageUrl });
  } catch (err) {
    console.error('❌ Upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

module.exports = router;