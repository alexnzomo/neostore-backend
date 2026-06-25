// backfill.mongodb.js
const crypto = require('crypto');

function generateCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

const users = db.users.find({ referralCode: { $exists: false } });
let count = 0;
while (users.hasNext()) {
  let user = users.next();
  let code;
  let isUnique = false;
  let attempts = 0;
  while (!isUnique && attempts < 10) {
    code = generateCode();
    const existing = db.users.findOne({ referralCode: code });
    if (!existing) isUnique = true;
    attempts++;
  }
  if (!isUnique) {
    print('❌ Could not generate unique code for ' + user.email);
    continue;
  }
  db.users.updateOne(
    { _id: user._id },
    { $set: { referralCode: code } }
  );
  print('✅ Assigned ' + code + ' to ' + user.email);
  count++;
}
print('🎉 Done! Updated ' + count + ' users.');