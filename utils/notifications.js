const Notification = require('../models/Notification');

async function createNotification(userId, type, title, message, link = null) {
  const notif = new Notification({
    userId,
    type,
    title,
    message,
    link,
    isRead: false,
    createdAt: new Date()
  });
  await notif.save();
  return notif;
}

module.exports = { createNotification };