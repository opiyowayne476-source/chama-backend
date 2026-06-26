'use strict';
const cron = require('node-cron');
const { runDailyReports } = require('./reportGenerator');
const { logger } = require('../utils/logger');

let schedulerStarted = false;

function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  // Default: 8pm EAT (UTC+3) = 17:00 UTC → "0 17 * * *"
  const cronExpr = process.env.REPORT_CRON || '0 17 * * *';

  if (!cron.validate(cronExpr)) {
    logger.error(`Invalid REPORT_CRON expression: "${cronExpr}" — scheduler not started.`);
    return;
  }

  cron.schedule(cronExpr, async () => {
    logger.info(`Scheduler fired [${cronExpr}]: running daily reports`);
    try {
      await runDailyReports();
    } catch (err) {
      logger.error(`Scheduler error: ${err.message}`);
    }
  }, { timezone: 'Africa/Nairobi' });

  logger.info(`Daily report scheduler started: "${cronExpr}" (Africa/Nairobi)`);
}

module.exports = { startScheduler };
