'use strict';
const { google } = require('googleapis');
const { logger } = require('../utils/logger');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Sheet tab names — must match your actual Google Sheet tabs
const TABS = {
  MEMBERS:       'Members',
  CAMPAIGNS:     'Campaigns',
  CONTRIBUTIONS: 'Contributions',
  AUDIT:         'AuditLog',
  ADMINS:        'Admins',
  TX_IDS:        'ProcessedTxIDs',   // idempotency store
};

let _sheetsClient = null;

async function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

// ----------------------------------------------------------------
// Generic helpers
// ----------------------------------------------------------------

async function readSheet(tabName, range) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!${range}`,
  });
  return res.data.values || [];
}

async function appendRow(tabName, values) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}

async function updateCell(tabName, cellRange, value) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!${cellRange}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });
}

// ----------------------------------------------------------------
// IDEMPOTENCY — prevent duplicate M-Pesa transactions
// ----------------------------------------------------------------

async function isTxAlreadyProcessed(txId) {
  const rows = await readSheet(TABS.TX_IDS, 'A:A');
  return rows.some(row => row[0] === txId);
}

async function markTxProcessed(txId) {
  await appendRow(TABS.TX_IDS, [txId, new Date().toISOString()]);
}

// ----------------------------------------------------------------
// MEMBERS
// ----------------------------------------------------------------

/**
 * Returns all members as objects.
 * Sheet columns: A=ID, B=Name, C=Phone(E.164), D=Role, E=TotalContributed, F=Status
 */
async function getAllMembers() {
  const rows = await readSheet(TABS.MEMBERS, 'A2:F');
  return rows.map(r => ({
    id:               r[0] || '',
    name:             r[1] || '',
    phone:            r[2] || '',
    role:             r[3] || 'Member',
    totalContributed: parseInt(r[4]) || 0,
    status:           r[5] || 'Active',
  }));
}

async function getMemberByPhone(phone) {
  const members = await getAllMembers();
  return members.find(m => m.phone === phone) || null;
}

async function addMember({ id, name, phone, role }) {
  await appendRow(TABS.MEMBERS, [id, name, phone, role, 0, 'Active']);
}

async function updateMemberTotal(phone, amountToAdd) {
  const sheets = await getSheetsClient();
  const rows = await readSheet(TABS.MEMBERS, 'A2:F');
  const rowIndex = rows.findIndex(r => r[2] === phone);
  if (rowIndex === -1) throw new Error(`Member not found: ${phone}`);
  const currentTotal = parseInt(rows[rowIndex][4]) || 0;
  const newTotal = currentTotal + amountToAdd;
  // +2 because sheet rows are 1-indexed and header is row 1
  await updateCell(TABS.MEMBERS, `E${rowIndex + 2}`, newTotal);
  return newTotal;
}

// ----------------------------------------------------------------
// CAMPAIGNS
// ----------------------------------------------------------------

/**
 * Sheet columns: A=ID, B=Title, C=Beneficiary, D=Goal, E=Collected,
 *               F=StartDate, G=EndDate, H=Status, I=Tills(comma-sep)
 */
async function getAllCampaigns() {
  const rows = await readSheet(TABS.CAMPAIGNS, 'A2:I');
  return rows.map(r => ({
    id:          r[0] || '',
    title:       r[1] || '',
    beneficiary: r[2] || '',
    goal:        parseInt(r[3]) || 0,
    collected:   parseInt(r[4]) || 0,
    startDate:   r[5] || '',
    endDate:     r[6] || '',
    status:      r[7] || 'Active',
    tills:       (r[8] || '').split(',').map(s => s.trim()).filter(Boolean),
  }));
}

async function getActiveCampaigns() {
  const all = await getAllCampaigns();
  const now = new Date();
  return all.filter(c => {
    if (c.status !== 'Active') return false;
    if (c.endDate && new Date(c.endDate) < now) return false;
    return true;
  });
}

async function addCampaign(campaign) {
  await appendRow(TABS.CAMPAIGNS, [
    campaign.id, campaign.title, campaign.beneficiary,
    campaign.goal, 0, campaign.startDate, campaign.endDate,
    'Active', campaign.tills.join(','),
  ]);
}

async function updateCampaignCollected(campaignId, amountToAdd) {
  const rows = await readSheet(TABS.CAMPAIGNS, 'A2:I');
  const rowIndex = rows.findIndex(r => r[0] === campaignId);
  if (rowIndex === -1) throw new Error(`Campaign not found: ${campaignId}`);
  const current = parseInt(rows[rowIndex][4]) || 0;
  const newTotal = current + amountToAdd;
  await updateCell(TABS.CAMPAIGNS, `E${rowIndex + 2}`, newTotal);
  // Auto-complete if goal reached
  if (newTotal >= parseInt(rows[rowIndex][3])) {
    await updateCell(TABS.CAMPAIGNS, `H${rowIndex + 2}`, 'Completed');
  }
  return newTotal;
}

// ----------------------------------------------------------------
// CONTRIBUTIONS
// ----------------------------------------------------------------

/**
 * Sheet columns: A=ID, B=MemberPhone, C=MemberName, D=Amount,
 *               E=CampaignID, F=Date, G=Source, H=TxID, I=AdminID
 */
async function recordContribution({
  id, memberPhone, memberName, amount,
  campaignId, date, source, txId = '', adminId = '',
}) {
  await appendRow(TABS.CONTRIBUTIONS, [
    id, memberPhone, memberName, amount,
    campaignId, date, source, txId, adminId,
  ]);
}

async function getContributionsForCampaign(campaignId) {
  const rows = await readSheet(TABS.CONTRIBUTIONS, 'A2:I');
  return rows
    .filter(r => r[4] === campaignId)
    .map(r => ({
      id:          r[0],
      memberPhone: r[1],
      memberName:  r[2],
      amount:      parseInt(r[3]) || 0,
      campaignId:  r[4],
      date:        r[5],
      source:      r[6],
      txId:        r[7],
    }));
}

async function getTodayContributions(campaignId) {
  const all = await getContributionsForCampaign(campaignId);
  const today = new Date().toISOString().slice(0, 10);
  return all.filter(c => c.date.startsWith(today));
}

// ----------------------------------------------------------------
// AUDIT LOG — append-only, never updated
// ----------------------------------------------------------------

async function writeAuditLog({ adminId, action, details, ip }) {
  await appendRow(TABS.AUDIT, [
    new Date().toISOString(),
    adminId,
    action,
    JSON.stringify(details),
    ip,
  ]);
}

// ----------------------------------------------------------------
// ADMINS
// ----------------------------------------------------------------

/**
 * Sheet columns: A=ID, B=Email, C=PasswordHash, D=Role, E=TOTPSecret, F=Status
 */
async function getAdminByEmail(email) {
  const rows = await readSheet(TABS.ADMINS, 'A2:F');
  const row = rows.find(r => r[1] === email);
  if (!row) return null;
  return {
    id:           row[0],
    email:        row[1],
    passwordHash: row[2],
    role:         row[3],
    totpSecret:   row[4],
    status:       row[5],
  };
}

async function addAdmin({ id, email, passwordHash, role, totpSecret }) {
  await appendRow(TABS.ADMINS, [id, email, passwordHash, role, totpSecret, 'Active']);
}

module.exports = {
  isTxAlreadyProcessed, markTxProcessed,
  getAllMembers, getMemberByPhone, addMember, updateMemberTotal,
  getAllCampaigns, getActiveCampaigns, addCampaign, updateCampaignCollected,
  recordContribution, getContributionsForCampaign, getTodayContributions,
  writeAuditLog,
  getAdminByEmail, addAdmin,
};
