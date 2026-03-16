const jiraClient = require('../clients/jiraClient');
const issueRepo = require('../repositories/issueRepository');

async function syncIssues() {
  // 1. fetch all issues from Jira (all statuses)
  const jiraIssues = await jiraClient.fetchAllIssues();

  // 2. transform and save to database
  const saved = await issueRepo.upsertIssues(jiraIssues);
  return saved;
}

async function syncIssuesAllStatuses() {
  // Fetch all visible issues regardless of status category.
  // Uses bounded default JQL from the Jira client to satisfy API query limits.
  const jiraIssues = await jiraClient.fetchAllIssues();

  const saved = await issueRepo.upsertIssues(jiraIssues);
  return saved;
}

module.exports = {
  syncIssues,
  syncIssuesAllStatuses,
};
