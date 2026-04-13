const { syncProjects, updateProjectTimestamps } = require('./projectService');
const { syncUsers } = require('./userService');
const { syncIssues, syncIssuesAllStatuses } = require('./issueService');
const { syncWorklogs } = require('./worklogService');

/**
 * Full synchronization - syncs all data from scratch
 * Use this for initial setup or when you need a complete refresh
 */
async function syncAll() {
  console.log('Starting full sync...');

  console.log('  → Syncing projects...');
  const projectsResult = await syncProjects();
  console.log(`    ✓ Synced ${projectsResult ? projectsResult.length : 0} projects`);

  console.log('  → Syncing users...');
  const usersResult = await syncUsers();
  console.log(`    ✓ Synced ${usersResult ? usersResult.length : 0} users`);

  console.log('  → Syncing issues...');
  const issuesResult = await syncIssuesAllStatuses();
  console.log(`    ✓ Synced ${issuesResult ? issuesResult.length : 0} issues`);

  console.log('  → Syncing worklogs...');
  const worklogsResult = await syncWorklogs();
  console.log(`    ✓ Synced ${worklogsResult ? worklogsResult.length : 0} worklogs`);

  console.log('  → Updating project timestamps...');
  const timestampsUpdated = await updateProjectTimestamps();
  console.log(`    ✓ Updated timestamps for ${timestampsUpdated} projects`);

  console.log('Full sync completed!');
}

/**
 * Daily synchronization - syncs only frequently changing data
 * Use this for scheduled daily jobs
 */
async function syncDaily() {
  console.log('Starting daily sync...');

  // Users, issues and worklogs change frequently, sync them daily
  console.log('  → Syncing users...');
  const usersResult = await syncUsers();
  console.log(`    ✓ Synced ${usersResult ? usersResult.length : 0} users`);

  console.log('  → Syncing issues...');
  const issuesResult = await syncIssuesAllStatuses();
  console.log(`    ✓ Synced ${issuesResult ? issuesResult.length : 0} issues`);

  console.log('  → Syncing worklogs...');
  const worklogsResult = await syncWorklogs();
  console.log(`    ✓ Synced ${worklogsResult ? worklogsResult.length : 0} worklogs`);

  console.log('  → Updating project timestamps...');
  const timestampsUpdated = await updateProjectTimestamps();
  console.log(`    ✓ Updated timestamps for ${timestampsUpdated} projects`);

  console.log('Daily sync completed!');
}

/**
 * Worklogs-only synchronization.
 * Useful when issues are already up to date and only worklogs need refresh.
 */
async function syncWorklogsOnly() {
  console.log('Starting worklogs-only sync...');

  console.log('  → Syncing worklogs...');
  const worklogsResult = await syncWorklogs();
  console.log(`    ✓ Synced ${worklogsResult ? worklogsResult.length : 0} worklogs`);

  console.log('Worklogs-only sync completed!');
}

async function syncProjectsOnly() {
  console.log('Starting projects-only sync...');

  console.log('  → Syncing projects...');
  const projectsResult = await syncProjects();
  console.log(`    ✓ Synced ${projectsResult ? projectsResult.length : 0} projects`);

  console.log('Projects-only sync completed!');
}

async function syncUsersOnly() {
  console.log('Starting users-only sync...');

  console.log('  → Syncing users...');
  const usersResult = await syncUsers();
  console.log(`    ✓ Synced ${usersResult ? usersResult.length : 0} users`);

  console.log('Users-only sync completed!');
}

async function syncIssuesOnly() {
  console.log('Starting issues-only sync...');

  console.log('  → Syncing issues...');
  const issuesResult = await syncIssues();
  console.log(`    ✓ Synced ${issuesResult ? issuesResult.length : 0} issues`);

  console.log('Issues-only sync completed!');
}

async function syncIssuesAllStatusesOnly() {
  console.log('Starting issues-all-statuses sync...');

  console.log('  → Syncing issues (all statuses)...');
  const issuesResult = await syncIssuesAllStatuses();
  console.log(`    ✓ Synced ${issuesResult ? issuesResult.length : 0} issues`);

  console.log('Issues-all-statuses sync completed!');
}

async function updateProjectTimestampsOnly() {
  console.log('Starting project timestamps update...');

  console.log('  → Updating project timestamps...');
  const timestampsUpdated = await updateProjectTimestamps();
  console.log(`    ✓ Updated timestamps for ${timestampsUpdated} projects`);

  console.log('Project timestamps update completed!');
}

module.exports = {
  syncAll,
  syncDaily,
  syncWorklogsOnly,
  syncProjectsOnly,
  syncUsersOnly,
  syncIssuesOnly,
  syncIssuesAllStatusesOnly,
  updateProjectTimestampsOnly,
};
