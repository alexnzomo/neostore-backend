const express = require('express');
const Settings = require('../models/Settings');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');

const router = express.Router();

// Get global commission (default 5)
router.get('/global-commission', async (req, res) => {
  let setting = await Settings.findOne({ key: 'global_commission' });
  if (!setting) setting = { value: 5 };
  res.json({ commission: setting.value });
});

// Update global commission (admin/owner only)
router.put('/global-commission', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const { commission } = req.body;
  if (commission === undefined || commission < 0 || commission > 100) {
    return res.status(400).json({ error: 'Commission must be between 0 and 100' });
  }
  await Settings.findOneAndUpdate(
    { key: 'global_commission' },
    { key: 'global_commission', value: commission },
    { upsert: true, new: true }
  );
  res.json({ success: true, commission });
});

// Get deposit percentage (default 30)
router.get('/deposit-percentage', async (req, res) => {
  let setting = await Settings.findOne({ key: 'deposit_percentage' });
  if (!setting) setting = { value: 30 };
  res.json({ percentage: setting.value });
});

// Update deposit percentage (admin/owner only)
router.put('/deposit-percentage', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const { percentage } = req.body;
  if (percentage === undefined || percentage < 0 || percentage > 100) {
    return res.status(400).json({ error: 'Percentage must be between 0 and 100' });
  }
  await Settings.findOneAndUpdate(
    { key: 'deposit_percentage' },
    { key: 'deposit_percentage', value: percentage },
    { upsert: true, new: true }
  );
  res.json({ success: true, percentage });
});

module.exports = router;