// utils/referral.js
const User = require('../models/User');
const WalletService = require('../services/walletService');
const { createNotification } = require('./notifications');
const Settings = require('../models/Settings');
const { calculatePlatformCommission } = require('./commission');
const Order = require('../models/Order');

async function processReferralReward(order) {
  // Fast path
  if (order.referralRewarded) return;

  // Read-only checks first
  const customer = await User.findById(order.customerId);
  if (!customer || !customer.referredBy) return;

  const referrer = await User.findById(customer.referredBy);
  if (!referrer) return;

  let minSpend = 3000;
  try {
    const setting = await Settings.findOne({ key: 'minReferralOrder' });
    if (setting) minSpend = setting.value;
  } catch (e) {}
  if (order.totalKES < minSpend) {
    console.log(`ℹ️ Order #${order.orderId} below min spend. No reward.`);
    return;
  }

  let platformCommission = 0;
  try {
    platformCommission = await calculatePlatformCommission(order);
  } catch (err) {
    console.error('❌ Failed to calculate commission:', err.message);
    return;
  }
  if (platformCommission <= 0) return;

  let referralPercentage = 15;
  try {
    const setting = await Settings.findOne({ key: 'referralPercentage' });
    if (setting) referralPercentage = setting.value;
  } catch (e) {}

  const reward = Math.floor(platformCommission * (referralPercentage / 100));
  if (reward <= 0) return;

  // ATOMIC CLAIM — only the first caller proceeds to credit.
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, referralRewarded: false },
    { $set: { referralRewarded: true } },
    { new: true }
  );
  if (!claimed) return;

  // Credit — guaranteed once thanks to the claim + deterministic idempotency key
  await WalletService.credit(
    referrer._id,
    reward,
    `Referral bonus (${referralPercentage}% of commission): ${customer.fullName} placed order #${order.orderId}`,
    order._id,
    'referral'
  );

  await createNotification(
    referrer._id,
    'system',
    '🎉 Referral Reward!',
    `You earned KES ${reward} because ${customer.fullName} placed an order using your referral link.`,
    '/account.html'
  );

  console.log(`✅ Referral reward processed: KES ${reward} to ${referrer.email} for order #${order.orderId}`);
}

module.exports = { processReferralReward };