const KYC = require('../models/KYC');

exports.requireKYC = async (req, res, next) => {
  try {
    const kyc = await KYC.findOne({ userId: req.user._id });
    if (!kyc || kyc.status !== 'verified') {
      return res.status(403).json({ error: 'KYC verification required to perform this action' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};