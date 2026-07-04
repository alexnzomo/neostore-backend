const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userName: { type: String, required: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  adminReply: { type: String, default: null },
  adminReplyAt: { type: Date, default: null },
  adminReplyBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }  
});

module.exports = mongoose.model('Review', reviewSchema);