const mongoose = require('mongoose');

const topUpRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  merchantRequestId: { type: String, required: true },
  checkoutRequestId: { type: String },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('TopUpRequest', topUpRequestSchema);