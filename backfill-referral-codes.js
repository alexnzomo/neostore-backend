// backfill-referral-codes.js
const mongoose = require('mongoose');
const crypto = require('crypto');

// ✅ Use the exact URI you know works
const MONGO_URI = "mongodb+srv://alexnzomo5_db_user:YLNjpPBz63Haj0rF@neostore-cluster.i77bgba.mongodb.net/neostore?retryWrites=true&w=majority";

function generateCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function backfill() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected');

    const User = require('./models/User');
    const users = await User.find({ referralCode: { $exists: false } });
    console.log(`Found ${users.length} users without referral codes`);

    let updatedCount = 0;
    for (const user of users) {
      let code;
      let isUnique = false;
      let attempts = 0;
      while (!isUnique && attempts < 10) {
        code = generateCode();
        const existing = await User.findOne({ referralCode: code });
        if (!existing) isUnique = true;
        attempts++;
      }
      if (!isUnique) {
        console.error(`❌ Could not generate unique code for ${user.email}`);
        continue;
      }
      user.referralCode = code;
      await user.save();
      updatedCount++;
      console.log(`✅ ${code} → ${user.email}`);
    }

    console.log(`🎉 Done! Updated ${updatedCount} users.`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

backfill();