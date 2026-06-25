// utils/email.js
const SibApiV3Sdk = require('sib-api-v3-sdk');

const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const transactionalEmailsApi = new SibApiV3Sdk.TransactionalEmailsApi();
const FROM_EMAIL = process.env.BREVO_FROM_EMAIL;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://mwecheche.com';

// ========== Base email sender ==========
async function sendEmail({ to, subject, html }) {
  if (!to) throw new Error('Recipient email is required');
  const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
  sendSmtpEmail.to = [{ email: to }];
  sendSmtpEmail.sender = { email: FROM_EMAIL, name: 'Mwecheche' };
  sendSmtpEmail.subject = subject;
  sendSmtpEmail.htmlContent = html;
  return await transactionalEmailsApi.sendTransacEmail(sendSmtpEmail);
}

// ========== Layout wrapper ==========
function emailLayout(content, title = 'Mwecheche') {
  return `
  <!DOCTYPE html>
  <html>
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
  <body style="font-family: system-ui, -apple-system, sans-serif; background: #fafaf9; margin: 0; padding: 20px;">
    <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
      <div style="background: #1c1c1e; color: white; padding: 24px; text-align: center;">
        <h1 style="margin: 0; font-size: 1.5rem;">🛍️ Mwecheche</h1>
      </div>
      <div style="padding: 32px 24px; color: #1c1c1e; line-height: 1.6;">
        ${content}
      </div>
      <div style="background: #f9f9f8; padding: 16px; text-align: center; color: #666; font-size: 0.75rem; border-top: 1px solid #eee;">
        © ${new Date().getFullYear()} Mwecheche — All rights reserved.<br>
        <a href="${FRONTEND_URL}" style="color: #1c1c1e; text-decoration: none;">${FRONTEND_URL}</a>
      </div>
    </div>
  </body>
  </html>
  `;
}

// ========== 1. Welcome Email ==========
async function sendWelcomeEmail(user) {
  const content = `
    <h2>🎉 Welcome to Mwecheche, ${user.fullName}!</h2>
    <p>Thank you for creating an account. We're thrilled to have you on board.</p>
    <p>You can now:</p>
    <ul>
      <li>🛍️ Browse our curated collection</li>
      <li>❤️ Save items to your wishlist</li>
      <li>💰 Manage your wallet</li>
      <li>📦 Track your orders</li>
    </ul>
    <p style="text-align: center; margin-top: 24px;">
      <a href="${FRONTEND_URL}/account.html" style="background: #1c1c1e; color: white; padding: 10px 24px; border-radius: 40px; text-decoration: none; display: inline-block;">Go to your account →</a>
    </p>
  `;
  return sendEmail({
    to: user.email,
    subject: '🎉 Welcome to Mwecheche!',
    html: emailLayout(content, 'Welcome')
  });
}

// ========== 2. KYC Confirmation (to user) ==========
async function sendKYCConfirmationEmail(user) {
  const content = `
    <h2>📋 KYC Submitted</h2>
    <p>Hi ${user.fullName},</p>
    <p>Your KYC documents have been received and are now under review.</p>
    <p>We'll notify you as soon as your verification is complete.</p>
    <p style="text-align: center; margin-top: 24px;">
      <a href="${FRONTEND_URL}/account.html" style="background: #1c1c1e; color: white; padding: 10px 24px; border-radius: 40px; text-decoration: none; display: inline-block;">Check status →</a>
    </p>
  `;
  return sendEmail({
    to: user.email,
    subject: 'KYC Submitted for Review',
    html: emailLayout(content, 'KYC Submitted')
  });
}

// ========== 3. KYC Admin Notification ==========
async function sendKYCAdminNotificationEmail(user, admins) {
  const content = `
    <h2>🪪 New KYC Submission</h2>
    <p><strong>User:</strong> ${user.fullName} (${user.email})</p>
    <p><strong>Submitted at:</strong> ${new Date().toLocaleString()}</p>
    <p style="text-align: center; margin-top: 24px;">
      <a href="${FRONTEND_URL}/admin.html?tab=kyc" style="background: #1c1c1e; color: white; padding: 10px 24px; border-radius: 40px; text-decoration: none; display: inline-block;">Review KYC →</a>
    </p>
  `;
  const promises = admins.map(admin =>
    sendEmail({
      to: admin.email,
      subject: 'New KYC Submission',
      html: emailLayout(content, 'New KYC')
    })
  );
  return Promise.all(promises);
}

