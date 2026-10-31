const express = require('express');
const Settings = require('../models/Settings');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const { logAction } = require('../utils/audit');

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
  if (!setting) setting = { value: 150 };
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

// ========== Stripe Publishable Key ==========
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

// ========== Withdrawals Freeze ==========
router.get('/withdrawals-frozen', async (req, res) => {
  const setting = await Settings.findOne({ key: 'withdrawals_frozen' });
  res.json({ frozen: setting ? setting.value === 'true' : false });
});

router.put('/withdrawals-frozen', protect, allowRoles('owner'), async (req, res) => {
  const { frozen } = req.body;
  await Settings.findOneAndUpdate(
    { key: 'withdrawals_frozen' },
    { key: 'withdrawals_frozen', value: frozen ? 'true' : 'false' },
    { upsert: true, new: true }
  );
  await logAction(req, 'toggle_withdrawal_freeze', null, { frozen });
  res.json({ success: true, frozen });
});

// ========== Referral Settings (Owner Only) ==========

// Get referral percentage (public — admin dashboard reads it)
router.get('/referralPercentage', async (req, res) => {
  const value = await getSetting('referralPercentage');
  res.json({ value: value !== null ? value : 15 });
});

// Get minimum order amount for referral reward (public — admin dashboard reads it)
router.get('/minReferralOrder', async (req, res) => {
  const value = await getSetting('minReferralOrder');
  res.json({ value: value !== null ? value : 3000 });
});

// Set referral percentage (0-100%)
router.put(
  '/referralPercentage',
  protect,
  allowRoles('owner'), // ✅ ONLY OWNER can change this
  async (req, res) => {
    const { value } = req.body;
    if (value === undefined || isNaN(value) || value < 0 || value > 100) {
      return res.status(400).json({ error: 'Percentage must be between 0 and 100' });
    }
    await Settings.findOneAndUpdate(
      { key: 'referralPercentage' },
      { key: 'referralPercentage', value },
      { upsert: true, new: true }
    );
    res.json({ success: true, value });
  }
);

// Set minimum order amount for referral reward
router.put(
  '/minReferralOrder',
  protect,
  allowRoles('owner'), // ✅ ONLY OWNER can change this
  async (req, res) => {
    const { value } = req.body;
    if (value === undefined || isNaN(value) || value < 0) {
      return res.status(400).json({ error: 'Minimum order must be a positive number' });
    }
    await Settings.findOneAndUpdate(
      { key: 'minReferralOrder' },
      { key: 'minReferralOrder', value },
      { upsert: true, new: true }
    );
    res.json({ success: true, value });
  }
);

// ========== Cash Payment Controls ==========

// Get cash enabled status (public)
router.get('/cash-enabled', async (req, res) => {
  const setting = await Settings.findOne({ key: 'cash_enabled' });
  res.json({ enabled: setting ? setting.value === 'true' : true });
});

// Update cash enabled (owner only)
router.put('/cash-enabled', protect, allowRoles('owner'), async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  await Settings.findOneAndUpdate(
    { key: 'cash_enabled' },
    { key: 'cash_enabled', value: enabled ? 'true' : 'false' },
    { upsert: true, new: true }
  );
  res.json({ success: true, enabled });
});

// Get per‑order cash limit (0 = no limit)
router.get('/cash-max-per-order', async (req, res) => {
  const setting = await Settings.findOne({ key: 'cash_max_per_order' });
  res.json({ value: setting ? setting.value : 0 });
});

// Update per‑order cash limit (owner only)
router.put('/cash-max-per-order', protect, allowRoles('owner'), async (req, res) => {
  const { value } = req.body;
  if (value === undefined || value < 0) {
    return res.status(400).json({ error: 'Value must be >= 0' });
  }
  await Settings.findOneAndUpdate(
    { key: 'cash_max_per_order' },
    { key: 'cash_max_per_order', value },
    { upsert: true, new: true }
  );
  res.json({ success: true, value });
});

// Get per‑agent daily cash limit (0 = no limit)
router.get('/cash-max-per-agent-per-day', async (req, res) => {
  const setting = await Settings.findOne({ key: 'cash_max_per_agent_per_day' });
  res.json({ value: setting ? setting.value : 0 });
});

