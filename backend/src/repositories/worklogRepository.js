const { createClient } = require('@supabase/supabase-js');
const config = require('../config').supabase;

// Initialize a Supabase client for database operations.
const supabase = createClient(config.url, config.serviceRoleKey);

const TABLE = 'WORKLOGS';

async function insertManualWorklog({ issueId, userId, timeSpentSeconds, startedAt }) {
  const now = new Date().toISOString();
  const normalizedStartedAt = normalizeTimestamp(startedAt);
  const manualTempoId = `manual-${userId}-${issueId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const row = {
    jira_tempo_id: manualTempoId,
    issue_id: issueId,
    user_id: userId,
    time_spent_seconds: timeSpentSeconds,
    started_at: normalizedStartedAt,
    created_at: now,
    updated_at: now,
  };

  const { data, error } = await supabase
    .from(TABLE)
    .insert([row])
    .select('*')
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || row;
}

async function upsertWorklogs(worklogs) {
  const issueMap = await buildIssueLookupMap();
  const userMap = await buildUserLookupMap();

  const now = new Date().toISOString();
  const rows = [];
  let skippedCount = 0;
  let missingIssueCount = 0;
  let missingUserCount = 0;
  let missingTimeCount = 0;
  let missingStartedAtCount = 0;
  let missingTempoIdCount = 0;

  for (const worklog of worklogs) {
    const jiraIssueId = getJiraIssueId(worklog);
    const jiraTempoId = getTempoWorklogId(worklog);
    const issueId = issueMap.get(jiraIssueId);
    const jiraAccountId = getJiraAccountId(worklog);
    const userId = userMap.get(jiraAccountId);
    const startedAt = normalizeTimestamp(getStartedAt(worklog));
    const timeSpentSeconds = worklog.timeSpentSeconds || null;

    const missingIssue = !issueId;
    const missingUser = !userId;
    const missingStartedAt = !startedAt;
    const missingTime = !timeSpentSeconds;
    const missingTempoId = !jiraTempoId;

    if (missingIssue || missingUser || missingStartedAt || missingTime || missingTempoId) {
      skippedCount++;
      if (missingIssue) {
        missingIssueCount++;
      }
      if (missingUser) {
        missingUserCount++;
      }
      if (missingStartedAt) {
        missingStartedAtCount++;
      }
      if (missingTime) {
        missingTimeCount++;
      }
      if (missingTempoId) {
        missingTempoIdCount++;
      }
      continue;
    }

    rows.push({
      jira_tempo_id: jiraTempoId,
      issue_id: issueId,
      user_id: userId,
      time_spent_seconds: timeSpentSeconds,
      started_at: startedAt,
      created_at: now,
      updated_at: now,
    });
  }

  if (skippedCount > 0) {
    console.warn(`    Skipped ${skippedCount} worklogs without valid issue/user/time mapping`);
    console.warn(`    Missing issue mapping: ${missingIssueCount}`);
    console.warn(`    Missing user mapping: ${missingUserCount}`);
    console.warn(`    Missing started_at: ${missingStartedAtCount}`);
    console.warn(`    Missing time_spent_seconds: ${missingTimeCount}`);
    console.warn(`    Missing jira_tempo_id: ${missingTempoIdCount}`);
  }

  const deduplicatedRows = dedupeRowsByTempoId(rows);

  if (deduplicatedRows.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(deduplicatedRows, { onConflict: 'jira_tempo_id' });

  if (!error) {
    return data || deduplicatedRows;
  }

  // Fallback for environments where the composite unique constraint does not exist.
  const missingConstraint = String(error.message || '').includes(
    'no unique or exclusion constraint matching the ON CONFLICT specification'
  );

  if (!missingConstraint) {
    throw error;
  }

  console.warn('    Missing unique constraint for upsert, using deduplicated insert fallback');
  const existingTempoIds = await buildExistingTempoIdSet();
  const rowsToInsert = deduplicatedRows.filter(row => {
    if (existingTempoIds.has(row.jira_tempo_id)) {
      return false;
    }
    existingTempoIds.add(row.jira_tempo_id);
    return true;
  });

  if (rowsToInsert.length === 0) {
    return [];
  }

  const insertResp = await supabase.from(TABLE).insert(rowsToInsert);
  if (insertResp.error) {
    throw insertResp.error;
  }

  return insertResp.data || rowsToInsert;
}

function getJiraIssueId(worklog) {
  if (worklog.issue?.id) {
    return String(worklog.issue.id);
  }
  if (worklog.issueId) {
    return String(worklog.issueId);
  }
  return null;
}

function getTempoWorklogId(worklog) {
  if (worklog.tempoWorklogId) {
    return String(worklog.tempoWorklogId);
  }
  if (worklog.id) {
    return String(worklog.id);
  }
  return null;
}

function getJiraAccountId(worklog) {
  if (worklog.author?.accountId) {
    return worklog.author.accountId;
  }
  if (worklog.worker?.accountId) {
    return worklog.worker.accountId;
  }
  if (worklog.accountId) {
    return worklog.accountId;
  }
  return null;
}

function getStartedAt(worklog) {
  if (worklog.startedAt) {
    return worklog.startedAt;
  }
  if (worklog.startDate && worklog.startTime) {
    return `${worklog.startDate}T${worklog.startTime}Z`;
  }
  if (worklog.startDate) {
    return `${worklog.startDate}T00:00:00Z`;
  }
  return null;
}

function normalizeTimestamp(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString();
}

async function buildIssueLookupMap() {
  const data = await fetchAllRows('ISSUES', 'id, jira_issue_id');
  const map = new Map();
  for (const issue of data || []) {
    map.set(String(issue.jira_issue_id), issue.id);
  }
  return map;
}

async function buildUserLookupMap() {
  const data = await fetchAllRows('USERS', 'id, jira_account_id');
  const map = new Map();
  for (const user of data || []) {
    map.set(user.jira_account_id, user.id);
  }
  return map;
}

async function fetchAllRows(table, columns) {
  const pageSize = 1000;
  let from = 0;
  const rows = [];
  let hasMore = true;

  while (hasMore) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order('id', { ascending: true })
      .range(from, to);

    if (error) {
      throw error;
    }

    const batch = data || [];
    rows.push(...batch);
    hasMore = batch.length === pageSize;
    from += pageSize;
  }

  return rows;
}

async function buildExistingTempoIdSet() {
  const existingRows = await fetchAllRows(TABLE, 'jira_tempo_id');
  const set = new Set();

  for (const row of existingRows) {
    if (row.jira_tempo_id) {
      set.add(String(row.jira_tempo_id));
    }
  }

  return set;
}

function buildWorklogKey(issueId, userId, startedAt) {
  return `${issueId}|${userId}|${normalizeTimestamp(startedAt)}`;
}

function dedupeRowsByTempoId(rows) {
  const uniqueRows = [];
  const seenTempoIds = new Set();

  for (const row of rows) {
    const tempoId = String(row.jira_tempo_id);
    if (seenTempoIds.has(tempoId)) {
      continue;
    }

    seenTempoIds.add(tempoId);
    uniqueRows.push(row);
  }

  return uniqueRows;
}

module.exports = {
  insertManualWorklog,
  upsertWorklogs,
};
