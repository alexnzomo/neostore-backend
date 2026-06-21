const fs = require('fs');
const path = require('path');

// =====================================================
// STEP 1: Get your JWT token
// Open your browser, go to the website, open DevTools (F12),
// paste this in the console:
//
//   localStorage.getItem('auth_token')
//
// Copy the token string and paste it below.
// =====================================================
const JWT_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhMmYwODk3OTZkNGY2MjYxNjNhYTY5MCIsInJvbGUiOiJvd25lciIsImlhdCI6MTc4MTczNTE2NSwiZXhwIjoxNzgyMzM5OTY1fQ.rayrhFRsQPjigLY-UvZZV5NcmYii_0vdgBkg-RvZRY4"; // <-- CHANGE THIS

// =====================================================
// STEP 2: Create a small test image if it doesn't exist
// =====================================================
const testImagePath = './test-image.png';
if (!fs.existsSync(testImagePath)) {
  console.log('📸 Creating test image (1x1 pixel PNG)...');
  const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.writeFileSync(testImagePath, pixel);
}

// =====================================================
// STEP 3: Upload to Render
// =====================================================
async function testRenderUpload() {
  console.log('🚀 Testing upload to Render...');
  console.log(`   Endpoint: https://neostore-backend.onrender.com/api/upload`);
  console.log(`   File: ${testImagePath}`);
  console.log('');

  const formData = new FormData();
  const fileBuffer = fs.readFileSync(testImagePath);
  const blob = new Blob([fileBuffer], { type: 'image/png' });
  formData.append('image', blob, 'test-image.png');

  try {
    const response = await fetch('https://neostore-backend.onrender.com/api/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${JWT_TOKEN}`
      },
      body: formData
    });

    const text = await response.text();
    console.log(`📡 Status: ${response.status} ${response.statusText}`);
    console.log(`📦 Response body: ${text}`);

    if (response.ok) {
      try {
        const json = JSON.parse(text);
        console.log('✅ Upload successful!');
        console.log('   Image URL:', json.imageUrl);
      } catch (e) {
        console.log('   Response is not JSON (but status was OK)');
      }
    } else {
      console.error('❌ Upload failed with status', response.status);
      console.error('   Response:', text);
    }
  } catch (err) {
    console.error('❌ Network error:', err.message);
  }
}

testRenderUpload();