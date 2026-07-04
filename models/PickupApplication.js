const mongoose = require('mongoose');

const pickupApplicationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userName: { type: String, required: true },
  userEmail: { type: String, required: true },
  stationName: { type: String, required: true },
  address: { type: String, required: true },
  city: { type: String, required: true },
  county: { type: String, required: true },
  country: { type: String, default: 'Kenya' },
  phone: { type: String, required: true },
  email: { type: String },
  hours: { type: String },
  location: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], index: '2dsphere' }
  },  
  notes: { type: String },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  submittedAt: { type: Date, default: Date.now },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date }
});

module.exports = mongoose.model('PickupApplication', pickupApplicationSchema);