// ========== 4. Order Confirmation ==========
async function sendOrderConfirmationEmail(order) {
  const itemsHtml = order.items.map(i =>
    `<tr><td>${i.name}</td><td>x${i.quantity}</td><td>KES ${(i.priceUSD * 130 * i.quantity).toFixed(0)}</td></tr>`
  ).join('');
  const content = `
    <h2>✅ Order Confirmed</h2>
    <p>Hi ${order.customerName},</p>
    <p>Thank you for your order! We've received it and are processing it.</p>
    <p><strong>Order #${order.orderId}</strong></p>
    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      <thead><tr style="background: #f0f0f0;"><th style="padding: 8px; text-align: left;">Item</th><th style="padding: 8px; text-align: center;">Qty</th><th style="padding: 8px; text-align: right;">Price</th></tr></thead>
      <tbody>${itemsHtml}</tbody>
      <tfoot><tr><td colspan="2" style="padding: 8px; text-align: right; font-weight: 700;">Total</td><td style="padding: 8px; text-align: right; font-weight: 700;">KES ${order.totalKES.toFixed(0)}</td></tr></tfoot>
    </table>
    <p><strong>Payment:</strong> ${order.paymentMethod}</p>
    <p><strong>Status:</strong> ${order.deliveryStatus}</p>
    <p style="text-align: center; margin-top: 24px;">
      <a href="${FRONTEND_URL}/account.html" style="background: #1c1c1e; color: white; padding: 10px 24px; border-radius: 40px; text-decoration: none; display: inline-block;">View order →</a>
    </p>
  `;
  return sendEmail({
    to: order.customerEmail,
    subject: `Order #${order.orderId} Confirmed`,
    html: emailLayout(content, 'Order Confirmed')
  });
}

// ========== 5. Withdrawal Status ==========
async function sendWithdrawalStatusEmail(withdrawal, user, status) {
  const content = `
    <h2>💸 Withdrawal ${status.charAt(0).toUpperCase() + status.slice(1)}</h2>
    <p>Hi ${user.fullName},</p>
    <p>Your withdrawal request of <strong>KES ${withdrawal.amount.toFixed(0)}</strong> has been <strong>${status}</strong>.</p>
    ${status === 'rejected' ? `<p><strong>Reason:</strong> ${withdrawal.adminNote || 'No reason provided'}</p>` : ''}
    ${status === 'completed' ? `<p>Funds have been sent to your ${withdrawal.method} account.</p>` : ''}
    <p style="text-align: center; margin-top: 24px;">
      <a href="${FRONTEND_URL}/account.html" style="background: #1c1c1e; color: white; padding: 10px 24px; border-radius: 40px; text-decoration: none; display: inline-block;">View wallet →</a>
    </p>
  `;
  return sendEmail({
    to: user.email,
    subject: `Withdrawal ${status}`,
    html: emailLayout(content, `Withdrawal ${status}`)
  });
}

// ========== 6. Station Manager Assignment ==========
async function sendStationAssignmentEmail(user, station) {
  const content = `
    <h2>📍 Station Manager Assignment</h2>
    <p>Hi ${user.fullName},</p>
    <p>You have been assigned as the manager of <strong>${station.name}</strong>.</p>
    <p><strong>Address:</strong> ${station.address}, ${station.city}</p>
    <p><strong>Phone:</strong> ${station.phone}</p>
    <p style="text-align: center; margin-top: 24px;">
      <a href="${FRONTEND_URL}/station-manager.html" style="background: #1c1c1e; color: white; padding: 10px 24px; border-radius: 40px; text-decoration: none; display: inline-block;">Go to dashboard →</a>
    </p>
  `;
  return sendEmail({
    to: user.email,
    subject: 'Station Manager Assignment',
    html: emailLayout(content, 'Station Manager')
  });
}

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendKYCConfirmationEmail,
  sendKYCAdminNotificationEmail,
  sendOrderConfirmationEmail,
  sendWithdrawalStatusEmail,
  sendStationAssignmentEmail
};