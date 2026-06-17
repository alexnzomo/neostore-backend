const Order = require('../models/Order');
const Product = require('../models/Product');
const Settlement = require('../models/Settlement');
const WalletService = require('../services/walletService');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/**
 * Cancel an order, restock items, process refunds, and remove settlement.
 * @param {string} orderId - Order ID
 * @param {string} reason - Cancellation reason
 * @param {string} userId - User ID of who cancelled (customer or admin)
 * @returns {Promise<Object>} Cancelled order
 */
async function cancelOrder(orderId, reason = 'Order cancelled', userId = null) {
  const order = await Order.findById(orderId);
  if (!order) throw new Error('Order not found');
  if (order.deliveryStatus === 'cancelled') throw new Error('Order already cancelled');
  if (['delivered', 'shipped'].includes(order.deliveryStatus)) {
    throw new Error('Cannot cancel order that is already shipped or delivered');
  }

  // Restock items
  for (const item of order.items) {
    await Product.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity } });
  }

  // Process refund
  await processRefund(order);

  // Update order
  order.deliveryStatus = 'cancelled';
  order.paymentStatus = 'refunded';
  order.cancellationReason = reason;
  order.cancelledBy = userId || order.customerId;
  order.updatedAt = Date.now();
  await order.save();

  // Remove settlement
  await Settlement.deleteMany({ orderId: order._id });

  return order;
}

/**
 * Process refund based on payment method (Stripe, wallet, M‑Pesa, cash).
 */
async function processRefund(order) {
  if (order.paymentStatus === 'refunded') return;

  // 1. Wallet payment – credit customer's wallet
  if (order.paymentMethod === 'wallet') {
    await WalletService.credit(
      order.customerId,
      order.totalKES,
      `Refund for cancelled order #${order.orderId}`,
      order._id,
      'refund'
    );
    return;
  }

  // 2. Stripe card payment
  if (['card', 'card_deposit'].includes(order.paymentMethod)) {
    if (order.stripePaymentIntentId) {
      try {
        const refund = await stripe.refunds.create({
          payment_intent: order.stripePaymentIntentId,
          amount: Math.round(order.totalKES),
        });
        if (refund.status !== 'succeeded') {
          console.warn(`Stripe refund for order ${order.orderId} returned status: ${refund.status}`);
        }
      } catch (err) {
        console.error(`Stripe refund failed for order ${order.orderId}:`, err.message);
        // Continue – admin can manually refund.
      }
    }
  }

  // 3. M‑Pesa – log and skip (manual reversal required)
  if (['mpesa', 'mpesa_deposit'].includes(order.paymentMethod)) {
    console.log(`M-Pesa refund for order ${order.orderId} (TXN: ${order.mpesaTransactionId}) – manual processing required.`);
    // You can integrate M‑Pesa reversal API here.
  }

  // 4. Cash – no online refund; admin handles manually.
}

module.exports = { cancelOrder, processRefund };