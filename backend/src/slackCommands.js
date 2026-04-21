const path = require('path');
const { execFile } = require('child_process');
const timesheetReminderService = require('./services/timesheetReminderService');
const userRepository = require('./repositories/userRepository');

const COMMAND_PREFIX = '!';
const PROJECT_ROOT = path.join(__dirname, '..');
const REPORTING_SCRIPT_PATH = path.join(__dirname, 'scripts', 'reporting.js');
const COMMAND_TIMEOUT_MS = Number.parseInt(process.env.SLACK_COMMAND_TIMEOUT_MS, 10) || 60000;
const MAX_OUTPUT_CHARS = Number.parseInt(process.env.SLACK_COMMAND_MAX_OUTPUT_CHARS, 10) || 3500;

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

const ALL_COMMAND_NAMES = Object.keys(commandMap);

// Edit this config when you want to move commands between roles.
// - all: true   => role gets every command in commandMap
// - commands: [] => role gets only listed command names
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
      'reminder setup',
      'reminder update',
      'reminder status',
      'reminder hours',
    ],
  },
  // Example for future roles:
  // manager: {
  //   commands: ['help', 'projects', 'history'],
  // },
};

function buildRoleCommands(permissionConfig) {
  const allCommandsSet = new Set(ALL_COMMAND_NAMES);
  const result = {};

  for (const [roleName, roleConfig] of Object.entries(permissionConfig)) {
    if (roleConfig?.all === true) {
      result[roleName] = [...ALL_COMMAND_NAMES];
      continue;
    }

    const configuredCommands = Array.isArray(roleConfig?.commands) ? roleConfig.commands : [];
    const invalidCommandNames = configuredCommands.filter((commandName) => !allCommandsSet.has(commandName));

    if (invalidCommandNames.length > 0) {
      throw new Error(
        `Invalid command(s) in ROLE_PERMISSION_CONFIG for role "${roleName}": ${invalidCommandNames.join(', ')}`
      );
    }

    result[roleName] = [...configuredCommands];
  }

  return result;
}

const ROLE_COMMANDS = buildRoleCommands(ROLE_PERMISSION_CONFIG);

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
    title: 'Admin',
    emoji: '🛠️',
    commands: ['project cost', 'user cost'],
  },
];

const userCostSetupStore = new Map();

function normalizeUserRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  if (!normalized || !ROLE_COMMANDS[normalized]) {
    return userRepository.DEFAULT_USER_ROLE;
  }

  return normalized;
}

async function resolveUserRole(slackUserId, logger = console) {
  try {
    const role = await userRepository.findRoleBySlackAccountId(slackUserId);
    return normalizeUserRole(role);
  } catch (error) {
    logger.warn('Could not resolve user role, defaulting to member', {
      slackUserId,
      message: error.message || error,
    });
    return userRepository.DEFAULT_USER_ROLE;
  }
}

function getAllowedCommandsForRole(role) {
  const normalizedRole = normalizeUserRole(role);
  return ROLE_COMMANDS[normalizedRole] || ROLE_COMMANDS[userRepository.DEFAULT_USER_ROLE];
}

function canUseCommand(role, commandName) {
  return getAllowedCommandsForRole(role).includes(commandName);
}

function buildHelpMessageForRole(role) {
  const normalizedRole = normalizeUserRole(role);
  const roleLabel = ROLE_LABELS[normalizedRole] || normalizedRole;
  const allowedCommands = getAllowedCommandsForRole(normalizedRole);
  const allowedSet = new Set(allowedCommands);
  const usedCommandNames = new Set();
  const helpLines = [`📚 Tillgängliga kommandon för roll: *${roleLabel}*`, ''];

  for (const group of HELP_COMMAND_GROUPS) {
    const visibleCommands = group.commands.filter((commandName) => allowedSet.has(commandName));
    if (visibleCommands.length === 0) {
      continue;
    }

    visibleCommands.forEach((commandName) => usedCommandNames.add(commandName));
    helpLines.push(`• ${group.emoji} *${group.title}:*`);
    for (const commandName of visibleCommands) {
      const usage = COMMAND_USAGE_TEXT[commandName] || commandMap[commandName]?.usage || commandName;
      const shortDescription = COMMAND_SHORT_DESCRIPTIONS[commandName] || 'Ingen beskrivning.';
      helpLines.push(`   - \`${usage}\` - ${shortDescription}`);
    }

    helpLines.push('');
  }

  const ungroupedCommands = allowedCommands.filter(
    (commandName) => commandName !== 'help' && !usedCommandNames.has(commandName)
  );

  if (ungroupedCommands.length > 0) {
    helpLines.push('• 🧩 *Övrigt:*');
    for (const commandName of ungroupedCommands) {
      const usage = COMMAND_USAGE_TEXT[commandName] || commandMap[commandName]?.usage || commandName;
      const shortDescription = COMMAND_SHORT_DESCRIPTIONS[commandName] || 'Ingen beskrivning.';
      helpLines.push(`   - \`${usage}\` - ${shortDescription}`);
    }

    helpLines.push('');
  }

  while (helpLines.length > 0 && helpLines[helpLines.length - 1] === '') {
    helpLines.pop();
  }

  return helpLines.join('\n');
}

