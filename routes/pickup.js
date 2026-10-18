const express = require('express');
const PickupStation = require('../models/PickupStation');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');

const router = express.Router();

// Get all pickup stations (public)
router.get('/', async (req, res) => {
  try {
    const stations = await PickupStation.find().sort({ name: 1 });
    res.json(stations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin/owner: create station
router.post('/', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const { name, address, city, county, phone, email, hours, location } = req.body;
    if (!name || !address || !city || !county || !phone) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const station = new PickupStation({
      name, address, city, county, phone,
      email: email || '',
      hours: hours || '',
      location: location || undefined
    });
    await station.save();
    res.status(201).json(station);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin/owner: update station
router.put('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const station = await PickupStation.findById(req.params.id);
    if (!station) return res.status(404).json({ error: 'Station not found' });

    const allowed = ['name', 'address', 'city', 'county', 'phone', 'email', 'hours', 'location'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) station[key] = req.body[key];
    }

    await station.save();
    res.json(station);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin/owner: delete station
router.delete('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const station = await PickupStation.findById(req.params.id);
    if (!station) return res.status(404).json({ error: 'Station not found' });

    // Refuse if a manager is assigned
    if (station.managerId) {
      return res.status(400).json({
        error: 'Station has a manager assigned. Unassign the manager first.'
      });
    }

    // Refuse if any orders reference this station as pickup
    const Order = require('../models/Order');
    const pendingOrders = await Order.countDocuments({
      'deliveryInfo.type': 'pickup',
      'deliveryInfo.stationId': station._id,
      deliveryStatus: { $nin: ['delivered', 'cancelled'] }
    });
    if (pendingOrders > 0) {
      return res.status(400).json({
        error: `Station has ${pendingOrders} active order(s). Resolve them first.`
      });
    }

    await PickupStation.findByIdAndDelete(req.params.id);
    res.json({ message: 'Station deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;