// Update per‑agent daily cash limit (owner only)
router.put('/cash-max-per-agent-per-day', protect, allowRoles('owner'), async (req, res) => {
  const { value } = req.body;
  if (value === undefined || value < 0) {
    return res.status(400).json({ error: 'Value must be >= 0' });
  }
  await Settings.findOneAndUpdate(
    { key: 'cash_max_per_agent_per_day' },
    { key: 'cash_max_per_agent_per_day', value },
    { upsert: true, new: true }
  );
  res.json({ success: true, value });
});

// Get/set KYC threshold for orders (0 = no threshold)
router.get('/kyc-order-threshold', async (req, res) => {
  const setting = await Settings.findOne({ key: 'kyc_order_threshold' });
  res.json({ value: setting ? setting.value : 0 });
});
router.put('/kyc-order-threshold', protect, allowRoles('owner'), async (req, res) => {
  const { value } = req.body;
  if (value === undefined || value < 0) return res.status(400).json({ error: 'Value must be >= 0' });
  await Settings.findOneAndUpdate(
    { key: 'kyc_order_threshold' },
    { key: 'kyc_order_threshold', value },
    { upsert: true, new: true }
  );
  res.json({ success: true, value });
});

// Get/set whether KYC is required for door delivery (true/false)
router.get('/kyc-required-for-delivery', async (req, res) => {
  const setting = await Settings.findOne({ key: 'kyc_required_for_delivery' });
  res.json({ required: setting ? setting.value === 'true' : false });
});
router.put('/kyc-required-for-delivery', protect, allowRoles('owner'), async (req, res) => {
  const { required } = req.body;
  if (typeof required !== 'boolean') return res.status(400).json({ error: 'Must be boolean' });
  await Settings.findOneAndUpdate(
    { key: 'kyc_required_for_delivery' },
    { key: 'kyc_required_for_delivery', value: required ? 'true' : 'false' },
    { upsert: true, new: true }
  );
  res.json({ success: true, required });
});

// Get shipping rates
router.get('/shipping-rates', async (req, res) => {
  const setting = await Settings.findOne({ key: 'shipping_rates' });
  const defaultRates = {
    delivery_region_fees: {
      'Zone 0': 150, 
      'Zone 1': 250,
      'Zone 2': 400,
      'Zone 3': 500,
      'Zone 4': 600,
      'Zone 5': 700,
      'Zone 6': 900,
      default: 600
    },
    pickup_region_fees: {
      'Zone 0': 100,
      'Zone 1': 100,
      'Zone 2': 150,
      'Zone 3': 200,
      'Zone 4': 250,
      'Zone 5': 300,
      'Zone 6': 400,
      default: 100
    },
    volume_surcharges: {
      small: 0,
      medium: 150,
      large: 350
    }
  };

  // If no setting, or value is not a valid object, return defaults
  if (!setting || typeof setting.value !== 'object' || setting.value === null) {
    return res.json(defaultRates);
  }

  // Merge with defaults to guarantee all keys exist
  const merged = { ...defaultRates, ...setting.value };
  merged.delivery_region_fees = { ...defaultRates.delivery_region_fees, ...merged.delivery_region_fees };
  merged.pickup_region_fees = { ...defaultRates.pickup_region_fees, ...merged.pickup_region_fees };
  merged.volume_surcharges = { ...defaultRates.volume_surcharges, ...merged.volume_surcharges };
  res.json(merged);
});

// Update shipping rates (owner only)
router.put('/shipping-rates', protect, allowRoles('owner'), async (req, res) => {
  const { delivery_region_fees, pickup_region_fees, volume_surcharges } = req.body;

  if (!delivery_region_fees || !pickup_region_fees || !volume_surcharges) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Validate volume_surcharges shape — must have small, medium, large as non-negative numbers.
  // Without this, a malformed save (e.g. missing 'medium') is silently merged with defaults
  // on read, masking the admin's incomplete save.
  const vs = volume_surcharges;
  const requiredKeys = ['small', 'medium', 'large'];
  for (const key of requiredKeys) {
    if (typeof vs[key] !== 'number' || vs[key] < 0 || !Number.isFinite(vs[key])) {
      return res.status(400).json({
        error: `volume_surcharges.${key} must be a non-negative number. Got: ${JSON.stringify(vs[key])}`
      });
    }
  }

  // Validate delivery_region_fees and pickup_region_fees are objects
  if (typeof delivery_region_fees !== 'object' || Array.isArray(delivery_region_fees)) {
    return res.status(400).json({ error: 'delivery_region_fees must be an object' });
  }
  if (typeof pickup_region_fees !== 'object' || Array.isArray(pickup_region_fees)) {
    return res.status(400).json({ error: 'pickup_region_fees must be an object' });
  }

  const rates = { delivery_region_fees, pickup_region_fees, volume_surcharges: vs };

  await Settings.findOneAndUpdate(
    { key: 'shipping_rates' },
    { key: 'shipping_rates', value: rates },
    { upsert: true, new: true }
  );

  res.json({ success: true, rates });
});

