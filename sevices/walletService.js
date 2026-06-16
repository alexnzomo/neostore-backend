const mongoose = require('mongoose');
const User = require('../models/User');
const WalletTransaction = require('../models/WalletTransaction');
const crypto = require('crypto');

class WalletService {
  static generateIdempotencyKey() {
    return crypto.randomBytes(16).toString('hex');
  }

  static async getBalance(userId, session = null) {
    const user = await User.findById(userId).select('walletBalance').session(session);
    return user ? user.walletBalance : 0;
  }

  static async credit(userId, amount, description, referenceId = null, referenceType = null, metadata = {}) {
    if (amount <= 0) throw new Error('Amount must be positive');
    const idempotencyKey = this.generateIdempotencyKey();
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const user = await User.findById(userId).session(session);
      if (!user) throw new Error('User not found');
      const oldBalance = user.walletBalance;
      const newBalance = oldBalance + amount;
      user.walletBalance = newBalance;
      await user.save({ session });

      const transaction = new WalletTransaction({
        idempotencyKey,
        userId,
        type: 'credit',
        amount,
        balanceAfter: newBalance,
        description,
        referenceId,
        referenceType,
        metadata: { ...metadata, oldBalance },
        status: 'completed',
        completedAt: new Date()
      });
      await transaction.save({ session });

      await session.commitTransaction();
      session.endSession();
      return { success: true, newBalance, transaction };
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }

  static async debit(userId, amount, description, referenceId = null, referenceType = null, metadata = {}) {
    if (amount <= 0) throw new Error('Amount must be positive');
    const idempotencyKey = this.generateIdempotencyKey();
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const user = await User.findById(userId).session(session);
      if (!user) throw new Error('User not found');
      if (user.walletBalance < amount) throw new Error('Insufficient balance');
      const oldBalance = user.walletBalance;
      const newBalance = oldBalance - amount;
      user.walletBalance = newBalance;
      await user.save({ session });

      const transaction = new WalletTransaction({
        idempotencyKey,
        userId,
        type: 'debit',
        amount,
        balanceAfter: newBalance,
        description,
        referenceId,
        referenceType,
        metadata: { ...metadata, oldBalance },
        status: 'completed',
        completedAt: new Date()
      });
      await transaction.save({ session });

      await session.commitTransaction();
      session.endSession();
      return { success: true, newBalance, transaction };
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }

  static async transfer(senderId, receiverId, amount, description, metadata = {}) {
    if (amount <= 0) throw new Error('Amount must be positive');
    if (senderId.toString() === receiverId.toString()) throw new Error('Cannot transfer to yourself');
    const idempotencyKey = this.generateIdempotencyKey();
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const sender = await User.findById(senderId).session(session);
      const receiver = await User.findById(receiverId).session(session);
      if (!sender) throw new Error('Sender not found');
      if (!receiver) throw new Error('Receiver not found');
      if (sender.walletBalance < amount) throw new Error('Insufficient balance');

      const senderOldBalance = sender.walletBalance;
      const receiverOldBalance = receiver.walletBalance;
      sender.walletBalance -= amount;
      receiver.walletBalance += amount;
      await sender.save({ session });
      await receiver.save({ session });

      const debitTx = new WalletTransaction({
        idempotencyKey: `${idempotencyKey}-debit`,
        userId: senderId,
        type: 'transfer_out',
        amount,
        balanceAfter: sender.walletBalance,
        description: `Transfer to ${receiver.fullName || receiver.email}`,
        referenceId: receiverId,
        referenceType: 'transfer',
        metadata: { ...metadata, senderOldBalance, receiverId },
        status: 'completed',
        completedAt: new Date()
      });
      await debitTx.save({ session });

      const creditTx = new WalletTransaction({
        idempotencyKey: `${idempotencyKey}-credit`,
        userId: receiverId,
        type: 'transfer_in',
        amount,
        balanceAfter: receiver.walletBalance,
        description: `Transfer from ${sender.fullName || sender.email}`,
        referenceId: senderId,
        referenceType: 'transfer',
        metadata: { ...metadata, receiverOldBalance, senderId },
        status: 'completed',
        completedAt: new Date()
      });
      await creditTx.save({ session });

      debitTx.pairTransactionId = creditTx._id;
      creditTx.pairTransactionId = debitTx._id;
      await debitTx.save({ session });
      await creditTx.save({ session });

      await session.commitTransaction();
      session.endSession();
      return {
        success: true,
        senderBalance: sender.walletBalance,
        receiverBalance: receiver.walletBalance,
        debitTransaction: debitTx,
        creditTransaction: creditTx
      };
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }

  static async getTransactionHistory(userId, limit = 50, skip = 0) {
    const transactions = await WalletTransaction.find({ userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);
    const total = await WalletTransaction.countDocuments({ userId });
    return { transactions, total, limit, skip };
  }

  static async getTransactionByIdempotencyKey(idempotencyKey) {
    return await WalletTransaction.findOne({ idempotencyKey });
  }

  static async reverseTransaction(transactionId, reason) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const originalTx = await WalletTransaction.findById(transactionId).session(session);
      if (!originalTx) throw new Error('Transaction not found');
      if (originalTx.status === 'reversed') throw new Error('Transaction already reversed');

      const amount = originalTx.amount;
      const user = await User.findById(originalTx.userId).session(session);
      if (!user) throw new Error('User not found');

      let newBalance;
      if (originalTx.type === 'debit' || originalTx.type === 'transfer_out') {
        newBalance = user.walletBalance + amount;
      } else if (originalTx.type === 'credit' || originalTx.type === 'transfer_in') {
        if (user.walletBalance < amount) throw new Error('Insufficient balance to reverse');
        newBalance = user.walletBalance - amount;
      } else {
        throw new Error('Cannot reverse this transaction type');
      }

      user.walletBalance = newBalance;
      await user.save({ session });

      const reversalTx = new WalletTransaction({
        idempotencyKey: this.generateIdempotencyKey(),
        userId: originalTx.userId,
        type: 'refund',
        amount,
        balanceAfter: newBalance,
        description: `Reversal: ${reason || originalTx.description}`,
        referenceId: originalTx._id,
        referenceType: 'refund',
        metadata: { originalTransaction: originalTx._id },
        status: 'completed',
        completedAt: new Date()
      });
      await reversalTx.save({ session });

      originalTx.status = 'reversed';
      await originalTx.save({ session });

      await session.commitTransaction();
      session.endSession();
      return { success: true, newBalance, reversalTransaction: reversalTx };
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }
}

module.exports = WalletService;