function sanitizeInput(text = '') {
  return String(text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipText(value, maxLength = MAX_OUTPUT_CHARS) {
  if (!value) return '';
  const normalized = String(value).trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}\n... (output truncated)`;
}

function escapeMrkdwn(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatNumber(value, decimals = 2) {
  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) {
    return String(value);
  }

  if (Number.isInteger(numericValue)) {
    return String(numericValue);
  }

  return numericValue.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function formatCurrency(value) {
  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) {
    return String(value);
  }

  return `${new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numericValue)} kr`;
}

function formatUserCostValue(value) {
  const numericValue = Number(value);
  if (Number.isNaN(numericValue)) {
    return 'okänd';
  }

  return `${formatCurrency(numericValue)}/timme`;
}

function parseCostInput(inputText) {
  const normalized = String(inputText || '')
    .trim()
    .toLowerCase()
    .replace(/kr\s*\/\s*timme|kr\s*\/\s*h|kr\/timme|kr\/h|kr/g, '')
    .replace(/\s+/g, '');

  if (!normalized) {
    return { ok: false, message: 'Skriv ett belopp i kr/timme.' };
  }

  if (!/^-?\d+(?:[.,]\d+)?$/.test(normalized)) {
    return { ok: false, message: 'Jag kunde inte läsa beloppet. Skriv ett tal, till exempel 350 eller 350,50.' };
  }

  const value = Number.parseFloat(normalized.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, message: 'Beloppet måste vara ett tal större än 0.' };
  }

  return { ok: true, value: Math.round(value * 100) / 100 };
}

function formatUserCostCandidate(user, index) {
  const name = escapeMrkdwn(user.name || 'Okänd');
  const email = user.email ? ` (${escapeMrkdwn(user.email)})` : '';
  const currentCost = user.cost != null ? ` - nuvarande ${formatUserCostValue(user.cost)}` : ' - ingen cost satt';
  return `${index}. ${name}${email}${currentCost}`;
}

function buildUserCostSelectionMessage(firstName, candidates) {
  const lines = [
    `Jag hittade flera users med förnamnet *${escapeMrkdwn(firstName)}*.`,
    'Svara med numret för rätt person, eller skriv `!cancel` för att avbryta.',
    '',
  ];

  candidates.forEach((candidate, index) => {
    lines.push(formatUserCostCandidate(candidate, index + 1));
  });

  return lines.join('\n');
}

function buildUserCostAmountMessage(user) {
  const name = escapeMrkdwn(user.name || 'Okänd');
  return [
    `Hur mycket kostar *${name}* per timme?`,
    'Svara med ett belopp i kr/timme, till exempel `350` eller `350,50`.',
    'Skriv `!cancel` om du vill avbryta.',
  ].join('\n');
}

async function sendUserCostMessage(client, channel, body, threadTs, isError = false) {
  await postSlackMessage(client, channel, buildPlainMessagePayload(body), threadTs);
}

async function startUserCostSetup({ text, channel, client, threadTs, slackUserId }) {
  const firstName = sanitizeInput(text).split(' ')[0];

  if (!firstName) {
    await sendUserCostMessage(client, channel, 'Usage: !user cost <förnamn>', threadTs, true);
    return true;
  }

  const candidates = await userRepository.findUsersByFirstName(firstName);

  if (candidates.length === 0) {
    await sendUserCostMessage(
      client,
      channel,
      `Jag hittade ingen user med förnamnet *${escapeMrkdwn(firstName)}*.`,
      threadTs,
      true
    );
    return true;
  }

  const key = `${slackUserId}:${channel}`;

  if (candidates.length === 1) {
    userCostSetupStore.set(key, {
      step: 'amount',
      user: candidates[0],
      requester: slackUserId,
    });

    await sendUserCostMessage(client, channel, buildUserCostAmountMessage(candidates[0]), threadTs);
    return true;
  }

  userCostSetupStore.set(key, {
    step: 'choose-user',
    firstName,
    candidates,
    requester: slackUserId,
  });

  await sendUserCostMessage(client, channel, buildUserCostSelectionMessage(firstName, candidates), threadTs);
  return true;
}

async function handlePendingUserCostSetup(event, client) {
  const key = `${event.user}:${event.channel}`;
  const state = userCostSetupStore.get(key);

  if (!state) {
    return false;
  }

  const rawText = String(event.text || '').trim();
  const normalizedText = rawText.toLowerCase();
  const replyChannel = event.channel;
  const threadTs = event.thread_ts;

  if (normalizedText === '!cancel' || normalizedText === 'cancel' || normalizedText === 'stop') {
    userCostSetupStore.delete(key);
    await sendUserCostMessage(client, replyChannel, 'User cost setup cancelled.', threadTs);
    return true;
  }

  if (state.step === 'choose-user') {
    const selection = Number.parseInt(rawText, 10);

    if (!Number.isInteger(selection) || selection < 1 || selection > state.candidates.length) {
      await sendUserCostMessage(
        client,
        replyChannel,
        `Svara med ett nummer mellan 1 och ${state.candidates.length}, eller skriv !cancel för att avbryta.`,
        threadTs,
        true
      );
      return true;
    }

    const selectedUser = state.candidates[selection - 1];
    userCostSetupStore.set(key, {
      step: 'amount',
      user: selectedUser,
      requester: state.requester,
    });

    await sendUserCostMessage(client, replyChannel, buildUserCostAmountMessage(selectedUser), threadTs);
    return true;
  }

  if (state.step === 'amount') {
    const parsedCost = parseCostInput(rawText);

    if (!parsedCost.ok) {
      await sendUserCostMessage(client, replyChannel, parsedCost.message, threadTs, true);
      return true;
    }

    const updatedUser = await userRepository.updateUserCostById(state.user.id, parsedCost.value);
    if (!updatedUser) {
      await sendUserCostMessage(client, replyChannel, 'Jag kunde inte uppdatera cost på den usern.', threadTs, true);
      return true;
    }

    userCostSetupStore.delete(key);
    await sendUserCostMessage(
      client,
      replyChannel,
      `Sparat: *${escapeMrkdwn(updatedUser.name || state.user.name || 'Okänd')}* kostar nu ${formatUserCostValue(parsedCost.value)}.`,
      threadTs
    );
    return true;
  }

  userCostSetupStore.delete(key);
  return false;
}

function extractJsonPayload(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    return null;
  }

  const attempts = [text];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '{' || text[index] === '[') {
      attempts.push(text.slice(index));
    }
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch (_error) {
      // Try the next candidate.
    }
  }

  return null;
}

function formatPlainLinesAsBullets(rawText) {
  const lines = String(rawText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return '• Inga resultat';
  }

  return lines.map((line) => `• ${escapeMrkdwn(line)}`).join('\n');
}

function formatDateOnly(dateString) {
  if (!dateString) return '';
  // Extract only the date part (YYYY-MM-DD) from ISO string
  return String(dateString).split('T')[0];
}

function formatInlineCode(text) {
  const safe = String(text ?? '').replace(/`/g, "'");
  return `\`${safe}\``;
}

