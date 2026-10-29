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

  // Atomic claim: only the first caller gets the doc.
  const claimed = await Order.findOneAndUpdate(
    {
      _id: orderId,
      deliveryStatus: { $nin: ['cancelled', 'delivered', 'shipped'] }
    },
    {
      $set: {
        deliveryStatus: 'cancelled',
        cancellationReason: reason,
        cancelledBy: userId || order.customerId,
        updatedAt: Date.now()
      }
    },
    { new: true }
  );

  if (!claimed) {
    if (order.deliveryStatus === 'cancelled') throw new Error('Order already cancelled');
    if (['delivered', 'shipped'].includes(order.deliveryStatus)) {
      throw new Error('Cannot cancel order that is already shipped or delivered');
    }
    throw new Error('Could not cancel order');
  }

  // Restock — reached only by the winner
  for (const item of claimed.items) {
    await Product.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity } });
  }

  await processRefund(claimed);

  // Set payment status based on what was actually collected.
  // Never-paid orders keep their existing status; paid ones become refunded.
  const refundable = (claimed.depositPaid || 0) + (claimed.cashCollected || 0);
  const newPaymentStatus = refundable > 0 ? 'refunded' : claimed.paymentStatus;
  await Order.updateOne(
    { _id: claimed._id },
    { $set: { paymentStatus: newPaymentStatus, updatedAt: Date.now() } }
  );
  claimed.paymentStatus = newPaymentStatus;

  await Settlement.deleteMany({ orderId: claimed._id });

  return claimed;
}

/**
 * Process refund based on payment method (Stripe, wallet, M‑Pesa, cash).
 */
async function processRefund(order) {
  if (order.paymentStatus === 'refunded') return;

  // Refund only what was actually collected.
  const refundableAmount = (order.depositPaid || 0) + (order.cashCollected || 0);
  if (refundableAmount <= 0) {
    return; // Nothing was paid — nothing to refund.
  }

  // 1. Wallet — credit the exact collected amount
  if (['wallet', 'wallet_deposit'].includes(order.paymentMethod)) {
    await WalletService.credit(
      order.customerId,
      refundableAmount,
      `Refund for cancelled order #${order.orderId}`,
      order._id,
      'refund'
    );
    return;
  }

  // 2. Stripe card — refund the exact collected amount
  if (['card', 'card_deposit'].includes(order.paymentMethod)) {
    if (order.stripePaymentIntentId) {
      try {
        const refund = await stripe.refunds.create({
          payment_intent: order.stripePaymentIntentId,
          amount: Math.round(refundableAmount),
        });
        if (refund.status !== 'succeeded') {
          console.warn(`Stripe refund for order ${order.orderId} returned status: ${refund.status}`);
        }
      } catch (err) {
        console.error(`Stripe refund failed for order ${order.orderId}:`, err.message);

        // Notify admins/owners so they can process the refund manually in Stripe dashboard
        try {
          const User = require('../models/User');
          const { createNotification } = require('./notifications');
          const adminsAndOwners = await User.find({ role: { $in: ['admin', 'owner'] } });
          const amountDisplay = Math.round(refundableAmount).toLocaleString();

          for (const recipient of adminsAndOwners) {
            await createNotification(
              recipient._id,
              'system',
              '⚠️ Stripe Refund Failed',
              `Order #${order.orderId} refund of KES ${amountDisplay} failed: ${err.message}. ` +
              `Please issue a manual refund in the Stripe dashboard (PaymentIntent: ${order.stripePaymentIntentId}).`,
              '/admin.html?tab=orders'
            );
          }
        } catch (notifyErr) {
          console.error('Admin notification for failed Stripe refund also failed:', notifyErr.message);
        }
      }
    }
    return;
  }

  // 3. M-Pesa — notify admins for manual reversal
  if (['mpesa', 'mpesa_deposit'].includes(order.paymentMethod)) {
    console.log(`M-Pesa refund for order ${order.orderId} (TXN: ${order.mpesaTransactionId}) requires manual processing.`);

    const User = require('../models/User');
    const { createNotification } = require('./notifications');

    const admins = await User.find({ role: { $in: ['admin', 'owner'] } });
    for (const admin of admins) {
      await createNotification(
        admin._id,
        'system',
        '⚠️ M‑Pesa Refund Required',
        `Order #${order.orderId} (TXN: ${order.mpesaTransactionId}) needs manual reversal in the M‑Pesa portal. Refund amount: KES ${refundableAmount.toFixed(0)}.`,
        '/admin.html?tab=orders'
      );
    }
    return;
  }

  // 4. Cash — admin handles manually, no online refund.
}

module.exports = { cancelOrder, processRefund };