'use strict';
const { getActiveCampaigns, getTodayContributions, getContributionsForCampaign } = require('./sheets');
const { broadcastDailyReport } = require('./whatsapp');
const { logger } = require('../utils/logger');

/**
 * Build the WhatsApp message text for a campaign's daily report.
 */
function buildReportText(campaign, todayContribs, date) {
  const dateStr = new Date(date).toLocaleDateString('en-KE', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
  });

  const remaining = Math.max(0, campaign.goal - campaign.collected);
  const percent   = Math.round((campaign.collected / campaign.goal) * 100);

  const contribLines = todayContribs.length > 0
    ? todayContribs.map(c => `  • ${c.memberName.padEnd(18)} KES ${c.amount.toLocaleString()}`).join('\n')
    : '  (No contributions recorded today)';

  return [
    '━━━━━━━━━━━━━━━━━━━━━━━',
    `📢 ${campaign.title.toUpperCase()}`,
    `📅 Date: ${dateStr}`,
    '━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    `🎯 Goal:       KES ${campaign.goal.toLocaleString()}`,
    `✅ Collected:  KES ${campaign.collected.toLocaleString()} (${percent}%)`,
    `⏳ Remaining:  KES ${remaining.toLocaleString()}`,
    '',
    `Today's contributors:`,
    contribLines,
    '',
    '🙏 Thank you all for your generosity.',
    '',
    `To contribute:`,
    `  Till No. / Paybill: ${campaign.tills.join(' or ')}`,
    `  Reference: ${campaign.id.toUpperCase()}`,
    '',
    'Reply STOP to opt out of updates.',
    '━━━━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');
}

/**
 * Run the daily report cycle for all active campaigns.
 * Called by the scheduler at the configured cron time.
 */
async function runDailyReports() {
  logger.info('Starting daily report generation...');
  const campaigns = await getActiveCampaigns();

  if (campaigns.length === 0) {
    logger.info('No active campaigns — skipping report.');
    return;
  }

  const today = new Date().toISOString();
  const results = [];

  for (const campaign of campaigns) {
    try {
      const todayContribs = await getTodayContributions(campaign.id);
      const reportText = buildReportText(campaign, todayContribs, today);
      const sendResults = await broadcastDailyReport(reportText);
      results.push({ campaignId: campaign.id, sent: sendResults });
      logger.info(`Daily report dispatched for campaign: ${campaign.title}`);
    } catch (err) {
      logger.error(`Failed to send daily report for ${campaign.id}: ${err.message}`);
    }
  }
  return results;
}

/**
 * Generate a preview report for the admin dashboard (not sent).
 */
async function previewReport(campaignId) {
  const { getAllCampaigns } = require('./sheets');
  const campaigns = await getAllCampaigns();
  const campaign  = campaigns.find(c => c.id === campaignId);
  if (!campaign) throw new Error('Campaign not found');
  const todayContribs = await getTodayContributions(campaign.id);
  return buildReportText(campaign, todayContribs, new Date().toISOString());
}

module.exports = { runDailyReports, previewReport, buildReportText };