function formatDetailLine(label, value) {
  return `  - ${formatInlineCode(`${label}: ${value}`)}`;
}

function formatProjectInfo(report) {
  if (!report || typeof report !== 'object') {
    return formatPlainLinesAsBullets(report);
  }

  const lines = [
    `• 📁 ${escapeMrkdwn(report.projectName || 'Okänt projekt')} (${escapeMrkdwn(report.projectKey || 'Okänd nyckel')})`,
    formatDetailLine('Timmar totalt', `${formatNumber(report.totalHours ?? 0)} h`),
    formatDetailLine('Arbetare', formatNumber(report.contributorsCount ?? 0)),
  ];

  if (report.startDate) {
    lines.push(formatDetailLine('Startdatum', escapeMrkdwn(formatDateOnly(report.startDate))));
  }

  if (report.lastLoggedIssue) {
    lines.push(formatDetailLine('Senaste logg', escapeMrkdwn(formatDateOnly(report.lastLoggedIssue))));
  }

  return lines.join('\n');
}

function formatProjectLastWeek(report) {
  if (!report || typeof report !== 'object') {
    return formatPlainLinesAsBullets(report);
  }

  const lines = [
    `• ⏱️ ${escapeMrkdwn(report.projectName || 'Okänt projekt')} (${escapeMrkdwn(report.projectKey || 'okänd nyckel')})`,
    formatDetailLine('Timmar', `${formatNumber(report.totalHours ?? 0)} h`),
  ];

  if (report.formattedDuration) {
    lines.push(formatDetailLine('Tid', escapeMrkdwn(report.formattedDuration)));
  }

  if (report.period?.label) {
    lines.push(formatDetailLine('Period', escapeMrkdwn(report.period.label)));
  }

  return lines.join('\n');
}

