const path = require('path');
// Load .env relative to this script file to avoid depending on process.cwd()
require('dotenv').config({ path: path.join(__dirname, '..', 'config', '.env') });

const reportingService = require('../forecasting/reportingService');

const command = process.argv[2];

// Early validation: ensure Supabase config is available to avoid opaque failures
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Supabase configuration is missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in environment or src/config/.env');
  process.exit(1);
}

function parsePositiveInt(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric argument: ${value}`);
  }

  return parsed;
}

function parseProjectCostYear(yearInput) {
  if (yearInput === undefined || yearInput === null || String(yearInput).trim() === '') {
    return null;
  }

  const normalizedYear = String(yearInput).trim();
  if (!/^\d{4}$/.test(normalizedYear)) {
    throw new Error(`Invalid year: ${yearInput}`);
  }

  const year = Number.parseInt(normalizedYear, 10);
  if (year < 1900 || year > 2100) {
    throw new Error(`Invalid year: ${yearInput}`);
  }

  return year;
}

function parseProjectCostMonth(monthInput) {
  if (monthInput === undefined || monthInput === null || String(monthInput).trim() === '') {
    return null;
  }

  const normalizedMonth = String(monthInput)
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]/g, '');

  if (/^\d+$/.test(normalizedMonth)) {
    const monthNumber = Number.parseInt(normalizedMonth, 10);
    if (monthNumber < 1 || monthNumber > 12) {
      throw new Error(`Invalid month: ${monthInput}`);
    }
    return monthNumber;
  }

  const monthNameMap = {
    januari: 1,
    jan: 1,
    january: 1,
    feb: 2,
    februari: 2,
    february: 2,
    febuari: 2,
    mars: 3,
    mar: 3,
    march: 3,
    april: 4,
    apr: 4,
    maj: 5,
    may: 5,
    juni: 6,
    jun: 6,
    june: 6,
    juli: 7,
    jul: 7,
    july: 7,
    augusti: 8,
    aug: 8,
    august: 8,
    september: 9,
    sep: 9,
    sept: 9,
    oktober: 10,
    okt: 10,
    october: 10,
    november: 11,
    nov: 11,
    december: 12,
    dec: 12,
  };

  const monthNumber = monthNameMap[normalizedMonth];
  if (!monthNumber) {
    throw new Error(`Invalid month: ${monthInput}`);
  }

  return monthNumber;
}

function parseProjectCostPeriodOptions(yearInput, monthInput) {
  const year = parseProjectCostYear(yearInput);
  const month = parseProjectCostMonth(monthInput);

  if (!year && month) {
    throw new Error('Month filter requires year. Usage: project-cost <PROJECT_KEY_OR_NAME|total> [YEAR] [MONTH]');
  }

  const options = {};
  if (year) {
    options.year = year;
  }
  if (month) {
    options.month = month;
  }

  return options;
}

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

    if (command === 'project-cost') {
      const projectInput = process.argv[3];
      const yearInput = process.argv[4] ? String(process.argv[4]).trim() : null;
      const monthInput = process.argv[5] ? String(process.argv[5]).trim() : null;

      if (!projectInput) {
        console.error('Missing project key or name. Usage: npm run report:project-cost <PROJECT_KEY_OR_NAME|total> [YEAR] [MONTH]');
        process.exit(1);
      }

      const periodOptions = parseProjectCostPeriodOptions(yearInput, monthInput);

      const normalizedProjectInput = String(projectInput || '').trim().toLowerCase();
      // Support special case: aggregate costs for all projects using 'total' keyword
      if (normalizedProjectInput === 'total') {
        try {
          const projects = await reportingService.getAllProjects();
          const results = [];
          for (const p of projects) {
            try {
              const report = reportingService.getProjectCostWithYears
                ? await reportingService.getProjectCostWithYears(p.projectKey, periodOptions)
                : await reportingService.getProjectCost(p.projectKey, periodOptions);

              if (report) {
                results.push(report);
              }
            } catch (err) {
              console.error(`Warning: failed to compute cost for project ${p.projectKey}: ${err && err.message}`);
            }
          }

          console.log(JSON.stringify(results, null, 2));
          process.exit(0);
        } catch (err) {
          console.error(`Fatal error aggregating project costs: ${err && err.message}`);
          if (err && err.stack) {
            console.error(err.stack);
          }
          process.exit(1);
        }
      }

      const report = await reportingService.getProjectCostWithYears
        ? await reportingService.getProjectCostWithYears(projectInput, periodOptions)
        : await reportingService.getProjectCost(projectInput, periodOptions);

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

    if (command === 'project-worklog-report') {
      const projectInput = process.argv[3];
      const periodInput = String(process.argv[4] || '').trim().toLowerCase();
      const monthInput = process.argv[5] ? String(process.argv[5] || '').trim() : null;

      if (!projectInput) {
        console.error('Missing project key or name. Usage: npm run report:project-worklog-report <PROJECT_KEY_OR_NAME> <week|month> [month_number]');
        process.exit(1);
      }

      if (periodInput !== 'week' && periodInput !== 'month') {
        console.error('Missing/invalid period. Usage: npm run report:project-worklog-report <PROJECT_KEY_OR_NAME> <week|month> [month_number]');
        process.exit(1);
      }

      const report = await reportingService.getProjectWeeklyReport(projectInput, periodInput, monthInput);

      if (!report) {
        console.error(`No project found matching: ${projectInput}`);
        process.exit(1);
      }

      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }

    if (command === 'project-worklog-team-report') {
      const projectInput = process.argv[3];
      const periodInput = String(process.argv[4] || '').trim().toLowerCase();
      const monthInput = process.argv[5] ? String(process.argv[5] || '').trim() : null;

      if (!projectInput) {
        console.error('Missing project key or name. Usage: npm run report:project-worklog-team-report <PROJECT_KEY_OR_NAME> <week|month> [month_number]');
        process.exit(1);
      }

      if (periodInput !== 'week' && periodInput !== 'month') {
        console.error('Missing/invalid period. Usage: npm run report:project-worklog-team-report <PROJECT_KEY_OR_NAME> <week|month> [month_number]');
        process.exit(1);
      }

      const report = await reportingService.getProjectTeamWeeklyReport(projectInput, periodInput, monthInput);

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

    if (command === 'search-projects') {
      const query = process.argv.slice(3).join(' ').trim();

      if (!query) {
        console.error('Missing search query. Usage: npm run report:search-projects -- <QUERY>');
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

    if (command === 'workload-forecast') {
      const months = parsePositiveInt(process.argv[3], 3);
      const report = await reportingService.getWorkloadForecast(months);
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }

    if (command === 'historical-comparison') {
      const month = parsePositiveInt(process.argv[3], new Date().getMonth() + 1);
      const year = parsePositiveInt(process.argv[4], new Date().getFullYear());
      const yearsBack = parsePositiveInt(process.argv[5], 3);

      const report = await reportingService.getHistoricalWorkloadComparison({
        month,
        year,
        yearsBack,
      });

      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }

    if (command === 'full-historical') {
      const report = await reportingService.getFullHistoricalWorkload();
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }

    if (command === 'workload-analytics') {
      const monthsBack = parsePositiveInt(process.argv[3], 6);

      const endDate = new Date();
      const startDate = new Date(endDate);
      startDate.setMonth(startDate.getMonth() - monthsBack);

      const report = await reportingService.getWorkloadAnalytics({
        startDate,
        endDate,
      });

      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }

    console.error('Unknown command.');
    console.error('\nSupported commands:');
    console.error('  get-project-info <PROJECT_KEY_OR_NAME>');
    console.error('  project-last-week-hours <PROJECT_KEY_OR_NAME>');
    console.error('  project-worklog-report <PROJECT_KEY_OR_NAME> <week|month>');
    console.error('  project-worklog-team-report <PROJECT_KEY_OR_NAME> <week|month>');
    console.error('  project-participants <PROJECT_KEY_OR_NAME>');
    console.error('  project-cost <PROJECT_KEY_OR_NAME|total> [YEAR] [MONTH]');
    console.error('  list-projects');
    console.error('  workload-forecast [MONTHS]');
    console.error('  historical-comparison [MONTH] [YEAR] [YEARS_BACK]');
    console.error('  full-historical');
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
