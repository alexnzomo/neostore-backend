const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const walletPINSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, required: true },
  pinHash: { type: String, required: true },
  failedAttempts: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

walletPINSchema.methods.comparePIN = async function(candidatePIN) {
  return await bcrypt.compare(candidatePIN, this.pinHash);
};

module.exports = mongoose.model('WalletPIN', walletPINSchema);