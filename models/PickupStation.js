const mongoose = require('mongoose');

const pickupStationSchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: { type: String, required: true },
  city: { type: String, required: true },
  county: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String },
  hours: { type: String }, // e.g., "Mon-Fri 9am-6pm"
  location: {
    lat: Number,
    lng: Number
  },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('PickupStation', pickupStationSchema);