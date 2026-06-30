// utils/commission.js
const Product = require('../models/Product');
const Category = require('../models/Category');
const Settings = require('../models/Settings');

/**
 * Calculate the platform commission (in KES) for a given order.
 * Uses product override, category commission, or global commission.
 * @param {Object} order - The Order document (must have items with productId, priceUSD, quantity)
 * @param {Number} usdToKes - Exchange rate (default 130)
 * @returns {Promise<Number>} Platform commission in KES
 */
async function calculatePlatformCommission(order, usdToKes = 130) {
  let totalCommissionUSD = 0;

  // Fetch global commission as fallback
  let globalCommission = 5; // default
  try {
    const setting = await Settings.findOne({ key: 'global_commission' });
    if (setting) globalCommission = setting.value;
  } catch (e) {}

  // Process each item
  for (const item of order.items) {
    const product = await Product.findById(item.productId);
    if (!product) continue;

    // Determine commission rate
    let rate = globalCommission;
    if (product.commissionOverride !== null && product.commissionOverride !== undefined) {
      rate = product.commissionOverride;
    } else if (product.category) {
      const category = await Category.findOne({ name: product.category });
      if (category) rate = category.commission;
    }

    const itemCommissionUSD = item.priceUSD * item.quantity * (rate / 100);
    totalCommissionUSD += itemCommissionUSD;
  }

  return totalCommissionUSD * usdToKes;
}

module.exports = { calculatePlatformCommission };