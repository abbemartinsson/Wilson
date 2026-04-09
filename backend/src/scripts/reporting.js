require('dotenv').config({ path: './src/config/.env' });

const reportingService = require('../forecasting/reportingService');

const command = process.argv[2];

async function main() {
  try {
    if (command === 'get-project-info') {
      const projectInput = process.argv[3];

      if (!projectInput) {
        console.error('Missing project key or name. Usage: npm run report:get-project-info <PROJECT_KEY_OR_NAME>');
        process.exit(1);
      }

      const report = await reportingService.getProjectInfo(projectInput);

      if (!report) {
        console.error(`No project found matching: ${projectInput}`);
        process.exit(1);
      }

      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }

    if (command === 'project-participants') {
      const projectInput = process.argv[3];

      if (!projectInput) {
        console.error('Missing project key or name. Usage: npm run report:project-participants <PROJECT_KEY_OR_NAME>');
        process.exit(1);
      }

      const report = await reportingService.getProjectParticipants(projectInput);

      if (!report) {
        console.error(`No project found matching: ${projectInput}`);
        process.exit(1);
      }

      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }

    if (command === 'project-last-week-hours') {
      const projectInput = process.argv[3];

      if (!projectInput) {
        console.error('Missing project key or name. Usage: npm run report:project-last-week-hours <PROJECT_KEY_OR_NAME>');
        process.exit(1);
      }

      const report = await reportingService.getProjectLastWeekHours(projectInput);

      if (!report) {
        console.error(`No project found matching: ${projectInput}`);
        process.exit(1);
      }

      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }

    if (command === 'list-projects') {
      const projects = await reportingService.getAllProjects();

      if (projects.length === 0) {
        console.log('No projects found.');
        process.exit(0);
      }

      console.log(JSON.stringify(projects, null, 2));
      process.exit(0);
    }

    console.error('Unknown command.');
    console.error('\nSupported commands:');
    console.error('  get-project-info <PROJECT_KEY_OR_NAME>');
    console.error('  project-last-week-hours <PROJECT_KEY_OR_NAME>');
    console.error('  project-participants <PROJECT_KEY_OR_NAME>');
    console.error('  list-projects');
    console.error('  workload-forecast [MONTHS]');
    console.error('  historical-comparison [MONTH] [YEAR] [YEARS_BACK]');
    console.error('  workload-analytics [MONTHS_BACK]');
    process.exit(1);
  } catch (error) {
    console.error('\n❌ Reporting error:', error.message || error);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
