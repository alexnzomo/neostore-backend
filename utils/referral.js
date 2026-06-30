// utils/referral.js
const User = require('../models/User');
const WalletService = require('../services/walletService');
const { createNotification } = require('./notifications');
const Settings = require('../models/Settings');
const { calculatePlatformCommission } = require('./commission');

async function processReferralReward(order) {
  // 1. Prevent double‑credit
  if (order.referralRewarded) return;

  // 2. Check if customer was referred
  const customer = await User.findById(order.customerId);
  if (!customer || !customer.referredBy) return;

  const referrer = await User.findById(customer.referredBy);
  if (!referrer) return;

  // 3. Minimum spend check
  let minSpend = 3000; // default
  try {
    const setting = await Settings.findOne({ key: 'minReferralOrder' });
    if (setting) minSpend = setting.value;
  } catch (e) {}

  if (order.totalKES < minSpend) {
    console.log(`ℹ️ Order #${order.orderId} total (KES ${order.totalKES}) below min spend (KES ${minSpend}). No referral reward.`);
    return;
  }

  // 4. Calculate platform commission
  let platformCommission = 0;
  try {
    platformCommission = await calculatePlatformCommission(order);
  } catch (err) {
    console.error('❌ Failed to calculate platform commission:', err.message);
    return;
  }

  if (platformCommission <= 0) {
    console.log(`ℹ️ Platform commission for order #${order.orderId} is 0. No reward.`);
    return;
  }

  // 5. Get referral percentage
  let referralPercentage = 15; // default 15%
  try {
    const setting = await Settings.findOne({ key: 'referralPercentage' });
    if (setting) referralPercentage = setting.value;
  } catch (e) {}

  // 6. Calculate reward (rounded down to whole KES)
  const reward = Math.floor(platformCommission * (referralPercentage / 100));
  if (reward <= 0) {
    console.log(`ℹ️ Calculated reward is 0 KES. No credit.`);
    return;
  }

  // 7. Credit referrer
  const result = await WalletService.credit(
    referrer._id,
    reward,
    `Referral bonus (${referralPercentage}% of commission): ${customer.fullName} placed order #${order.orderId}`,
    order._id,
    'refund'
  );

  // 8. Send notification
  await createNotification(
    referrer._id,
    'system',
    '🎉 Referral Reward!',
    `You earned KES ${reward} because ${customer.fullName} placed an order using your referral link. (${referralPercentage}% of platform commission)`,
    '/account.html'
  );

  // 9. Mark order as rewarded
  order.referralRewarded = true;
  await order.save();

  console.log(`✅ Referral reward processed: KES ${reward} to ${referrer.email} for order #${order.orderId}`);
}

module.exports = { processReferralReward };