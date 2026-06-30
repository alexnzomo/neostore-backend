// test-webhook.js
// Run with: node test-webhook.js
const axios = require('axios');

const webhookUrl = 'https://neostore-backend.onrender.com/api/stripe/webhook';

// Sample minimal event payload (does not need to be valid for connectivity test)
const samplePayload = {
  id: 'USR1001',
  type: 'payment_intent.succeeded',
  data: { object: { id: 'pi_test', metadata: { userId: 'dummy', amount: '100' } } }
};

async function testWebhookConnectivity() {
  try {
    console.log(`🔍 Sending test POST to ${webhookUrl} ...`);
    const response = await axios.post(webhookUrl, samplePayload, {
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': 'dummy_signature' // just to pass the header check
      },
      timeout: 5000
    });
    console.log(`✅ Response status: ${response.status}`);
    console.log(`📦 Response data:`, response.data);
  } catch (err) {
    if (err.response) {
      console.log(`❌ Server responded with status: ${err.response.status}`);
      console.log(`📦 Error data:`, err.response.data);
    } else if (err.request) {
      console.log(`❌ No response received – the endpoint is unreachable.`);
      console.log(`   Error: ${err.message}`);
    } else {
      console.log(`❌ Request error: ${err.message}`);
    }
  }
}

testWebhookConnectivity();