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
    const station = new PickupStation(req.body);
    await station.save();
    res.status(201).json(station);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin/owner: update station
router.put('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    const station = await PickupStation.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!station) return res.status(404).json({ error: 'Station not found' });
    res.json(station);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin/owner: delete station
router.delete('/:id', protect, allowRoles('admin', 'owner'), async (req, res) => {
  try {
    await PickupStation.findByIdAndDelete(req.params.id);
    res.json({ message: 'Station deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;