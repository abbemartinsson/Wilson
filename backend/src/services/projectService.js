const jiraClient = require('../clients/jiraClient');
const projectRepo = require('../repositories/projectRepository');

const INTERNAL_PROJECT_CATEGORY_DESCRIPTION = 'Internal, non-billable projects';

async function syncProjects() {
  // 1. fetch from Jira
  const jiraProjects = await jiraClient.fetchAllProjects();

  // 2. filter out internal/non-billable projects
  const billableProjects = jiraProjects.filter(p => {
    const categoryDesc = p.projectCategory?.description;
    return categoryDesc !== INTERNAL_PROJECT_CATEGORY_DESCRIPTION;
  });

  const skipped = jiraProjects.length - billableProjects.length;
  if (skipped > 0) {
    console.log(`    ⚠ Skipped ${skipped} internal (non-billable) projects`);
  }

  // 3. save to database
  const saved = await projectRepo.upsertProjects(billableProjects);
  return saved;
}

async function updateProjectTimestamps() {
  const updatedCount = await projectRepo.updateProjectTimestamps();
  return updatedCount;
}

module.exports = {
  syncProjects,
  updateProjectTimestamps,
};
