const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  name: { type: String, required: true },
  priceUSD: { type: Number, required: true },
  quantity: { type: Number, required: true, min: 1 }
});

const orderSchema = new mongoose.Schema({
  orderId: { type: String, unique: true }, // e.g., ORD1001
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  customerName: { type: String, required: true },
  customerEmail: { type: String, required: true },
  customerPhone: { type: String, required: true },
  deliveryInfo: {
    type: { type: String, enum: ['delivery', 'pickup'], required: true },
    address: String,
    city: String,
    county: String,
    stationId: { type: mongoose.Schema.Types.ObjectId, ref: 'PickupStation' },
    stationName: String
  },
  items: [orderItemSchema],
  subtotalUSD: { type: Number, required: true },
  discountAmountKES: { type: Number, default: 0 },
  discountCode: { type: String, default: null },
  shippingFeeKES: { type: Number, default: 0 },
  totalKES: { type: Number, required: true },
  paymentStatus: { type: String, enum: ['pending', 'deposit_paid', 'fully_paid', 'cash_collected', 'refunded'], default: 'pending' },
  deliveryStatus: { type: String, enum: ['pending', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled'], default: 'pending' },
  paymentMethod: { type: String, enum: ['card', 'mpesa', 'cash_on_delivery', 'card_deposit', 'mpesa_deposit'], required: true },
  depositPaid: { type: Number, default: 0 },
  balanceDue: { type: Number, default: 0 },
  assignedAgentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

orderSchema.statics.getNextOrderId = async function() {
  const lastOrder = await this.findOne().sort({ orderId: -1 });
  let nextNum = 1001;
  if (lastOrder && lastOrder.orderId) {
    const match = lastOrder.orderId.match(/\d+/);
    if (match) nextNum = parseInt(match[0]) + 1;
  }
  return `ORD${nextNum}`;
};

module.exports = mongoose.model('Order', orderSchema);