'use strict';
// services/supabase.js
// Drop-in replacement for services/sheets.js
// Uses @supabase/supabase-js with the service role key (bypasses RLS)

const { createClient } = require('@supabase/supabase-js');
const { logger } = require('../utils/logger');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ----------------------------------------------------------------
// ADMINS
// ----------------------------------------------------------------

async function getAdminByEmail(email) {
  const { data, error } = await supabase
    .from('admins')
    .select('*')
    .eq('email', email)
    .single();
  if (error && error.code !== 'PGRST116') throw error; // PGRST116 = not found
  if (!data) return null;
  return {
    id:           data.id,
    email:        data.email,
    passwordHash: data.password_hash,
    role:         data.role,
    totpSecret:   data.totp_secret,
    status:       data.status,
  };
}

async function addAdmin({ id, email, passwordHash, role, totpSecret }) {
  const { error } = await supabase.from('admins').insert({
    id,
    email,
    password_hash: passwordHash,
    role:          role || 'admin',
    totp_secret:   totpSecret,
    status:        'Active',
  });
  if (error) throw error;
}

// ----------------------------------------------------------------
// MEMBERS
// ----------------------------------------------------------------

async function getAllMembers() {
  const { data, error } = await supabase
    .from('members')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(m => ({
    id:               m.id,
    name:             m.name,
    phone:            m.phone,
    role:             m.role,
    totalContributed: m.total_contributed,
    status:           m.status,
  }));
}

async function getMemberByPhone(phone) {
  const { data, error } = await supabase
    .from('members')
    .select('*')
    .eq('phone', phone)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  if (!data) return null;
  return {
    id:               data.id,
    name:             data.name,
    phone:            data.phone,
    role:             data.role,
    totalContributed: data.total_contributed,
    status:           data.status,
  };
}

async function addMember({ id, name, phone, role }) {
  const { error } = await supabase.from('members').insert({
    id,
    name,
    phone,
    role:              role || 'Member',
    total_contributed: 0,
    status:            'Active',
  });
  if (error) throw error;
}

async function updateMemberTotal(phone, amountToAdd) {
  // Increment atomically using RPC to avoid race conditions
  const { error } = await supabase.rpc('increment_member_total', {
    p_phone:  phone,
    p_amount: amountToAdd,
  });
  if (error) {
    // Fallback to read-modify-write if RPC not set up yet
    logger.warn('increment_member_total RPC not found, using fallback');
    const member = await getMemberByPhone(phone);
    if (!member) throw new Error(`Member not found: ${phone}`);
    const { error: e2 } = await supabase
      .from('members')
      .update({ total_contributed: member.totalContributed + amountToAdd })
      .eq('phone', phone);
    if (e2) throw e2;
  }
}

// ----------------------------------------------------------------
// CAMPAIGNS
// ----------------------------------------------------------------

async function getAllCampaigns() {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(mapCampaign);
}

async function getActiveCampaigns() {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('status', 'Active')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(mapCampaign);
}

async function addCampaign({ id, title, beneficiary, goal, startDate, endDate, tills }) {
  const { error } = await supabase.from('campaigns').insert({
    id,
    title,
    beneficiary,
    goal,
    collected:  0,
    start_date: startDate,
    end_date:   endDate,
    tills,
    status:     'Active',
  });
  if (error) throw error;
}

async function updateCampaignCollected(campaignId, amountToAdd) {
  const { error } = await supabase.rpc('increment_campaign_collected', {
    p_campaign_id: campaignId,
    p_amount:      amountToAdd,
  });
  if (error) {
    // Fallback
    logger.warn('increment_campaign_collected RPC not found, using fallback');
    const campaigns = await getAllCampaigns();
    const campaign = campaigns.find(c => c.id === campaignId);
    if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);
    const { error: e2 } = await supabase
      .from('campaigns')
      .update({ collected: campaign.collected + amountToAdd })
      .eq('id', campaignId);
    if (e2) throw e2;
  }
}

function mapCampaign(c) {
  return {
    id:          c.id,
    title:       c.title,
    beneficiary: c.beneficiary,
    goal:        c.goal,
    collected:   c.collected,
    startDate:   c.start_date,
    endDate:     c.end_date,
    tills:       c.tills || [],
    status:      c.status,
  };
}

// ----------------------------------------------------------------
// CONTRIBUTIONS
// ----------------------------------------------------------------

async function recordContribution({ id, memberPhone, memberName, amount, campaignId, date, source, txId, adminId }) {
  const { error } = await supabase.from('contributions').insert({
    id,
    member_phone: memberPhone,
    member_name:  memberName,
    amount,
    campaign_id:  campaignId,
    date,
    source:       source || 'M-Pesa STK',
    tx_id:        txId,
    admin_id:     adminId || null,
  });
  if (error) throw error;
}

async function getContributionsForCampaign(campaignId) {
  const { data, error } = await supabase
    .from('contributions')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(c => ({
    id:          c.id,
    memberPhone: c.member_phone,
    memberName:  c.member_name,
    amount:      c.amount,
    campaignId:  c.campaign_id,
    date:        c.date,
    source:      c.source,
    txId:        c.tx_id,
  }));
}

// ----------------------------------------------------------------
// UNMATCHED PAYMENTS
// ----------------------------------------------------------------

