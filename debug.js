// debug.js - Check all route exports
'use strict';

console.log('🔍 Checking route exports...\n');

try {
  const health = require('./routes/health');
  console.log('✅ health.js:', typeof health, health?.name || 'anonymous');
} catch(e) {
  console.log('❌ health.js ERROR:', e.message);
}

try {
  const webhook = require('./routes/webhook');
  console.log('✅ webhook.js:', typeof webhook, webhook?.name || 'anonymous');
} catch(e) {
  console.log('❌ webhook.js ERROR:', e.message);
}

try {
  const auth = require('./routes/auth');
  console.log('✅ auth.js:', typeof auth, auth?.name || 'anonymous');
} catch(e) {
  console.log('❌ auth.js ERROR:', e.message);
}

try {
  const members = require('./routes/members');
  console.log('✅ members.js:', typeof members, members?.name || 'anonymous');
} catch(e) {
  console.log('❌ members.js ERROR:', e.message);
}

try {
  const campaigns = require('./routes/campaigns');
  console.log('✅ campaigns.js:', typeof campaigns, campaigns?.name || 'anonymous');
} catch(e) {
  console.log('❌ campaigns.js ERROR:', e.message);
}

try {
  const payments = require('./routes/payments');
  console.log('✅ payments.js:', typeof payments, payments?.name || 'anonymous');
} catch(e) {
  console.log('❌ payments.js ERROR:', e.message);
}

try {
  const reports = require('./routes/reports');
  console.log('✅ reports.js:', typeof reports, reports?.name || 'anonymous');
} catch(e) {
  console.log('❌ reports.js ERROR:', e.message);
}

try {
  const adminContrib = require('./routes/adminContrib');
  console.log('✅ adminContrib.js:', typeof adminContrib, adminContrib?.name || 'anonymous');
} catch(e) {
  console.log('❌ adminContrib.js ERROR:', e.message);
}

console.log('\n📋 All routes should be of type "function"');