// ========== Withdrawal Approval Threshold ==========
router.get('/withdrawal-approval-threshold', async (req, res) => {
  const value = await getSetting('withdrawal_approval_threshold');
  res.json({ value: value !== null ? value : 20000 });
});

router.put('/withdrawal-approval-threshold', protect, allowRoles('owner'), async (req, res) => {
  const { value } = req.body;
  if (typeof value !== 'number' || value < 0) {
    return res.status(400).json({ error: 'Value must be a non-negative number' });
  }
  await Settings.findOneAndUpdate(
    { key: 'withdrawal_approval_threshold' },
    { key: 'withdrawal_approval_threshold', value },
    { upsert: true, new: true }
  );
  res.json({ success: true, value });
});

// ========== Withdrawal Fee Structure ==========
router.get('/withdrawalFeeFlat', async (req, res) => {
  const value = await getSetting('withdrawalFeeFlat');
  res.json({ value: value !== null ? value : 30 });
});

router.put('/withdrawalFeeFlat', protect, allowRoles('owner'), async (req, res) => {
  const { value } = req.body;
  if (value === undefined || value < 0) return res.status(400).json({ error: 'Value must be >= 0' });
  await Settings.findOneAndUpdate(
    { key: 'withdrawalFeeFlat' },
    { key: 'withdrawalFeeFlat', value },
    { upsert: true, new: true }
  );
  res.json({ success: true, value });
});

router.get('/withdrawalFeePercentage', async (req, res) => {
  const value = await getSetting('withdrawalFeePercentage');
  res.json({ value: value !== null ? value : 1 });
});

router.put('/withdrawalFeePercentage', protect, allowRoles('owner'), async (req, res) => {
  const { value } = req.body;
  if (value === undefined || value < 0 || value > 100) {
    return res.status(400).json({ error: 'Value must be between 0 and 100' });
  }
  await Settings.findOneAndUpdate(
    { key: 'withdrawalFeePercentage' },
    { key: 'withdrawalFeePercentage', value },
    { upsert: true, new: true }
  );
  res.json({ success: true, value });
});

router.get('/withdrawalFeeThreshold', async (req, res) => {
  const value = await getSetting('withdrawalFeeThreshold');
  res.json({ value: value !== null ? value : 10000 });
});

router.put('/withdrawalFeeThreshold', protect, allowRoles('owner'), async (req, res) => {
  const { value } = req.body;
  if (value === undefined || value < 0) return res.status(400).json({ error: 'Value must be >= 0' });
  await Settings.findOneAndUpdate(
    { key: 'withdrawalFeeThreshold' },
    { key: 'withdrawalFeeThreshold', value },
    { upsert: true, new: true }
  );
  res.json({ success: true, value });
});

// ========== Generic setting getter (fallback – keep LAST) ==========
// Only public settings are exposed. Anything else returns 403 to prevent
// leaking internal config to any logged-in or anonymous user.
const PUBLIC_SETTINGS = new Set([
  'global_commission',
  'deposit_percentage',
  'agent-delivery-fee',
  'station-pickup-fee',
  'cash-enabled',
  'cash-max-per-order',
  'cash-max-per-agent-per-day',
  'shipping-rates',
  'stripe-publishable-key',
  'withdrawalFeeFlat',
  'withdrawalFeePercentage',
  'withdrawalFeeThreshold',
  'sponsorship-fee',
  'kyc-order-threshold',
  'kyc-required-for-delivery'
]);

router.get('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    if (!PUBLIC_SETTINGS.has(key)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    const value = await getSetting(key);
    res.json({ key, value: value || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



module.exports = router;