const path = require('path');
const { execFile } = require('child_process');
const timesheetReminderService = require('./services/timesheetReminderService');

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
  'project participants': {
    scriptCommand: 'project-participants',
    requiresText: true,
    usage: '!project participants <project_key_or_name>',
  },
  'list projects': {
    scriptCommand: 'list-projects',
    requiresText: false,
    usage: '!list projects',
  },
  workload: {
    scriptCommand: 'workload-forecast',
    requiresText: false,
    usage: '!workload [months 1-12]',
    inputMode: 'optional-months',
  },
  historical: {
    scriptCommand: 'historical-comparison',
    requiresText: false,
    usage: '!historical [month]',
    inputMode: 'historical-month',
  },
  'timesheet reminder setup': {
    customHandler: 'timesheet-reminder-setup',
    usage: '!timesheet reminder setup',
  },
  'timesheet reminder update': {
    customHandler: 'timesheet-reminder-setup',
    usage: '!timesheet reminder update',
  },
  'timesheet reminder status': {
    customHandler: 'timesheet-reminder-status',
    usage: '!timesheet reminder status',
  },
  'timesheet hours': {
    customHandler: 'timesheet-hours',
    usage: '!timesheet hours',
  },
};

const HELP_MESSAGE = [
  '📚 Available commands:',
  '',
  '• ❓ !help - Visa alla tillgängliga kommandon.',
  '• 📁 !project info <key_or_name> - Visa projektets info och timmar.',
  '• 📆 !project last week <key_or_name> - Visa timmar för förra veckan.',
  '• 👥 !project participants <key_or_name> - Visa vilka som jobbat i projektet.',
  '• 📋 !list projects - Lista alla projekt.',
  '• 📈 !workload - Visa prognos för kommande månader.',
  '• 🗓 !historical [month] - Jämför historisk tid för en månad.',
  '• ⏰ !timesheet reminder setup - Ställ in påminnelser för att logga tid.',
  '• ✅ !timesheet reminder status - Visa status för påminnelser.',
  '• ♻️ !timesheet reminder update - Uppdatera påminnelser.',
  '• 📊 !timesheet hours - Visa loggade timmar för veckan.',
].join('\n');

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

function formatProjectInfo(report) {
  if (!report || typeof report !== 'object') {
    return formatPlainLinesAsBullets(report);
  }

  const lines = [
    `📁 ${escapeMrkdwn(report.projectName || 'Okänt projekt')}`,
    `🔑 ${escapeMrkdwn(report.projectKey || 'Okänd nyckel')}`,
    `🕐 ${formatNumber(report.totalHours ?? 0)} timmar`,
    `🧍 ${formatNumber(report.contributorsCount ?? 0)} arbetare`,
  ];

  if (report.startDate) {
    lines.push(`📅 Start: ${escapeMrkdwn(formatDateOnly(report.startDate))}`);
  }

  if (report.lastLoggedIssue) {
    lines.push(`🕒 Senaste logg: ${escapeMrkdwn(formatDateOnly(report.lastLoggedIssue))}`);
  }

  return lines.map((line) => `• ${line}`).join('\n');
}

function formatProjectLastWeek(report) {
  if (!report || typeof report !== 'object') {
    return formatPlainLinesAsBullets(report);
  }

  const lines = [
    `📁 ${escapeMrkdwn(report.projectName || 'Okänt projekt')} (${escapeMrkdwn(report.projectKey || 'okänd nyckel')})`,
    `🕐 ${formatNumber(report.totalHours ?? 0)} timmar`,
  ];

  if (report.formattedDuration) {
    lines.push(`⏱ ${escapeMrkdwn(report.formattedDuration)}`);
  }

  if (report.period?.label) {
    lines.push(`📅 ${escapeMrkdwn(report.period.label)}`);
  }

  return lines.map((line) => `• ${line}`).join('\n');
}

function formatProjectParticipants(report) {
  if (!report || typeof report !== 'object') {
    return formatPlainLinesAsBullets(report);
  }

  const lines = [
    `📁 ${escapeMrkdwn(report.projectName || 'Okänt projekt')} (${escapeMrkdwn(report.projectKey || 'okänd nyckel')})`,
    `👥 ${formatNumber(report.totalParticipants ?? 0)} deltagare`,
  ];

  if (Array.isArray(report.participants) && report.participants.length > 0) {
    lines.push('');
    lines.push('*Deltagare:*');
    for (const participant of report.participants) {
      const name = escapeMrkdwn(participant.name || 'Okänd');
      const hours = formatNumber(participant.totalHours ?? 0);
      const email = participant.email ? ` (${escapeMrkdwn(participant.email)})` : '';
      lines.push(`• ${name}${email} — 🕐 ${hours} timmar`);
    }
  }

  return lines.map((line) => `${line}`).join('\n');
}

