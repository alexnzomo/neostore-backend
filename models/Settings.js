// models/Settings.js (add this if not present)
const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: Number, required: true }
});

// Pre-populate default values if needed
settingsSchema.statics.getDefault = async function(key, defaultValue) {
  let setting = await this.findOne({ key });
  if (!setting) {
    setting = new this({ key, value: defaultValue });
    await setting.save();
  }
  return setting.value;
};

module.exports = mongoose.model('Settings', settingsSchema);