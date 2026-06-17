// models/SponsorshipRequest.js
const mongoose = require('mongoose');
const sponsorshipRequestSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  days: { type: Number, required: true },
  merchantRequestId: { type: String, required: true },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});
module.exports = mongoose.model('SponsorshipRequest', sponsorshipRequestSchema);