function formatProjectCost(report) {
  if (!report || typeof report !== 'object') {
    return formatPlainLinesAsBullets(report);
  }

  const lines = [
    `• 💰 ${escapeMrkdwn(report.projectName || 'Okänt projekt')} (${escapeMrkdwn(report.projectKey || 'okänd nyckel')})`,
    formatDetailLine('Timmar', `${formatNumber(report.totalHours ?? 0)} h`),
    formatDetailLine('Totalkostnad', formatCurrency(report.totalCost ?? 0)),
    formatDetailLine('Deltagare', formatNumber(report.participantCount ?? 0)),
  ];

  if (report.missingCostCount > 0) {
    lines.push(formatDetailLine('Saknar cost', formatNumber(report.missingCostCount)));
  }

  if (Array.isArray(report.participants) && report.participants.length > 0) {
    lines.push('');
    lines.push('  Kostnadsfördelning:');

    for (const participant of report.participants) {
      const name = escapeMrkdwn(participant.name || 'Okänd');
      const email = participant.email ? ` (${escapeMrkdwn(participant.email)})` : '';
      const hours = formatNumber(participant.totalHours ?? 0);
      const rate = participant.costPerHour != null ? `${formatNumber(participant.costPerHour)} kr/h` : 'cost saknas';
      const totalCost = participant.totalCost != null ? formatCurrency(participant.totalCost) : 'kostnad saknas';
      lines.push(`    - ${formatInlineCode(`${name}${email}: ${hours} h, ${rate}, ${totalCost}`)}`);
    }
  }

  if (Array.isArray(report.missingCostUsers) && report.missingCostUsers.length > 0) {
    lines.push('');
    lines.push('  Användare utan cost:');

    for (const user of report.missingCostUsers) {
      const name = escapeMrkdwn(user.name || 'Okänd');
      const email = user.email ? ` (${escapeMrkdwn(user.email)})` : '';
      lines.push(`    - ${formatInlineCode(`${name}${email}: ${formatNumber(user.totalHours ?? 0)} h`)}`);
    }
  }

  if (report.missingCostCount > 0) {
    lines.push('');
    lines.push('  Obs: totalen är ett minimum eftersom vissa users saknar cost.');
  }

  return lines.join('\n');
}

function formatProjectParticipants(report) {
  if (!report || typeof report !== 'object') {
    return formatPlainLinesAsBullets(report);
  }

  const lines = [
    `• 👥 ${escapeMrkdwn(report.projectName || 'Okänt projekt')} (${escapeMrkdwn(report.projectKey || 'okänd nyckel')})`,
    formatDetailLine('Antal deltagare', formatNumber(report.totalParticipants ?? 0)),
  ];

  if (Array.isArray(report.participants) && report.participants.length > 0) {
    lines.push('');
    lines.push('  Deltagare:');
    for (const participant of report.participants) {
      const name = escapeMrkdwn(participant.name || 'Okänd');
      const hours = formatNumber(participant.totalHours ?? 0);
      const email = participant.email ? ` (${escapeMrkdwn(participant.email)})` : '';
      lines.push(`    - ${formatInlineCode(`${name}${email}: ${hours} h`)}`);
    }
  }

  return lines.join('\n');
}

function formatProjectList(projects) {
  if (!Array.isArray(projects)) {
    return formatPlainLinesAsBullets(projects);
  }

  if (projects.length === 0) {
    return '• 📋 Aktiva projekt\n  Inga projekt hittades';
  }

  const lines = [
    `• 📋 Aktiva projekt (${projects.length} totalt)`,
    '',
  ];

  for (const project of projects) {
    const key = escapeMrkdwn(project.projectKey || 'okänd nyckel');
    const name = escapeMrkdwn(project.projectName || 'Okänt projekt');
    lines.push(`  - ${formatInlineCode(`${name} (${key})`)}`);
  }

  return lines.join('\n');
}

