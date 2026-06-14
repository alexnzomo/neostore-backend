const mongoose = require('mongoose');

const applicationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userEmail: { type: String, required: true },
  userName: { type: String, required: true },
  role: { type: String, enum: ['vendor', 'agent'], required: true },
  businessName: { type: String, required: true },
  phone: { type: String, required: true },
  address: { type: String, required: true },
  taxId: { type: String },
  reason: { type: String, required: true },
  nationalId: { type: String, required: true },
  idImageUrl: { type: String },
  proofOfAddress: { type: String, required: true },
  dob: { type: Date, required: true },
  country: { type: String, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date },
  submittedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Application', applicationSchema);