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
  // Owner-assigned finance privilege — can approve withdrawals up to the threshold
  canApproveWithdrawals: { type: Boolean, default: false },
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
  updatedAt: { type: Date, default: Date.now },
  // ===== SOFT DELETE FIELDS =====
  deletedAt: { type: Date, default: null },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  deleteReason: { type: String, default: null }
  // ===== END SOFT DELETE FIELDS =====  
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

// ===== SOFT DELETE METHOD =====
// Instead of hard-deleting a user with financial history (products, settlements),
// we anonymize their PII and mark them as deleted. The _id reference stays intact
// so historical settlements still resolve to a valid User document.
userSchema.statics.softDelete = async function(userId, adminId, reason) {
  const user = await this.findById(userId);
  if (!user) throw new Error('User not found');
  if (user.role === 'owner') throw new Error('Cannot delete the platform principal');
  if (user.deletedAt) throw new Error('User already deleted');

  user.deletedAt = new Date();
  user.deletedBy = adminId;
  user.deleteReason = reason || 'Admin action';
  user.isSuspended = true;
  
  // Anonymize PII but preserve the _id reference for settlement lookups
  user.email = `deleted_${user._id}@mwechestore.invalid`;
  user.fullName = `Deleted User (${user._id.toString().slice(-6)})`;
  user.phone = null;
  user.referralCode = null;
  user.walletBalance = 0;
  user.canApproveWithdrawals = false;
  
  await user.save();
  return user;
};

module.exports = mongoose.model('User', userSchema);