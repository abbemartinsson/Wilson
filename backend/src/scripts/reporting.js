require('dotenv').config({ path: './src/config/.env' });

const reportingService = require('../forecasting/reportingService');

const command = process.argv[2];

async function main() {
  try {
    if (command === 'get-project-info') {
      const projectKey = process.argv[3];

      if (!projectKey) {
        console.error('Missing project key. Usage: npm run report:get-project-info <PROJECT_KEY>');
        process.exit(1);
      }

      const report = await reportingService.getProjectInfo(projectKey);

      if (!report) {
        console.error(`No project found for key: ${projectKey}`);
        process.exit(1);
      }

      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }

    if (command === 'search-projects') {
      const query = process.argv[3];

      if (!query) {
        console.error('Missing search query. Usage: npm run report:search-projects <QUERY>');
        process.exit(1);
      }

      const projects = await reportingService.searchProjects(query);

      if (projects.length === 0) {
        console.log('No projects found matching your search.');
        process.exit(0);
      }

      console.log(JSON.stringify(projects, null, 2));
      process.exit(0);
    }

    if (command === 'project-last-week-hours') {
      const projectKey = process.argv[3];

      if (!projectKey) {
        console.error('Missing project key. Usage: npm run report:project-last-week-hours <PROJECT_KEY>');
        process.exit(1);
      }

      const report = await reportingService.getProjectLastWeekHours(projectKey);

      if (!report) {
        console.error(`No project found for key: ${projectKey}`);
        process.exit(1);
      }

      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }

    if (command === 'workload-forecast') {
      const months = parseInt(process.argv[3]) || 3;

      if (months < 1 || months > 12) {
        console.error('Invalid months value. Must be between 1 and 12.');
        process.exit(1);
      }

      const forecast = await reportingService.getWorkloadForecast(months);

      const monthlyHours = forecast?.forecast?.monthly_forecast || [];
      console.log(JSON.stringify(monthlyHours, null, 2));
      process.exit(0);
    }

    if (command === 'historical-comparison') {
      const now = new Date();
      const month = parseInt(process.argv[3]) || (now.getMonth() + 1);
      const year = parseInt(process.argv[4]) || now.getFullYear();
      const yearsBack = parseInt(process.argv[5]) || 3;

      console.log(`Comparing workload for ${year}-${String(month).padStart(2, '0')} with previous ${yearsBack} years...\n`);

      const comparison = await reportingService.getHistoricalWorkloadComparison({
        month,
        year,
        yearsBack
      });

      console.log('=== HISTORICAL WORKLOAD COMPARISON ===\n');
      console.log(JSON.stringify(comparison, null, 2));
      process.exit(0);
    }

    if (command === 'workload-analytics') {
      const monthsBack = parseInt(process.argv[3]) || 6;
      
      const now = new Date();
      const startDate = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
      const endDate = now;

      console.log(`Analyzing workload from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}...\n`);

      const analytics = await reportingService.getWorkloadAnalytics({
        startDate,
        endDate
      });

      console.log('=== WORKLOAD ANALYTICS ===\n');
      console.log(JSON.stringify(analytics, null, 2));
      process.exit(0);
    }

    console.error('Unknown command.');
    console.error('\nSupported commands:');
    console.error('  get-project-info <PROJECT_KEY>');
    console.error('  project-last-week-hours <PROJECT_KEY>');
    console.error('  search-projects <QUERY>');
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
