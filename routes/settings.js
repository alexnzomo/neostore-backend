const express = require('express');
const Settings = require('../models/Settings');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');

const router = express.Router();

// ========== Helper ==========
async function getSetting(key) {
  const setting = await Settings.findOne({ key });
  return setting ? setting.value : null;
}

// ========== Global Commission ==========
router.get('/global-commission', async (req, res) => {
  let setting = await Settings.findOne({ key: 'global_commission' });
  if (!setting) setting = { value: 5 };
  res.json({ commission: setting.value });
});

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

// ========== Deposit Percentage ==========
router.get('/deposit-percentage', async (req, res) => {
  let setting = await Settings.findOne({ key: 'deposit_percentage' });
  if (!setting) setting = { value: 30 };
  res.json({ percentage: setting.value });
});

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

// ========== Sponsorship Fee ==========
router.get('/sponsorship-fee', async (req, res) => {
  let setting = await Settings.findOne({ key: 'sponsorshipFeePerDay' });
  if (!setting) setting = { value: 500 };
  res.json({ fee: setting.value });
});

router.put('/sponsorship-fee', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const { fee } = req.body;
  if (fee === undefined || fee < 0) {
    return res.status(400).json({ error: 'Fee must be a non-negative number' });
  }
  await Settings.findOneAndUpdate(
    { key: 'sponsorshipFeePerDay' },
    { key: 'sponsorshipFeePerDay', value: fee },
    { upsert: true, new: true }
  );
  res.json({ success: true, fee });
});

// ========== Agent Delivery Fee ==========
router.get('/agent-delivery-fee', async (req, res) => {
  const value = await getSetting('agentDeliveryFee') || 0;
  res.json({ value });
});

router.put('/agent-delivery-fee', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const { fee } = req.body;
  if (fee === undefined || fee < 0) {
    return res.status(400).json({ error: 'Fee must be a non-negative number' });
  }
  await Settings.findOneAndUpdate(
    { key: 'agentDeliveryFee' },
    { key: 'agentDeliveryFee', value: fee },
    { upsert: true, new: true }
  );
  res.json({ success: true, value: fee });
});

// ========== Station Pickup Fee ==========
router.get('/station-pickup-fee', async (req, res) => {
  const value = await getSetting('stationPickupFee') || 0;
  res.json({ value });
});

router.put('/station-pickup-fee', protect, allowRoles('admin', 'owner'), async (req, res) => {
  const { fee } = req.body;
  if (fee === undefined || fee < 0) {
    return res.status(400).json({ error: 'Fee must be a non-negative number' });
  }
  await Settings.findOneAndUpdate(
    { key: 'stationPickupFee' },
    { key: 'stationPickupFee', value: fee },
    { upsert: true, new: true }
  );
  res.json({ success: true, value: fee });
});

// ========== Stripe Publishable Key (MOVED ABOVE GENERIC ROUTE) ==========
router.get('/stripe-publishable-key', async (req, res) => {
  try {
    const key = process.env.STRIPE_PUBLISHABLE_KEY;
    if (!key) {
      return res.status(500).json({ error: 'Stripe publishable key not configured' });
    }
    res.json({ key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== Generic setting getter (KEEP LAST – catches all other keys) ==========
router.get('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const value = await getSetting(key);
    res.json({ key, value: value || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;