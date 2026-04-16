/**
 * Unified sync script - syncs data based on provided argument
 * Run with: node src/scripts/sync.js [daily|all|tables|projects|users|issues|issues-all|worklogs|timestamps]
 * 
 * Examples:
 *   node src/scripts/sync.js daily              → Daily sync (users + issues + worklogs + timestamps)
 *   node src/scripts/sync.js all                → Full sync (everything)
 *   node src/scripts/sync.js tables             → Full table sync (projects + users + issues + worklogs + timestamps)
 *   node src/scripts/sync.js projects           → Projects only
 *   node src/scripts/sync.js users              → Users only
 *   node src/scripts/sync.js issues             → Issues only
 *   node src/scripts/sync.js issues-all         → Issues only (all statuses)
 *   node src/scripts/sync.js worklogs           → Worklogs only
 *   node src/scripts/sync.js timestamps         → Update project timestamps only
 */

require('dotenv').config({ path: './src/config/.env' });

const {
  syncAll,
  syncDaily,
  syncProjectsOnly,
  syncUsersOnly,
  syncIssuesOnly,
  syncIssuesAllStatusesOnly,
  syncWorklogsOnly,
  updateProjectTimestampsOnly,
} = require('../services/syncService');

const syncType = process.argv[2] || 'daily';

async function main() {
  try {
    if (syncType === 'all' || syncType === 'tables') {
      await syncAll();
    } else if (syncType === 'daily') {
      await syncDaily();
    } else if (syncType === 'projects') {
      await syncProjectsOnly();
    } else if (syncType === 'users') {
      await syncUsersOnly();
    } else if (syncType === 'issues') {
      await syncIssuesOnly();
    } else if (syncType === 'issues-all') {
      await syncIssuesAllStatusesOnly();
    } else if (syncType === 'worklogs') {
      await syncWorklogsOnly();
    } else if (syncType === 'timestamps') {
      await updateProjectTimestampsOnly();
    } else {
      console.error(
        `Unknown sync type: "${syncType}". Use "daily", "all", "tables", "projects", "users", "issues", "issues-all", "worklogs", or "timestamps"`
      );
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('Error during sync:', err.message || err);
    process.exit(1);
  }
}

main();
