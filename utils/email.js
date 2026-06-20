// utils/email.js
const SibApiV3Sdk = require('sib-api-v3-sdk');

const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const transactionalEmailsApi = new SibApiV3Sdk.TransactionalEmailsApi();
const FROM_EMAIL = process.env.BREVO_FROM_EMAIL;

async function sendEmail({ to, subject, html }) {
  const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
  sendSmtpEmail.to = [{ email: to }];
  sendSmtpEmail.sender = { email: FROM_EMAIL };
  sendSmtpEmail.subject = subject;
  sendSmtpEmail.htmlContent = html;
  return await transactionalEmailsApi.sendTransacEmail(sendSmtpEmail);
}

module.exports = { sendEmail };