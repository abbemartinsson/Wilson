const { createClient } = require('@supabase/supabase-js');
const config = require('../config').supabase;

// Initialize a Supabase client for database operations.
const supabase = createClient(config.url, config.serviceRoleKey);

const TABLE = 'USERS';
const ACTIVE_REMINDER_MODES = ['monday', 'friday', 'both'];

function selectUserColumns() {
  return 'id, jira_account_id, name, email, capacity_hours_per_week, slack_account_id, slack_dm_channel_id, timesheet_reminder_mode, last_timesheet_reminder_sent_at, created_at, updated_at';
}

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
    .select(selectUserColumns())
    .eq('slack_account_id', slackAccountId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function findUserById(userId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select(selectUserColumns())
    .eq('id', userId)
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
    .select(selectUserColumns())
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
    .select(selectUserColumns())
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
    .select(selectUserColumns())
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function updateTimesheetReminderPreferencesBySlackAccountId(slackAccountId, updates = {}) {
  const payload = {
    updated_at: new Date().toISOString(),
  };

  if (updates.timesheetReminderMode !== undefined) {
    payload.timesheet_reminder_mode = updates.timesheetReminderMode;
  }

  if (updates.capacityHoursPerWeek !== undefined) {
    payload.capacity_hours_per_week = updates.capacityHoursPerWeek;
  }

  if (updates.lastTimesheetReminderSentAt !== undefined) {
    payload.last_timesheet_reminder_sent_at = updates.lastTimesheetReminderSentAt;
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update(payload)
    .eq('slack_account_id', slackAccountId)
    .select(selectUserColumns())
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function updateTimesheetReminderSentAtByUserId(userId, sentAt = new Date().toISOString()) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      last_timesheet_reminder_sent_at: sentAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId)
    .select(selectUserColumns())
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function listUsersWithTimesheetReminders() {
  const { data, error } = await supabase
    .from(TABLE)
    .select(selectUserColumns())
    .in('timesheet_reminder_mode', ACTIVE_REMINDER_MODES)
    .not('slack_dm_channel_id', 'is', null)
    .order('name', { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

module.exports = {
  upsertUsers,
  findUserBySlackAccountId,
  findUserById,
  setSlackDmChannelIdBySlackAccountId,
  upsertSlackUser,
  linkSlackIdentityByEmail,
  updateTimesheetReminderPreferencesBySlackAccountId,
  updateTimesheetReminderSentAtByUserId,
  listUsersWithTimesheetReminders,
};
