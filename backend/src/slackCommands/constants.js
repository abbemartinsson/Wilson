const COMMAND_PREFIX = '!';

const commandMap = {
  help: {
    usage: '!help',
  },
  'project info': {
    scriptCommand: 'get-project-info',
    requiresText: true,
    usage: '!project info <project_key_or_name>',
  },
  'project last week': {
    scriptCommand: 'project-last-week-hours',
    requiresText: true,
    usage: '!project last week <project_key_or_name>',
  },
  'project cost': {
    scriptCommand: 'project-cost',
    requiresText: true,
    usage: '!project cost <project_key_or_name>',
  },
  'user cost': {
    customHandler: 'user-cost-setup',
    requiresText: true,
    usage: '!user cost <förnamn>',
  },
  worklog: {
    customHandler: 'worklog-setup',
    usage: '!worklog',
  },
  'project team': {
    scriptCommand: 'project-participants',
    requiresText: true,
    usage: '!project team <project_key_or_name>',
  },
  projects: {
    scriptCommand: 'list-projects',
    requiresText: false,
    usage: '!projects',
  },
  forecast: {
    scriptCommand: 'workload-forecast',
    requiresText: false,
    usage: '!forecast [months 1-12]',
    inputMode: 'optional-months',
  },
  history: {
    scriptCommand: 'historical-comparison',
    requiresText: false,
    usage: '!history [month]',
    inputMode: 'historical-month',
  },
  'reminder setup': {
    customHandler: 'timesheet-reminder-setup',
    usage: '!reminder setup',
  },
  'reminder update': {
    customHandler: 'timesheet-reminder-setup',
    usage: '!reminder update',
  },
  'reminder status': {
    customHandler: 'timesheet-reminder-status',
    usage: '!reminder status',
  },
  'reminder hours': {
    customHandler: 'timesheet-hours',
    usage: '!reminder hours',
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
  member: 'Medlem',
};

const COMMAND_USAGE_TEXT = {
  help: '!help',
  'project info': '!project info <key_or_name>',
  'project last week': '!project last week <key_or_name>',
  'project cost': '!project cost <key_or_name>',
  'user cost': '!user cost <förnamn>',
  worklog: '!worklog',
  'project team': '!project team <key_or_name>',
  projects: '!projects',
  forecast: '!forecast [months 1-12]',
  history: '!history [month]',
  'reminder setup': '!reminder setup',
  'reminder update': '!reminder update',
  'reminder status': '!reminder status',
  'reminder hours': '!reminder hours',
};

const COMMAND_SHORT_DESCRIPTIONS = {
  help: 'Visar alla kommandon.',
  'project info': 'Visar projektets data.',
  'project last week': 'Visar timmar förra veckan.',
  'project cost': 'Visar projektets totalkostnad.',
  'user cost': 'Sätter en users kostnad per timme.',
  worklog: 'Loggar tid på ett av dina issues.',
  'project team': 'Visar vilka som jobbat.',
  projects: 'Listar alla aktiva projekt.',
  forecast: 'Visar prognos framåt.',
  history: 'Jämför med tidigare år.',
  'reminder setup': 'Ställer in reminder.',
  'reminder update': 'Uppdaterar reminder.',
  'reminder status': 'Visar reminder-status.',
  'reminder hours': 'Visar dina timmar.',
};

const HELP_COMMAND_GROUPS = [
  {
    title: 'Projekt',
    emoji: '📁',
    commands: ['project info', 'project last week', 'project team', 'projects'],
  },
  {
    title: 'Prognos och historik',
    emoji: '📈',
    commands: ['forecast', 'history'],
  },
  {
    title: 'Reminder',
    emoji: '⏰',
    commands: ['reminder setup', 'reminder update', 'reminder status', 'reminder hours'],
  },
  {
    title: 'Tidloggning',
    emoji: '⏳',
    commands: ['worklog'],
  },
  {
    title: 'Admin',
    emoji: '🛠️',
    commands: ['project cost', 'user cost'],
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
