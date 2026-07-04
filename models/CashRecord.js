const mongoose = require('mongoose');

const cashRecordSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  amount: { type: Number, required: true, min: 0 },
  recordedAt: { type: Date, default: Date.now }
});

// Index for daily aggregation
cashRecordSchema.index({ userId: 1, recordedAt: -1 });

module.exports = mongoose.model('CashRecord', cashRecordSchema);