const mongoose = require('mongoose');

const kycSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  fullName: { type: String, required: true },
  dateOfBirth: { type: Date, required: true },
  nationality: { type: String, required: true },
  idNumber: { type: String, required: true },
  idType: { type: String, enum: ['national_id', 'passport', 'drivers_license'], required: true },
  phoneNumber: { type: String, required: true },
  address: { type: String, required: true },
  city: { type: String },
  country: { type: String, default: 'Kenya' },
  idPhotoUrl: { type: String },      // Cloudinary URL
  selfiePhotoUrl: { type: String },  // optional
  proofOfAddressUrl: { type: String },
  status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
  adminNote: { type: String },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('KYC', kycSchema);