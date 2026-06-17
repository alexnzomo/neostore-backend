const mongoose = require('mongoose');

const walletTransactionSchema = new mongoose.Schema({
  idempotencyKey: { type: String, unique: true, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: {
    type: String,
    enum: ['credit', 'debit', 'transfer_in', 'transfer_out', 'refund'],
    required: true
  },
  amount: { type: Number, required: true, min: 0 },
  balanceAfter: { type: Number, required: true },
  description: { type: String, required: true },
  referenceId: { type: String },
  // ✅ Updated: added 'settlement' and 'withdrawal'
  referenceType: { type: String, enum: ['order', 'topup', 'transfer', 'refund', 'settlement', 'withdrawal'] },
  pairTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'WalletTransaction' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'reversed'],
    default: 'pending'
  },
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date }
});

walletTransactionSchema.index({ userId: 1, createdAt: -1 });
walletTransactionSchema.index({ idempotencyKey: 1 }, { unique: true });
walletTransactionSchema.index({ referenceId: 1, referenceType: 1 });

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);