function formatWorkloadForecast(results) {
  const monthlyForecast = Array.isArray(results)
    ? results
    : (results?.forecast?.monthly_forecast || results?.monthly_forecast || results?.forecast || []);

  if (!Array.isArray(monthlyForecast)) {
    return formatPlainLinesAsBullets(results);
  }

  if (monthlyForecast.length === 0) {
    return '• 📈 Prognos\n  Ingen prognos hittades';
  }

  return monthlyForecast
    .map((item) => {
      const month = escapeMrkdwn(item.month || 'okänd månad');
      const predicted = formatNumber(item.predicted_hours ?? 0);
      const lowerBound = formatNumber(item.lower_bound ?? 0);
      const upperBound = formatNumber(item.upper_bound ?? 0);
      return [
        `• 📈 ${month}`,
        `  - ${formatInlineCode(`Prognos: ${predicted} h`)}`,
        `  - ${formatInlineCode(`Intervall: ${lowerBound}-${upperBound} h`)}`,
      ].join('\n');
    })
    .join('\n\n');
}

function formatHistoricalComparison(report) {
  if (!report || typeof report !== 'object') {
    return formatPlainLinesAsBullets(report);
  }

  const lines = [];

  if (report.current_period) {
    lines.push('  Nuvarande år:');
    lines.push(`  - ${formatInlineCode(formatNumber(report.current_period.year ?? new Date().getFullYear(), 0))}`);
    lines.push(formatDetailLine('Timmar', `${formatNumber(report.current_period.total_hours ?? 0)} h`));
    lines.push(formatDetailLine('Arbetare', formatNumber(report.current_period.active_users ?? 0)));
    lines.push(formatDetailLine('Worklogs', formatNumber(report.current_period.worklog_count ?? 0)));
    lines.push('');
  }

  if (Array.isArray(report.previous_years) && report.previous_years.length > 0) {
    lines.push('  Tidigare år:');
    for (const yearReport of report.previous_years) {
      lines.push(`    - ${formatInlineCode(yearReport.year)}`);
      lines.push(`      - ${formatInlineCode(`Timmar: ${formatNumber(yearReport.total_hours ?? 0)} h`)}`);
      lines.push(`      - ${formatInlineCode(`Arbetare: ${formatNumber(yearReport.active_users ?? 0)}`)}`);
    }
    lines.push('');
  }

  if (report.summary) {
    lines.push('  Sammanfattning:');
    if (report.summary.trend) {
      lines.push(`    - ${formatInlineCode(`Trend: ${escapeMrkdwn(report.summary.trend)}`)}`);
    }
    if (report.summary.average_hours_across_years !== undefined) {
      lines.push(`    - ${formatInlineCode(`Snitt: ${formatNumber(report.summary.average_hours_across_years)} h`)}`);
    }
    if (report.summary.max_hours !== undefined) {
      lines.push(`    - ${formatInlineCode(`Max: ${formatNumber(report.summary.max_hours)} h`)}`);
    }
    if (report.summary.min_hours !== undefined) {
      lines.push(`    - ${formatInlineCode(`Min: ${formatNumber(report.summary.min_hours)} h`)}`);
    }
    if (report.summary.years_analyzed !== undefined) {
      lines.push(`    - ${formatInlineCode(`År analyserade: ${formatNumber(report.summary.years_analyzed)}`)}`);
    }
  }

  return lines.filter(Boolean).join('\n');
}

function formatCommandOutput(commandName, rawOutput) {
  const parsedOutput = extractJsonPayload(rawOutput);

  if (parsedOutput == null) {
    return formatPlainLinesAsBullets(rawOutput);
  }

  if (commandName === 'project info') {
    return formatProjectInfo(parsedOutput);
  }

  if (commandName === 'project last week') {
    return formatProjectLastWeek(parsedOutput);
  }

  if (commandName === 'project cost') {
    return formatProjectCost(parsedOutput);
  }

  if (commandName === 'project team') {
    return formatProjectParticipants(parsedOutput);
  }

  if (commandName === 'projects') {
    return formatProjectList(parsedOutput);
  }

  if (commandName === 'forecast') {
    return formatWorkloadForecast(parsedOutput);
  }

  if (commandName === 'history') {
    return formatHistoricalComparison(parsedOutput);
  }

  if (Array.isArray(parsedOutput)) {
    return formatPlainLinesAsBullets(parsedOutput.map((item) => JSON.stringify(item)).join('\n'));
  }

  if (typeof parsedOutput === 'object') {
    return formatPlainLinesAsBullets(
      Object.entries(parsedOutput)
        .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
        .join('\n')
    );
  }

  return formatPlainLinesAsBullets(String(parsedOutput));
}

function parseOptionalMonths(inputText) {
  if (!inputText) {
    return { ok: true, value: undefined };
  }

  if (!/^\d+$/.test(inputText)) {
    return { ok: false, message: 'Months must be an integer between 1 and 12.' };
  }

  const months = Number.parseInt(inputText, 10);
  if (months < 1 || months > 12) {
    return { ok: false, message: 'Months must be between 1 and 12.' };
  }

  return { ok: true, value: String(months) };
}

