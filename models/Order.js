const mongoose = require('mongoose');
const Counter = require('./Counter');

const orderItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  name: { type: String, required: true },
  priceUSD: { type: Number, required: true, min: 0 },
  quantity: { type: Number, required: true, min: 1 }
});

const orderSchema = new mongoose.Schema({
  orderId: { type: String, unique: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  customerName: { type: String, required: true },
  customerEmail: { type: String, required: true },
  customerPhone: { type: String, required: true },
  idempotencyKey: { type: String, unique: true, sparse: true },
  
  mpesaMerchantRequestId: { type: String, default: null },
  mpesaCheckoutRequestId: { type: String, default: null },
  mpesaTransactionId: { type: String, default: null },
  mpesaFailureReason: { type: String, default: null },
  stripePaymentIntentId: { type: String, default: null },
  
  cancellationReason: { type: String, default: null },
  cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  
  refundReason: { type: String, default: null },
  refundedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  refundedAt: { type: Date, default: null },
  
  // ===== NEW: Who collected the pickup order =====
  collectedBy: {
    name: { type: String, default: null },
    phone: { type: String, default: null },
    collectedAt: { type: Date, default: null }
  },

  deliveryInfo: {
    type: { type: String, enum: ['delivery', 'pickup'], required: true },
    address: String,
    city: String,
    county: String,
    landmark: { type: String, default: null },
    stationId: { type: mongoose.Schema.Types.ObjectId, ref: 'PickupStation' },
    stationName: String
  },
  items: [orderItemSchema],
  subtotalUSD: { type: Number, required: true, min: 0 },
  discountAmountKES: { type: Number, default: 0, min: 0 },
  discountCode: { type: String, default: null },
  shippingFeeKES: { type: Number, default: 0, min: 0 },
  totalKES: { type: Number, required: true, min: 0 },
  paymentStatus: { type: String, enum: ['pending', 'deposit_paid', 'fully_paid', 'cash_collected', 'refunded'], default: 'pending' },
  deliveryStatus: { type: String, enum: ['pending', 'processing', 'shipped', 'out_for_delivery', 'ready_for_pickup', 'delivered', 'cancelled'], default: 'pending' },
  paymentMethod: { 
    type: String, 
    enum: ['card', 'mpesa', 'cash_on_delivery', 'card_deposit', 'mpesa_deposit', 'wallet', 'wallet_deposit'],
    required: true 
  },
  depositPaid: { type: Number, default: 0, min: 0 },
  balanceDue: { type: Number, default: 0, min: 0 },
  cashCollected: { type: Number, default: 0, min: 0 },
  remainingBalance: { type: Number, default: 0, min: 0 },
  assignedAgentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

orderSchema.statics.getNextOrderId = async function() {
  const counter = await Counter.findOneAndUpdate(
    { _id: 'orderId' },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `ORD${counter.seq}`;
};

module.exports = mongoose.model('Order', orderSchema);