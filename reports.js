'use strict';
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const { previewReport, runDailyReports } = require('../services/reportGenerator');
const { writeAuditLog } = require('../services/sheets');
const { logger } = require('../utils/logger');

router.use(requireAuth);

// GET /api/reports/preview/:campaignId
router.get('/preview/:campaignId', async (req, res) => {
  const { campaignId } = req.params;
  if (!/^[A-Z0-9]{6,12}$/i.test(campaignId)) {
    return res.status(400).json({ error: 'Invalid campaign ID.' });
  }
  try {
    const text = await previewReport(campaignId);
    res.json({ preview: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reports/send-now  — manually trigger reports
router.post('/send-now', async (req, res) => {
  try {
    const results = await runDailyReports();
    await writeAuditLog({
      adminId: req.admin.id,
      action:  'MANUAL_REPORT_TRIGGER',
      details: { results },
      ip:      req.ip,
    });
    res.json({ message: 'Reports dispatched.', results });
  } catch (err) {
    logger.error(`Manual report trigger error: ${err.message}`);
    res.status(500).json({ error: 'Could not send reports.' });
  }
});

module.exports = router;
