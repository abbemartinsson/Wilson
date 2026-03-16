const { createClient } = require('@supabase/supabase-js');
const config = require('../config').supabase;

// Initialize a Supabase client for database operations.
const supabase = createClient(config.url, config.serviceRoleKey);

const TABLE = 'USERS';

async function upsertUsers(users) {
  // Transform Jira user objects to our schema
  const now = new Date().toISOString();
  const rows = users.map(u => ({
    jira_account_id: u.accountId,
    name: u.displayName || 'Unknown user',
    email: u.emailAddress || null,
    created_at: now,
    updated_at: now,
    // capacity_hours_per_day and slack_account_id can be added later
  }));
  
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(rows, { onConflict: 'jira_account_id' });

  if (error) {
    throw error;
  }
  // Supabase might return null data on upsert success,
  // so return the input rows instead
  return data || rows;
}

module.exports = {
  upsertUsers,
};
