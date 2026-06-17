const express = require('express');
const KYC = require('../models/KYC');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const { body, validationResult } = require('express-validator');

const router = express.Router();

// ========== User endpoints ==========

// Submit KYC application
router.post('/submit', protect, [
  body('fullName').trim().notEmpty(),
  body('dateOfBirth').isISO8601(),
  body('nationality').trim().notEmpty(),
  body('idNumber').trim().notEmpty(),
  body('idType').isIn(['national_id', 'passport', 'drivers_license']),
  body('phoneNumber').trim().notEmpty(),
  body('address').trim().notEmpty(),
  body('idPhotoUrl').isURL(),
  body('selfiePhotoUrl').isURL().withMessage('Selfie photo is required'), // remove .optional()
  body('proofOfAddressUrl').optional().isURL(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const existing = await KYC.findOne({ userId: req.user._id });
    if (existing) {
      if (existing.status === 'pending') {
        return res.status(400).json({ error: 'KYC application already pending' });
      }
      if (existing.status === 'verified') {
        return res.status(400).json({ error: 'KYC already verified' });
      }
      // If rejected, allow re-submission – we'll update the existing record
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
      return res.json({ success: true, message: 'KYC re-submitted for review' });
    }

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
    res.status(201).json({ success: true, message: 'KYC submitted for review' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get current user's KYC status
router.get('/status', protect, async (req, res) => {
  try {
    const kyc = await KYC.findOne({ userId: req.user._id });
    if (!kyc) return res.json({ status: 'not_submitted' });
    res.json({ status: kyc.status, data: kyc });
  } catch (err) {
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
    res.status(500).json({ error: err.message });
  }
});

// Approve or reject KYC
router.put('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const { status, adminNote } = req.body;
  if (!['verified', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    const kyc = await KYC.findById(req.params.id);
    if (!kyc) return res.status(404).json({ error: 'KYC record not found' });
    kyc.status = status;
    kyc.adminNote = adminNote || '';
    kyc.reviewedBy = req.user._id;
    kyc.reviewedAt = new Date();
    await kyc.save();
    res.json({ success: true, kyc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;