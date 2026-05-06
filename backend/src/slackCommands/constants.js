const COMMAND_PREFIX = '';

const commandMap = {
  help: {
    usage: 'help',
  },
  'project info': {
    scriptCommand: 'get-project-info',
    requiresText: true,
    usage: 'project info <project key or name>',
  },
  'project last week': {
    scriptCommand: 'project-last-week-hours',
    requiresText: true,
    usage: 'project last week <project key or name>',
  },
  'project cost': {
    scriptCommand: 'project-cost',
    requiresText: true,
    usage: 'project cost <project key or name> [year]',
  },
  'user cost': {
    customHandler: 'user-cost-setup',
    requiresText: true,
    usage: 'user cost <first_name>',
  },
  worklog: {
    customHandler: 'worklog-setup',
    usage: 'worklog',
  },
  'project team': {
    scriptCommand: 'project-participants',
    requiresText: true,
    usage: 'project team <project key or name>',
  },
  'report w': {
    scriptCommand: 'project-worklog-report',
    requiresText: true,
    usage: 'report w <project key or name>',
  },
  'report m': {
    scriptCommand: 'project-worklog-report',
    requiresText: true,
    usage: 'report m <project key or name> [month]',
  },
  'report wt': {
    scriptCommand: 'project-worklog-team-report',
    requiresText: true,
    usage: 'report wt <project key or name>',
  },
  'report mt': {
    scriptCommand: 'project-worklog-team-report',
    requiresText: true,
    usage: 'report mt <project key or name> [month]',
  },
  projects: {
    scriptCommand: 'list-projects',
    requiresText: false,
    usage: 'projects',
  },
  forecast: {
    scriptCommand: 'workload-forecast',
    requiresText: false,
    usage: 'forecast [months 1-12]',
    inputMode: 'optional-months',
  },
  history: {
    scriptCommand: 'historical-comparison',
    requiresText: false,
    usage: 'history [month]',
    inputMode: 'historical-month',
  },
  'full history': {
    scriptCommand: 'full-historical',
    requiresText: false,
    usage: 'full history',
  },
  'reminder setup': {
    customHandler: 'timesheet-reminder-setup',
    usage: 'reminder setup',
  },
  'reminder update': {
    customHandler: 'timesheet-reminder-setup',
    usage: 'reminder update',
  },
  'reminder status': {
    customHandler: 'timesheet-reminder-status',
    usage: 'reminder status',
  },
  'reminder hours': {
    customHandler: 'timesheet-hours',
    usage: 'reminder hours',
  },
  'lo siento': {
    customHandler: 'lo-siento',
    usage: 'lo siento',
    hidden: true,
  },
  'fortnox login': {
    customHandler: 'fortnox-login',
    usage: 'fortnox login',
  },
};

const ROLE_PERMISSION_CONFIG = {
  admin: { all: true },
  member: {
    commands: [
      'help',
      'project info',
      'project last week',
      'projects',
      'forecast',
      'project team',
      'history',
      'full history',
      'worklog',
      'reminder setup',
      'reminder update',
      'reminder status',
      'reminder hours',
    ],
  },
  developer: {
    commands: [
      'help',
      'fortnox login',
      'project info',
      'project last week',
      'report w',
      'report m',
      'report wt',
      'report mt',
      'projects',
      'forecast',
      'project team',
      'history',
      'full history',
      'worklog',
      'reminder setup',
      'reminder update',
      'reminder status',
      'reminder hours',
    ],
  },
  'project manager': {
    commands: [
      'help',
      'project info',
      'project last week',
      'report w',
      'report m',
      'report wt',
      'report mt',
      'projects',
      'forecast',
      'project team',
      'history',
      'full history',
      'worklog',
      'reminder setup',
      'reminder update',
      'reminder status',
      'reminder hours',
    ],
  },
};

const ROLE_LABELS = {
  admin: 'Admin',
  member: 'Member',
  developer: 'Developer',
  'project manager': 'Project manager',
};

const COMMAND_USAGE_TEXT = {
  help: 'help',
  'project info': 'project info <key_or_name>',
  'project last week': 'project last week <key_or_name>',
  'project cost': 'project cost <key_or_name> [year]',
  'report w': 'report w <project key or name>',
  'report m': 'report m <project key or name> [month]',
  'report wt': 'report wt <project key or name>',
  'report mt': 'report mt <project key or name> [month]',
  'user cost': 'user cost <first_name>',
  worklog: 'worklog',
  'project team': 'project team <key_or_name>',
  projects: 'projects',
  forecast: 'forecast [months 1-12]',
  history: 'history [month]',
  'full history': 'full history',
  'reminder setup': 'reminder setup',
  'reminder update': 'reminder update',
  'reminder status': 'reminder status',
  'reminder hours': 'reminder hours',
};

const COMMAND_SHORT_DESCRIPTIONS = {
  help: 'Shows all commands.',
  'fortnox login': 'Starts the Fortnox authorization flow.',
  'project info': 'Shows project details.',
  'project last week': 'Shows hours from last week.',
  'project cost': 'Shows total project cost, optionally for a specific year.',
  'report w': 'Time per issue for the last week.',
  'report m': 'Time per issue for the last month.',
  'report wt': 'Team time per issue, week.',
  'report mt': 'Team time per issue, month.',
  'user cost': 'Sets a user hourly cost.',
  worklog: 'Logs time on one of your issues.',
  'project team': 'Shows project contributors.',
  projects: 'Lists all active projects.',
  forecast: 'Shows forward forecast. (might take a while)',
  history: 'Compares with previous years.',
  'full history': 'Shows all months with hours and contributors.',
  'reminder setup': 'Sets up reminders.',
  'reminder update': 'Updates reminders.',
  'reminder status': 'Shows reminder status.',
  'reminder hours': 'Shows your logged hours.',
};

const HELP_COMMAND_GROUPS = [
  {
    title: 'Project',
    emoji: '📁',
    commands: [
      'project info',
      'project last week',
      'project team',
      'projects',
    ],
  },
  {
    title: 'Reports',
    emoji: '🧾',
    commands: ['report w', 'report m', 'report wt', 'report mt'],
  },
  {
    title: 'Forecast and History',
    emoji: '📈',
    commands: ['forecast', 'history', 'full history'],
  },
  {
    title: 'Reminder',
    emoji: '⏰',
    commands: ['reminder setup', 'reminder update', 'reminder status', 'reminder hours'],
  },
  {
    title: 'Time Logging',
    emoji: '⏳',
    commands: ['worklog'],
  },
  {
    title: 'Admin',
    emoji: '🛠️',
    commands: ['project cost', 'user cost'],
  },
  {
    title: 'Integrations',
    emoji: '🔗',
    commands: ['fortnox login'],
  },
];

module.exports = {
  COMMAND_PREFIX,
  commandMap,
  ROLE_PERMISSION_CONFIG,
  ROLE_LABELS,
  COMMAND_USAGE_TEXT,
  COMMAND_SHORT_DESCRIPTIONS,
  HELP_COMMAND_GROUPS,
};
