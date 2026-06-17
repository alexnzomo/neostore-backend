const mongoose = require('mongoose');

const settlementSchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  stationId: { type: mongoose.Schema.Types.ObjectId, ref: 'PickupStation', default: null },
  vendorEarnings: { type: Number, required: true, min: 0 },
  agentEarnings: { type: Number, default: 0, min: 0 },
  stationEarnings: { type: Number, default: 0, min: 0 },
  platformCommission: { type: Number, required: true, min: 0 },
  vendorPaid: { type: Boolean, default: false },
  agentPaid: { type: Boolean, default: false },
  stationPaid: { type: Boolean, default: false },
  paidAt: { type: Date, default: null },
  settledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Index for efficient queries
settlementSchema.index({ orderId: 1, vendorId: 1 }, { unique: true });
settlementSchema.index({ vendorId: 1 });
settlementSchema.index({ agentId: 1 });
settlementSchema.index({ stationId: 1 });

module.exports = mongoose.model('Settlement', settlementSchema);