function parseHistoricalMonth(inputText) {
  if (!inputText) {
    return { ok: true, value: undefined };
  }

  if (/^\d+$/.test(inputText)) {
    const monthNumber = Number.parseInt(inputText, 10);
    if (monthNumber < 1 || monthNumber > 12) {
      return { ok: false, message: 'Month must be between 1 and 12.' };
    }
    return { ok: true, value: String(monthNumber) };
  }

  const normalized = String(inputText)
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]/g, '')
    .replace(/\s+/g, ' ');

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

  const monthNumber = monthNameMap[normalized];
  if (!monthNumber) {
    return {
      ok: false,
      message: 'Use a valid month name (for example januari or february) or a number 1-12.',
    };
  }

  return { ok: true, value: String(monthNumber) };
}

function parseCommandText(text) {
  const sanitizedText = sanitizeInput(text);
  if (!sanitizedText.startsWith(COMMAND_PREFIX)) {
    return null;
  }

  const withoutPrefix = sanitizedText
    .slice(COMMAND_PREFIX.length)
    .trim()
    .replace(/-/g, ' ')
    .toLowerCase();

  if (!withoutPrefix) {
    return { commandName: '', commandText: '' };
  }

  const commandNames = Object.keys(commandMap).sort((left, right) => right.split(' ').length - left.split(' ').length);

  for (const commandName of commandNames) {
    if (withoutPrefix === commandName || withoutPrefix.startsWith(`${commandName} `)) {
      return {
        commandName,
        commandText: withoutPrefix.slice(commandName.length).trim(),
      };
    }
  }

  const [commandNameRaw, ...rest] = withoutPrefix.split(' ');
  return {
    commandName: commandNameRaw,
    commandText: rest.join(' '),
  };
}

function buildMessagePayload(title, body, isError = false) {
  const safeBody = body && body.trim() ? body.trim() : 'No output.';

  return buildPlainMessagePayload(safeBody);
}

function buildPlainMessagePayload(body) {
  const safeBody = body && body.trim() ? body.trim() : 'No output.';

  return {
    text: safeBody,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: safeBody,
        },
      },
    ],
  };
}

function buildMultiMessagePayload(title, body, isError = false, options = {}) {
  const safeBody = body && body.trim() ? body.trim() : 'No output.';

  // Slack section blocks show ~4 lines before "see more", so split aggressively
  const maxLinesPerMessage = Number.parseInt(options.maxLinesPerMessage, 10) || 4;
  const lines = safeBody.split('\n');

  if (lines.length <= maxLinesPerMessage) {
    return [buildPlainMessagePayload(safeBody)];
  }

  const messages = [];
  let currentContent = [];

  for (let i = 0; i < Math.min(maxLinesPerMessage, lines.length); i++) {
    currentContent.push(lines[i]);
  }

  messages.push(buildPlainMessagePayload(currentContent.join('\n')));

  for (let i = maxLinesPerMessage; i < lines.length; i += maxLinesPerMessage) {
    const chunk = lines.slice(i, Math.min(i + maxLinesPerMessage, lines.length)).join('\n');
    messages.push(buildPlainMessagePayload(chunk));
  }

  return messages;
}

function buildSplitPlainMessages(body, options = {}) {
  const safeBody = body && body.trim() ? body.trim() : 'No output.';

  // Slack section blocks show ~4 lines before "see more", so split aggressively
  const maxLinesPerMessage = Number.parseInt(options.maxLinesPerMessage, 10) || 4;
  const lines = safeBody.split('\n');

  if (lines.length <= maxLinesPerMessage) {
    return [buildPlainMessagePayload(safeBody)];
  }

  const messages = [];
  for (let i = 0; i < lines.length; i += maxLinesPerMessage) {
    const chunk = lines.slice(i, Math.min(i + maxLinesPerMessage, lines.length)).join('\n');
    messages.push(buildPlainMessagePayload(chunk));
  }

  return messages;
}

function normalizeProjectInput(value = '') {
  return String(value).trim().toLowerCase();
}

function formatProjectOptions(projects) {
  return projects
    .slice(0, 5)
    .map((project) => `- ${project.projectName} (${project.projectKey})`)
    .join('\n');
}

