const mongoose = require('mongoose');
const otpSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  otp: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  reason: { type: String, default: 'setup' }
});
module.exports = mongoose.model('Otp', otpSchema);