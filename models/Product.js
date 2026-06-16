const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  productId: { type: String, unique: true }, // e.g., PRD1001
  name: { type: String, required: true },
  description: { type: String, required: true },
  price: { type: Number, required: true, min: 0 }, // USD
  salePrice: { type: Number, default: null, min: 0 },
  stock: { type: Number, required: true, min: 0 },
  shippingFee: { type: Number, required: true, default: 100, min: 0 }, // KES
  imageUrl: { type: String, required: true },
  category: { type: String, required: true },
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  vendorName: { type: String, required: true },
  commissionOverride: { type: Number, min: 0, max: 100, default: null }, // null = use category/global
  sponsored: { type: Boolean, default: false },
  sponsoredUntil: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Auto-increment productId (PRD1001, PRD1002, ...)
productSchema.statics.getNextProductId = async function() {
  const lastProduct = await this.findOne().sort({ productId: -1 });
  let nextNum = 1001;
  if (lastProduct && lastProduct.productId) {
    const match = lastProduct.productId.match(/\d+/);
    if (match) nextNum = parseInt(match[0]) + 1;
  }
  return `PRD${nextNum}`;
};

module.exports = mongoose.model('Product', productSchema);