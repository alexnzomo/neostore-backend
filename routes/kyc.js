const express = require('express');
const KYC = require('../models/KYC');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const { body, validationResult } = require('express-validator');

const router = express.Router();

// ========== User endpoints ==========

// Submit KYC application
router.post('/submit', protect, [
  body('fullName').trim().notEmpty().withMessage('Full name is required'),
  body('dateOfBirth').isISO8601().withMessage('Valid date of birth required'),
  body('nationality').trim().notEmpty().withMessage('Nationality is required'),
  body('idNumber').trim().notEmpty().withMessage('ID number is required'),
  body('idType').isIn(['national_id', 'passport', 'drivers_license']).withMessage('Invalid ID type'),
  body('phoneNumber').trim().notEmpty().withMessage('Phone number is required'),
  body('address').trim().notEmpty().withMessage('Address is required'),
  body('idPhotoUrl').isURL().withMessage('Valid ID photo URL required'),
  body('selfiePhotoUrl').optional().isURL().withMessage('Selfie photo must be a valid URL'),
  body('proofOfAddressUrl').optional().isURL().withMessage('Proof of address must be a valid URL'),
], async (req, res) => {
  // Log the incoming request for debugging (will show in Render logs)
  console.log('📝 KYC submission received for user:', req.user._id);
  console.log('📝 Request body:', JSON.stringify(req.body, null, 2));

  // Check validation errors
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    console.log('❌ Validation errors:', errors.array());
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    // Check if user already has a KYC record
    const existing = await KYC.findOne({ userId: req.user._id });

    if (existing) {
      if (existing.status === 'pending') {
        return res.status(400).json({ error: 'KYC application already pending review' });
      }
      if (existing.status === 'verified') {
        return res.status(400).json({ error: 'KYC already verified' });
      }
      // If rejected, allow re-submission – update the existing record
      existing.fullName = req.body.fullName;
      existing.dateOfBirth = req.body.dateOfBirth;
      existing.nationality = req.body.nationality;
      existing.idNumber = req.body.idNumber;
      existing.idType = req.body.idType;
      existing.phoneNumber = req.body.phoneNumber;
      existing.address = req.body.address;
      existing.city = req.body.city || '';
      existing.country = req.body.country || 'Kenya';
      existing.idPhotoUrl = req.body.idPhotoUrl;
      existing.selfiePhotoUrl = req.body.selfiePhotoUrl || '';
      existing.proofOfAddressUrl = req.body.proofOfAddressUrl || '';
      existing.status = 'pending';
      existing.adminNote = '';
      existing.reviewedBy = null;
      existing.reviewedAt = null;
      await existing.save();
      console.log('✅ KYC re-submitted for user:', req.user._id);
      return res.json({ success: true, message: 'KYC re-submitted for review' });
    }

    // Create new KYC record
    const kyc = new KYC({
      userId: req.user._id,
      fullName: req.body.fullName,
      dateOfBirth: req.body.dateOfBirth,
      nationality: req.body.nationality,
      idNumber: req.body.idNumber,
      idType: req.body.idType,
      phoneNumber: req.body.phoneNumber,
      address: req.body.address,
      city: req.body.city || '',
      country: req.body.country || 'Kenya',
      idPhotoUrl: req.body.idPhotoUrl,
      selfiePhotoUrl: req.body.selfiePhotoUrl || '',
      proofOfAddressUrl: req.body.proofOfAddressUrl || '',
      status: 'pending'
    });
    await kyc.save();
    console.log('✅ New KYC submitted for user:', req.user._id);
    res.status(201).json({ success: true, message: 'KYC submitted for review' });

  } catch (err) {
    console.error('❌ KYC submission error:', err);
    // Return a detailed error message to the frontend
    res.status(500).json({ 
      error: 'KYC submission failed: ' + err.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : err.stack
    });
  }
});

// Get current user's KYC status
router.get('/status', protect, async (req, res) => {
  try {
    const kyc = await KYC.findOne({ userId: req.user._id });
    if (!kyc) {
      return res.json({ status: 'not_submitted' });
    }
    res.json({ status: kyc.status, data: kyc });
  } catch (err) {
    console.error('❌ KYC status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ========== Admin endpoints ==========

// List pending KYC applications
router.get('/pending', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const pending = await KYC.find({ status: 'pending' }).populate('userId', 'fullName email');
    res.json(pending);
  } catch (err) {
    console.error('❌ Error fetching pending KYC:', err);
    res.status(500).json({ error: err.message });
  }
});

// Approve or reject KYC
router.put('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const { status, adminNote } = req.body;
  if (!['verified', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be "verified" or "rejected".' });
  }
  try {
    const kyc = await KYC.findById(req.params.id);
    if (!kyc) {
      return res.status(404).json({ error: 'KYC record not found' });
    }
    kyc.status = status;
    kyc.adminNote = adminNote || '';
    kyc.reviewedBy = req.user._id;
    kyc.reviewedAt = new Date();
    await kyc.save();

    // Optionally create a notification for the user
    // (you can add this later)

    console.log(`✅ KYC ${status} for user ${kyc.userId} by admin ${req.user._id}`);
    res.json({ success: true, kyc });
  } catch (err) {
    console.error('❌ KYC review error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;