async function getUnmatchedPayments() {
  const { data, error } = await supabase
    .from('unmatched_payments')
    .select('*')
    .eq('status', 'Pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function appendUnmatchedPayment({ id, txId, phone, amount, date }) {
  const { error } = await supabase.from('unmatched_payments').insert({
    id, tx_id: txId, phone, amount, date, status: 'Pending',
  });
  if (error) throw error;
}

async function reconcileUnmatchedPayment(txId) {
  const { error } = await supabase
    .from('unmatched_payments')
    .update({ status: 'Reconciled' })
    .eq('tx_id', txId);
  if (error) throw error;
}

// Generic appendRow shim — maps old sheet names to the right function
async function appendRow(sheetName, values) {
  if (sheetName === 'UnmatchedPayments') {
    return appendUnmatchedPayment({
      id: values[0], txId: values[1], phone: values[2],
      amount: values[3], date: values[4],
    });
  }
  if (sheetName === 'PendingApprovals') {
    const { error } = await supabase.from('pending_approvals').insert({
      id:              values[0],
      submitted_by:    values[1],
      submitter_email: values[2],
      campaign_id:     values[3],
      campaign_title:  values[4],
      amount:          values[5],
      date:            values[6],
      method:          values[7],
      reference:       values[8],
      status:          values[9],
    });
    if (error) throw error;
    return;
  }
  throw new Error(`appendRow: unknown sheet "${sheetName}"`);
}

// Generic readSheet shim
async function readSheet(sheetName) {
  if (sheetName === 'UnmatchedPayments') {
    const { data, error } = await supabase
      .from('unmatched_payments').select('*').order('created_at');
    if (error) throw error;
    return data.map(r => [r.id, r.tx_id, r.phone, r.amount, r.date, r.status]);
  }
  if (sheetName === 'PendingApprovals') {
    const { data, error } = await supabase
      .from('pending_approvals').select('*').order('submitted_at');
    if (error) throw error;
    return data.map(r => [
      r.id, r.submitted_by, r.submitter_email, r.campaign_id,
      r.campaign_title, r.amount, r.date, r.method, r.reference,
      r.status, r.submitted_at, r.approved_by || '',
    ]);
  }
  throw new Error(`readSheet: unknown sheet "${sheetName}"`);
}

// Generic updateCell shim
async function updateCell(sheetName, _cellRef, value) {
  // cellRef is ignored — we use the row index from readSheet order
  // Routes that call updateCell re-fetch the row, so we expose targeted updates instead
  throw new Error(`updateCell: use targeted update functions instead of updateCell('${sheetName}',...)`);
}

async function updatePendingApprovalStatus(id, status, approvedBy) {
  const { error } = await supabase
    .from('pending_approvals')
    .update({ status, approved_by: approvedBy, approved_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// ----------------------------------------------------------------
// IDEMPOTENCY
// ----------------------------------------------------------------

async function isTxAlreadyProcessed(txId) {
  const { data, error } = await supabase
    .from('processed_tx_ids')
    .select('tx_id')
    .eq('tx_id', txId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return !!data;
}

async function markTxProcessed(txId) {
  const { error } = await supabase
    .from('processed_tx_ids')
    .insert({ tx_id: txId });
  // Ignore duplicate key errors (idempotent)
  if (error && error.code !== '23505') throw error;
}

// ----------------------------------------------------------------
// PENDING PAYMENTS (STK push tracking)
// ----------------------------------------------------------------

async function storePendingPayment({ checkoutRequestId, merchantRequestId, campaignId, phone, amount }) {
  const { error } = await supabase.from('pending_payments').insert({
    checkout_request_id: checkoutRequestId,
    merchant_request_id: merchantRequestId,
    campaign_id:         campaignId,
    phone,
    amount,
    status: 'Pending',
  });
  if (error) throw error;
}

async function getPendingPayment(checkoutRequestId) {
  const { data, error } = await supabase
    .from('pending_payments')
    .select('*')
    .eq('checkout_request_id', checkoutRequestId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  if (!data) return null;
  return {
    checkoutRequestId: data.checkout_request_id,
    campaignId:        data.campaign_id,
    phone:             data.phone,
    amount:            data.amount,
    status:            data.status,
    resultCode:        data.result_code,
    resultDesc:        data.result_desc,
  };
}

async function updatePendingPaymentStatus(checkoutRequestId, { status, resultCode, resultDesc }) {
  const { error } = await supabase
    .from('pending_payments')
    .update({ status, result_code: resultCode, result_desc: resultDesc, updated_at: new Date().toISOString() })
    .eq('checkout_request_id', checkoutRequestId);
  if (error) throw error;
}

// ----------------------------------------------------------------
// AUDIT LOG
// ----------------------------------------------------------------

async function writeAuditLog({ adminId, action, details, ip }) {
  const { error } = await supabase.from('audit_log').insert({
    admin_id: adminId || null,
    action,
    details:  details || {},
    ip:       ip || null,
  });
  if (error) logger.error(`Audit log write failed: ${error.message}`);
  // Never throw — audit failure must not break the main request
}

// ----------------------------------------------------------------
// EXPORTS — same surface as sheets.js so routes need no changes
// ----------------------------------------------------------------
module.exports = {
  // Admins
  getAdminByEmail,
  addAdmin,
  // Members
  getAllMembers,
  getMemberByPhone,
  addMember,
  updateMemberTotal,
  // Campaigns
  getAllCampaigns,
  getActiveCampaigns,
  addCampaign,
  updateCampaignCollected,
  // Contributions
  recordContribution,
  getContributionsForCampaign,
  // Unmatched / reconcile
  getUnmatchedPayments,
  appendUnmatchedPayment,
  reconcileUnmatchedPayment,
  appendRow,       // shim for old routes
  readSheet,       // shim for old routes
  updateCell,      // shim (throws — use targeted functions)
  updatePendingApprovalStatus,
  // Idempotency
  isTxAlreadyProcessed,
  markTxProcessed,
  // STK push tracking
  storePendingPayment,
  getPendingPayment,
  updatePendingPaymentStatus,
  // Audit
  writeAuditLog,
};