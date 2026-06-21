const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');
const https = require('https');

// ========== CONFIGURATION ==========
// Option 1: Hardcode your credentials (for testing only)
const CLOUD_NAME = 'dxjqklb2j';        // <-- CHANGE THIS
const API_KEY = '969257685148667';              // <-- CHANGE THIS
const API_SECRET = 'EflWLi_2EFQ7I3bE31wEprLea9k';        // <-- CHANGE THIS

// Option 2: Or use environment variables
// const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
// const API_KEY = process.env.CLOUDINARY_API_KEY;
// const API_SECRET = process.env.CLOUDINARY_API_SECRET;

// ========== CONFIGURE CLOUDINARY ==========
cloudinary.config({
  cloud_name: CLOUD_NAME,
  api_key: API_KEY,
  api_secret: API_SECRET
});

console.log('🔧 Testing Cloudinary with:');
console.log(`   Cloud Name: ${CLOUD_NAME}`);
console.log(`   API Key:    ${API_KEY ? '✅ Set' : '❌ Missing'}`);
console.log(`   API Secret: ${API_SECRET ? '✅ Set' : '❌ Missing'}`);
console.log('');

// ========== TEST 1: Ping Cloudinary ==========
async function testPing() {
  console.log('📡 Test 1: Pinging Cloudinary...');
  try {
    const result = await cloudinary.api.ping();
    console.log('✅ Cloudinary is reachable!');
    console.log('   Response:', result);
    return true;
  } catch (err) {
    console.error('❌ Cloudinary ping failed!');
    console.error('   Error:', err.message);
    console.error('   Stack:', err.stack);
    return false;
  }
}

// ========== TEST 2: Upload a File ==========
async function testUpload() {
  console.log('');
  console.log('📸 Test 2: Uploading a test file...');
  
  // Create a small test image (1x1 pixel PNG) if no file provided
  const testImagePath = './test-image.png';
  
  // Check if a test image exists, or create one
  let imageBuffer = null;
  try {
    imageBuffer = fs.readFileSync(testImagePath);
  } catch (e) {
    console.log('   No test image found. Creating a 1x1 pixel PNG...');
    // 1x1 transparent pixel PNG (base64)
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(testImagePath, pixel);
    imageBuffer = pixel;
  }

  try {
    const result = await cloudinary.uploader.upload(testImagePath, {
      folder: 'test-uploads',
      public_id: `test-${Date.now()}`
    });
    
    console.log('✅ Upload successful!');
    console.log('   URL:', result.secure_url);
    console.log('   Public ID:', result.public_id);
    console.log('   Format:', result.format);
    console.log('   Size:', result.bytes, 'bytes');
    return true;
  } catch (err) {
    console.error('❌ Upload failed!');
    console.error('   Error:', err.message);
    console.error('   Stack:', err.stack);
    return false;
  }
}

// ========== TEST 3: Check Your Render Server ==========
async function testRenderServer() {
  console.log('');
  console.log('🌐 Test 3: Checking your Render server...');
  
  const url = 'https://neostore-backend.onrender.com/api/test-cloudinary';
  
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✅ Render server is reachable!');
          try {
            const json = JSON.parse(data);
            console.log('   Response:', json);
          } catch (e) {
            console.log('   Raw response:', data);
          }
        } else {
          console.log(`❌ Render server returned status ${res.statusCode}`);
          console.log('   Response:', data);
        }
        resolve();
      });
    }).on('error', (err) => {
      console.error('❌ Could not reach Render server:');
      console.error('   Error:', err.message);
      resolve();
    });
  });
}

// ========== RUN ALL TESTS ==========
async function runTests() {
  console.log('========================================');
  console.log('🚀 Cloudinary Connection Test Suite');
  console.log('========================================');
  console.log('');
  
  const pingOk = await testPing();
  if (!pingOk) {
    console.log('');
    console.log('⚠️  Cloudinary ping failed. Check:');
    console.log('   1. Cloud name is correct');
    console.log('   2. API Key and Secret are correct');
    console.log('   3. You have an active internet connection');
    console.log('');
    console.log('💡 If you are using environment variables, make sure they are set.');
    console.log('   Example: export CLOUDINARY_CLOUD_NAME="your_cloud_name"');
  } else {
    await testUpload();
  }
  
  console.log('');
  console.log('========================================');
  console.log('✅ Test suite complete!');
  console.log('========================================');
}

runTests();