async function resolveProjectKey(inputText) {
  const normalizedInput = String(inputText || '').trim();
  if (!normalizedInput) {
    return null;
  }

  const reportingService = require('./forecasting/reportingService');
  const projects = await reportingService.searchProjects(normalizedInput);
  if (!projects || projects.length === 0) {
    return null;
  }

  const exactNameMatch = projects.find(
    (project) => normalizeProjectInput(project.projectName) === normalizeProjectInput(normalizedInput)
  );
  if (exactNameMatch) {
    return { projectKey: exactNameMatch.projectKey, matchedBy: 'name' };
  }

  const exactKeyMatch = projects.find(
    (project) => normalizeProjectInput(project.projectKey) === normalizeProjectInput(normalizedInput)
  );
  if (exactKeyMatch) {
    return { projectKey: exactKeyMatch.projectKey, matchedBy: 'key' };
  }

  if (projects.length === 1) {
    return { projectKey: projects[0].projectKey, matchedBy: 'search' };
  }

  return {
    projectKey: null,
    matchedBy: 'multiple',
    candidates: projects,
  };
}

function runReportingScript(scriptCommand, scriptArgument) {
  const args = [REPORTING_SCRIPT_PATH, scriptCommand];
  if (scriptArgument) {
    args.push(scriptArgument);
  }

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      {
        cwd: PROJECT_ROOT,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject({
            error,
            stdout,
            stderr,
            timeout: error.killed || error.signal === 'SIGTERM',
          });
          return;
        }

        resolve({ stdout, stderr });
      }
    );
  });
}

async function postSlackMessage(client, channel, payload, threadTs) {
  return client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    ...payload,
  });
}

