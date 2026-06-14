const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true }, // human-readable ID like USR1001
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { 
    type: String, 
    enum: ['customer', 'vendor', 'agent', 'station_manager', 'admin', 'owner'],
    default: 'customer'
  },
  isSuspended: { type: Boolean, default: false },
  suspendedUntil: { type: Date },
  walletBalance: { type: Number, default: 0 }, // in KES
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Generate human-readable userId (e.g., USR1001) - you'll call this before save
userSchema.statics.getNextUserId = async function() {
  const lastUser = await this.findOne().sort({ userId: -1 });
  let nextNum = 1001;
  if (lastUser && lastUser.userId) {
    const match = lastUser.userId.match(/\d+/);
    if (match) nextNum = parseInt(match[0]) + 1;
  }
  return `USR${nextNum}`;
};

module.exports = mongoose.model('User', userSchema);