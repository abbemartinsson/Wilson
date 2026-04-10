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

async function findUserBySlackAccountId(slackAccountId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, slack_account_id, slack_dm_channel_id')
    .eq('slack_account_id', slackAccountId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function setSlackDmChannelIdBySlackAccountId(slackAccountId, slackDmChannelId) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      slack_dm_channel_id: slackDmChannelId,
      updated_at: new Date().toISOString(),
    })
    .eq('slack_account_id', slackAccountId)
    .select('id, slack_account_id, slack_dm_channel_id')
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function upsertSlackUser({ slackAccountId, slackDmChannelId, name }) {
  const now = new Date().toISOString();
  const row = {
    slack_account_id: slackAccountId,
    slack_dm_channel_id: slackDmChannelId,
    name: name || `Slack user ${slackAccountId}`,
    created_at: now,
    updated_at: now,
  };

  const insertResp = await supabase
    .from(TABLE)
    .insert([row])
    .select('id, slack_account_id, slack_dm_channel_id')
    .limit(1)
    .maybeSingle();

  if (!insertResp.error) {
    return insertResp.data || null;
  }

  const isDuplicateError =
    insertResp.error.code === '23505' ||
    String(insertResp.error.message || '').toLowerCase().includes('duplicate');

  if (!isDuplicateError) {
    throw insertResp.error;
  }

  return setSlackDmChannelIdBySlackAccountId(slackAccountId, slackDmChannelId);
}

async function linkSlackIdentityByEmail({ slackAccountId, slackDmChannelId, email }) {
  if (!email) {
    return null;
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }

  const { data: existingUser, error: findError } = await supabase
    .from(TABLE)
    .select('id')
    .is('slack_account_id', null)
    .ilike('email', normalizedEmail)
    .limit(1)
    .maybeSingle();

  if (findError) {
    throw findError;
  }

  if (!existingUser?.id) {
    return null;
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      slack_account_id: slackAccountId,
      slack_dm_channel_id: slackDmChannelId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existingUser.id)
    .select('id, slack_account_id, slack_dm_channel_id')
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

module.exports = {
  upsertUsers,
  findUserBySlackAccountId,
  setSlackDmChannelIdBySlackAccountId,
  upsertSlackUser,
  linkSlackIdentityByEmail,
};