function formatProjectList(projects) {
  if (!Array.isArray(projects)) {
    return formatPlainLinesAsBullets(projects);
  }

  if (projects.length === 0) {
    return '• Inga projekt hittades';
  }

  const lines = [
    `📋 *Projekt* — ${projects.length} totalt`,
    '',
  ];

  for (const project of projects) {
    const key = escapeMrkdwn(project.projectKey || 'okänd nyckel');
    const name = escapeMrkdwn(project.projectName || 'Okänt projekt');
    lines.push(`• \`${key}\` — ${name}`);
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
    return '• Ingen prognos hittades';
  }

  return monthlyForecast
    .map((item) => {
      const month = escapeMrkdwn(item.month || 'okänd månad');
      const predicted = formatNumber(item.predicted_hours ?? 0);
      const lowerBound = formatNumber(item.lower_bound ?? 0);
      const upperBound = formatNumber(item.upper_bound ?? 0);
      return `• ${month} — 🕐 ${predicted} timmar (${lowerBound}–${upperBound})`;
    })
    .join('\n');
}

function formatHistoricalComparison(report) {
  if (!report || typeof report !== 'object') {
    return formatPlainLinesAsBullets(report);
  }

  const lines = [];

  if (report.current_period) {
    lines.push('*Nuvarande period*');
    lines.push(`• 🕐 ${formatNumber(report.current_period.total_hours ?? 0)} timmar`);
    lines.push(`• 🧍 ${formatNumber(report.current_period.active_users ?? 0)} arbetare`);
    lines.push(`• 📄 ${formatNumber(report.current_period.worklog_count ?? 0)} worklogs`);
    lines.push('');
  }

  if (Array.isArray(report.previous_years) && report.previous_years.length > 0) {
    lines.push('*Tidigare år*');
    for (const yearReport of report.previous_years) {
      lines.push(
        `• ${yearReport.year}: 🕐 ${formatNumber(yearReport.total_hours ?? 0)} timmar, 🧍 ${formatNumber(
          yearReport.active_users ?? 0
        )} arbetare`
      );
    }
    lines.push('');
  }

  if (report.summary) {
    lines.push('*Sammanfattning*');
    if (report.summary.trend) {
      lines.push(`• Trend: ${escapeMrkdwn(report.summary.trend)}`);
    }
    if (report.summary.average_hours_across_years !== undefined) {
      lines.push(`• Snitt: ${formatNumber(report.summary.average_hours_across_years)} timmar`);
    }
    if (report.summary.max_hours !== undefined) {
      lines.push(`• Max: ${formatNumber(report.summary.max_hours)} timmar`);
    }
    if (report.summary.min_hours !== undefined) {
      lines.push(`• Min: ${formatNumber(report.summary.min_hours)} timmar`);
    }
    if (report.summary.years_analyzed !== undefined) {
      lines.push(`• År analyserade: ${formatNumber(report.summary.years_analyzed)}`);
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

  if (commandName === 'project participants') {
    return formatProjectParticipants(parsedOutput);
  }

  if (commandName === 'list projects') {
    return formatProjectList(parsedOutput);
  }

  if (commandName === 'workload') {
    return formatWorkloadForecast(parsedOutput);
  }

  if (commandName === 'historical') {
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

  return {
    text: `${title}\n${safeBody}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${isError ? ':x:' : ':white_check_mark:'} *${title}*`,
        },
      },
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

function buildMultiMessagePayload(title, body, isError = false) {
  const safeBody = body && body.trim() ? body.trim() : 'No output.';

  // Slack section blocks show ~4 lines before "see more", so split aggressively
  const MAX_LINES_PER_MESSAGE = 5;
  const lines = safeBody.split('\n');

  if (lines.length <= MAX_LINES_PER_MESSAGE) {
    // Short content, send as single message
    return [buildMessagePayload(title, body, isError)];
  }

  // Long content, split into multiple messages
  const messages = [];
  let currentContent = [];

  // First message with title
  for (let i = 0; i < Math.min(MAX_LINES_PER_MESSAGE, lines.length); i++) {
    currentContent.push(lines[i]);
  }

  messages.push(buildMessagePayload(title, currentContent.join('\n'), isError));

  // Additional messages for remaining content
  for (let i = MAX_LINES_PER_MESSAGE; i < lines.length; i += MAX_LINES_PER_MESSAGE) {
    const chunk = lines.slice(i, Math.min(i + MAX_LINES_PER_MESSAGE, lines.length)).join('\n');
    messages.push({
      text: chunk,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: chunk,
          },
        },
      ],
    });
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

  const config = commandMap[parsed.commandName];
  if (!config) {
    logger.warn('Unknown text command received', {
      commandName: parsed.commandName,
      text: sanitizeInput(text),
    });

    const messages = buildMultiMessagePayload('Unknown command', HELP_MESSAGE, true);
    for (const message of messages) {
      await postSlackMessage(client, channel, message, threadTs);
    }
    return true;
  }

  if (parsed.commandName === 'help') {
    logger.info('Showing help for text command', { command: parsed.commandName });

    const messages = buildMultiMessagePayload('Help', HELP_MESSAGE, false);
    for (const message of messages) {
      await postSlackMessage(client, channel, message, threadTs);
    }
    return true;
  }

  if (config.customHandler === 'timesheet-reminder-setup') {
    if (typeof onTimesheetReminderSetup !== 'function') {
      const messages = buildMultiMessagePayload(
        'Timesheet reminder setup',
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

  if (config.customHandler === 'timesheet-reminder-status') {
    if (!slackUserId) {
      const messages = buildMultiMessagePayload(
        'Timesheet reminder status',
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
    await postSlackMessage(client, channel, buildMessagePayload('Timesheet reminder status', body, false), threadTs);
    return true;
  }

  if (config.customHandler === 'timesheet-hours') {
    if (!slackUserId) {
      const messages = buildMultiMessagePayload('Timesheet overview', 'I could not identify your Slack account.', true);
      for (const message of messages) {
        await postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    const summary = await timesheetReminderService.getUserTimesheetSummaryBySlackAccountId(slackUserId);
    const body = timesheetReminderService.buildCurrentHoursMessage(summary);
    await postSlackMessage(client, channel, buildMessagePayload('Timesheet overview', body, false), threadTs);
    return true;
  }

  const inputText = sanitizeInput(parsed.commandText);
  let scriptArgument = inputText || undefined;

  if (config.requiresText && !inputText) {
    const messages = buildMultiMessagePayload('Missing input', `Usage: ${config.usage}\n\n${HELP_MESSAGE}`, true);
    for (const message of messages) {
      await postSlackMessage(client, channel, message, threadTs);
    }
    return true;
  }

  if (parsed.commandName === 'project info' || parsed.commandName === 'project last week') {
    const resolvedProject = await resolveProjectKey(inputText);

    if (!resolvedProject) {
      const messages = buildMultiMessagePayload(
        'Project not found',
        `No project matched "${inputText}".\n\n${HELP_MESSAGE}`,
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
        `Please be more specific. I found these matches for "${inputText}":\n${options}\n\n${HELP_MESSAGE}`,
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
      const messages = buildMultiMessagePayload('Invalid input', `Usage: ${config.usage}\n${parsedMonths.message}\n\n${HELP_MESSAGE}`, true);
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
      const messages = buildMultiMessagePayload('Missing input', `Usage: ${config.usage}\n\n${HELP_MESSAGE}`, true);
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
      const messages = buildMultiMessagePayload(
        `Command completed with warnings: ${COMMAND_PREFIX}${parsed.commandName}`,
        [stdout, stderr].filter(Boolean).join('\n\n'),
        false
      );
      for (const message of messages) {
        await postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    const messages = buildMultiMessagePayload(
      `Command completed: ${COMMAND_PREFIX}${parsed.commandName}`,
      stdout,
      false
    );
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

    logger.error('Text command failed', {
      command: parsed.commandName,
      scriptCommand: config.scriptCommand,
      message: failure.error?.message || 'unknown error',
    });

    const messages = buildMultiMessagePayload(
      `Command failed: ${COMMAND_PREFIX}${parsed.commandName}`,
      [timeoutText, stderr || stdout || 'No error output.', '', HELP_MESSAGE].join('\n'),
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
};