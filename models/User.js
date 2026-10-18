const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  fullName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: {
    type: String,
    unique: true,
    sparse: true
  },  
  password: { type: String, required: true },
  role: {
    type: String,
    enum: ['customer', 'vendor', 'agent', 'station_manager', 'admin', 'owner'],
    default: 'customer'
  },
  isSuspended: { type: Boolean, default: false },
  suspendedUntil: { type: Date },
  walletBalance: { type: Number, default: 0, min: 0 },
  stationId: { type: mongoose.Schema.Types.ObjectId, ref: 'PickupStation', default: null }, // ✅ ADDED
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], index: '2dsphere' }
  },  
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  emailVerified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

userSchema.statics.getNextUserId = async function() {
  const Counter = require('./Counter');
  const counter = await Counter.findOneAndUpdate(
    { _id: 'userId' },
    { $inc: { seq: 1 } },
    { new: true }
  );
  if (!counter) {
    throw new Error('userId counter not seeded. Ensure seedCounters() ran at startup.');
  }
  return `USR${counter.seq}`;
};

module.exports = mongoose.model('User', userSchema);