async function handleTextCommand({
  text,
  channel,
  client,
  logger = console,
  threadTs,
  slackUserId,
  onTimesheetReminderSetup,
}) {
  const parsed = parseCommandText(text);
  if (!parsed) {
    logger.info('Non-command text received, suggesting help command', {
      text: sanitizeInput(text),
    });

    await postSlackMessage(
      client,
      channel,
      buildMessagePayload('Tips', 'Skriv !help för att se tillgängliga kommandon.', false),
      threadTs
    );
    return true;
  }

  const userRole = await resolveUserRole(slackUserId, logger);
  const roleAwareHelpMessage = buildHelpMessageForRole(userRole);

  const config = commandMap[parsed.commandName];
  if (!config) {
    logger.warn('Unknown text command received', {
      commandName: parsed.commandName,
      text: sanitizeInput(text),
    });

    const messages = buildMultiMessagePayload('Unknown command', roleAwareHelpMessage, true);
    for (const message of messages) {
      await postSlackMessage(client, channel, message, threadTs);
    }
    return true;
  }

  if (!canUseCommand(userRole, parsed.commandName)) {
    logger.warn('User attempted command without permission', {
      commandName: parsed.commandName,
      slackUserId,
      userRole,
    });

    const messages = buildMultiMessagePayload(
      'Access denied',
      `Du har inte behörighet för ${COMMAND_PREFIX}${parsed.commandName}.\n\n${roleAwareHelpMessage}`,
      true
    );
    for (const message of messages) {
      await postSlackMessage(client, channel, message, threadTs);
    }
    return true;
  }

  if (parsed.commandName === 'help') {
    logger.info('Showing help for text command', { command: parsed.commandName });

    const helpSections = roleAwareHelpMessage
      .split('\n\n')
      .map((section) => section.trim())
      .filter(Boolean);

    const messages = helpSections.map((section) => buildPlainMessagePayload(section));

    for (const message of messages) {
      await postSlackMessage(client, channel, message, threadTs);
    }
    return true;
  }

  if (config.customHandler === 'timesheet-reminder-setup') {
    if (typeof onTimesheetReminderSetup !== 'function') {
      const messages = buildMultiMessagePayload(
        'Reminder setup',
        'Reminder setup is not available in this context right now.',
        true
      );
      for (const message of messages) {
        await postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    await onTimesheetReminderSetup({
      text,
      channel,
      client,
      logger,
      threadTs,
      slackUserId,
    });
    return true;
  }

  if (config.customHandler === 'user-cost-setup') {
    return startUserCostSetup({
      text: parsed.commandText,
      channel,
      client,
      threadTs,
      slackUserId,
    });
  }

  if (config.customHandler === 'timesheet-reminder-status') {
    if (!slackUserId) {
      const messages = buildMultiMessagePayload(
        'Reminder status',
        'I could not identify your Slack account.',
        true
      );
      for (const message of messages) {
        await postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    const user = await timesheetReminderService.getUserReminderStatusBySlackAccountId(slackUserId);
    const body = timesheetReminderService.buildReminderStatusMessage(user);
    await postSlackMessage(client, channel, buildPlainMessagePayload(body), threadTs);
    return true;
  }

  if (config.customHandler === 'timesheet-hours') {
    if (!slackUserId) {
      const messages = buildMultiMessagePayload('Reminder overview', 'I could not identify your Slack account.', true);
      for (const message of messages) {
        await postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    const summary = await timesheetReminderService.getUserTimesheetSummaryBySlackAccountId(slackUserId);
    const body = timesheetReminderService.buildCurrentHoursMessage(summary);
    await postSlackMessage(client, channel, buildMessagePayload('Reminder overview', body, false), threadTs);
    return true;
  }

  const inputText = sanitizeInput(parsed.commandText);
  let scriptArgument = inputText || undefined;

  if (config.requiresText && !inputText) {
    const messages = buildMultiMessagePayload('Missing input', `Usage: ${config.usage}\n\n${roleAwareHelpMessage}`, true);
    for (const message of messages) {
      await postSlackMessage(client, channel, message, threadTs);
    }
    return true;
  }

  if (parsed.commandName === 'project info' || parsed.commandName === 'project last week' || parsed.commandName === 'project cost') {
    const resolvedProject = await resolveProjectKey(inputText);

    if (!resolvedProject) {
      const messages = buildMultiMessagePayload(
        'Project not found',
        `No project matched "${inputText}".\n\n${roleAwareHelpMessage}`,
        true
      );
      for (const message of messages) {
        await postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    if (resolvedProject.matchedBy === 'multiple') {
      const options = formatProjectOptions(resolvedProject.candidates);
      const messages = buildMultiMessagePayload(
        'Multiple projects matched',
        `Please be more specific. I found these matches for "${inputText}":\n${options}\n\n${roleAwareHelpMessage}`,
        true
      );
      for (const message of messages) {
        await postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    scriptArgument = resolvedProject.projectKey;
  }

  if (config.inputMode === 'optional-months') {
    const parsedMonths = parseOptionalMonths(inputText);
    if (!parsedMonths.ok) {
      const messages = buildMultiMessagePayload('Invalid input', `Usage: ${config.usage}\n${parsedMonths.message}\n\n${roleAwareHelpMessage}`, true);
      for (const message of messages) {
        await postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    scriptArgument = parsedMonths.value;
  }

  if (config.inputMode === 'historical-month') {
    const parsedMonth = parseHistoricalMonth(inputText);
    if (!parsedMonth.ok) {
      const messages = buildMultiMessagePayload('Missing input', `Usage: ${config.usage}\n\n${roleAwareHelpMessage}`, true);
      for (const message of messages) {
        await postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    scriptArgument = parsedMonth.value;
  }

  logger.info('Running text command', {
    command: parsed.commandName,
    scriptCommand: config.scriptCommand,
    hasInput: Boolean(inputText),
  });

  try {
    const result = await runReportingScript(config.scriptCommand, scriptArgument);
    const stdout = clipText(formatCommandOutput(parsed.commandName, result.stdout));
    const stderrRaw = String(result.stderr || '').trim();
    const stderr = stderrRaw ? clipText(formatPlainLinesAsBullets(stderrRaw)) : '';

    if (stderr) {
      const messages = buildMultiMessagePayload('Warnings', [stdout, stderr].filter(Boolean).join('\n\n'), false);
      for (const message of messages) {
        await postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    const messages = buildSplitPlainMessages(stdout);
    for (const message of messages) {
      await postSlackMessage(client, channel, message, threadTs);
    }
    return true;
  } catch (failure) {
    const stderrRaw = String(failure.stderr || '').trim();
    const stderr = stderrRaw ? clipText(formatPlainLinesAsBullets(stderrRaw)) : '';
    const stdout = clipText(formatCommandOutput(parsed.commandName, failure.stdout));
    const timeoutText = failure.timeout
      ? `Command timed out after ${COMMAND_TIMEOUT_MS} ms.`
      : 'Command execution failed.';

    const failureMessage =
      failure?.error?.message ||
      failure?.message ||
      (typeof failure === 'string' ? failure : '') ||
      'unknown error';

    logger.error('Text command failed', {
      command: parsed.commandName,
      scriptCommand: config.scriptCommand,
      message: failureMessage,
    });

    const messages = buildMultiMessagePayload(
      `Command failed: ${COMMAND_PREFIX}${parsed.commandName}`,
      [timeoutText, stderr || stdout || 'No error output.', '', roleAwareHelpMessage].join('\n'),
      true
    );
    for (const message of messages) {
      await postSlackMessage(client, channel, message, threadTs);
    }
    return true;
  }
}

module.exports = {
  handleTextCommand,
  handlePendingUserCostSetup,
};