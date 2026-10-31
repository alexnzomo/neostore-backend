// routes/documents.js
// Secure proxy for KYC and application identity documents.
// Prevents exposure of Cloudinary URLs by requiring admin auth + audit logging.

const express = require('express');
const KYC = require('../models/KYC');
const Application = require('../models/Application');
const PickupApplication = require('../models/PickupApplication');
const { protect } = require('../middleware/auth');
const { allowRoles } = require('../middleware/roleCheck');
const { logAction } = require('../utils/audit');

const router = express.Router();

// Allowed document fields per source type
const ALLOWED_FIELDS = {
  kyc: ['idPhotoUrl', 'selfiePhotoUrl', 'proofOfAddressUrl'],
  application: ['idImageUrl', 'proofOfAddress'],
  pickup_application: ['idImageUrl', 'proofOfAddress', 'proofOfStationAddress']
};

// GET /api/documents/kyc/:id/:field — proxy KYC document
router.get(
  '/kyc/:id/:field',
  protect,
  allowRoles('admin', 'owner'),
  async (req, res) => {
    try {
      const { id, field } = req.params;
      if (!ALLOWED_FIELDS.kyc.includes(field)) {
        return res.status(400).json({ error: 'Invalid document field' });
      }

      const kyc = await KYC.findById(id);
      if (!kyc) return res.status(404).json({ error: 'KYC record not found' });

      const url = kyc[field];
      if (!url) return res.status(404).json({ error: 'Document not found' });

      // Audit log
      await logAction(req, 'view_kyc_document', kyc.userId, {
        kycId: kyc._id,
        field
      });

      // Fetch and stream from Cloudinary
      const response = await fetch(url);
      if (!response.ok) {
        return res.status(502).json({ error: 'Failed to fetch document from storage' });
      }

      const contentType = response.headers.get('content-type') || 'image/jpeg';
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'private, no-store, max-age=0');
      res.set('X-Content-Type-Options', 'nosniff');

      const buffer = Buffer.from(await response.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      console.error('KYC document proxy error:', err);
      res.status(500).json({ error: 'Failed to retrieve document' });
    }
  }
);

// GET /api/documents/application/:id/:field — proxy vendor/agent application document
router.get(
  '/application/:id/:field',
  protect,
  allowRoles('admin', 'owner'),
  async (req, res) => {
    try {
      const { id, field } = req.params;
      if (!ALLOWED_FIELDS.application.includes(field)) {
        return res.status(400).json({ error: 'Invalid document field' });
      }

      const application = await Application.findById(id);
      if (!application) return res.status(404).json({ error: 'Application not found' });

      const url = application[field];
      if (!url) return res.status(404).json({ error: 'Document not found' });

      await logAction(req, 'view_application_document', application.userId, {
        applicationId: application._id,
        field
      });

      const response = await fetch(url);
      if (!response.ok) {
        return res.status(502).json({ error: 'Failed to fetch document from storage' });
      }

      const contentType = response.headers.get('content-type') || 'image/jpeg';
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'private, no-store, max-age=0');
      res.set('X-Content-Type-Options', 'nosniff');

      const buffer = Buffer.from(await response.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      console.error('Application document proxy error:', err);
      res.status(500).json({ error: 'Failed to retrieve document' });
    }
  }
);

// GET /api/documents/pickup_application/:id/:field — proxy pickup station application document
router.get(
  '/pickup_application/:id/:field',
  protect,
  allowRoles('admin', 'owner'),
  async (req, res) => {
    try {
      const { id, field } = req.params;
      if (!ALLOWED_FIELDS.pickup_application.includes(field)) {
        return res.status(400).json({ error: 'Invalid document field' });
      }

      const app = await PickupApplication.findById(id);
      if (!app) return res.status(404).json({ error: 'Pickup application not found' });

      const url = app[field];
      if (!url) return res.status(404).json({ error: 'Document not found' });

      await logAction(req, 'view_pickup_application_document', app.userId, {
        applicationId: app._id,
        field
      });

      const response = await fetch(url);
      if (!response.ok) {
        return res.status(502).json({ error: 'Failed to fetch document from storage' });
      }

      const contentType = response.headers.get('content-type') || 'image/jpeg';
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'private, no-store, max-age=0');
      res.set('X-Content-Type-Options', 'nosniff');

      const buffer = Buffer.from(await response.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      console.error('Pickup application document proxy error:', err);
      res.status(500).json({ error: 'Failed to retrieve document' });
    }
  }
);

module.exports = router;