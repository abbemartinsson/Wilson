const path = require('path');
const { execFile } = require('child_process');

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
    usage: '!project info <project_key>',
  },
  'project last week': {
    scriptCommand: 'project-last-week-hours',
    requiresText: true,
    usage: '!project last week <project_key>',
  },
  'project search': {
    scriptCommand: 'search-projects',
    requiresText: true,
    usage: '!project search <query>',
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
};

const HELP_MESSAGE = [
  'Available commands:',
  '',
  '!help',
  '!project info <project_key>',
  '!project last week <project_key>',
  '!project search <query>',
  '!workload',
  '!historical [month]',
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
    lines.push(`📅 Start: ${escapeMrkdwn(report.startDate)}`);
  }

  if (report.lastLoggedIssue) {
    lines.push(`🕒 Senaste logg: ${escapeMrkdwn(report.lastLoggedIssue)}`);
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

function formatProjectSearchResults(results) {
  if (!Array.isArray(results)) {
    return formatPlainLinesAsBullets(results);
  }

  if (results.length === 0) {
    return '• Inga projekt hittades';
  }

  return results
    .map((project) => `• ${escapeMrkdwn(project.projectName || 'Okänt projekt')} (${escapeMrkdwn(project.projectKey || 'okänd nyckel')})`)
    .join('\n');
}

function formatWorkloadForecast(results) {
  if (!Array.isArray(results)) {
    return formatPlainLinesAsBullets(results);
  }

  if (results.length === 0) {
    return '• Ingen prognos hittades';
  }

  return results
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

  if (commandName === 'project search') {
    return formatProjectSearchResults(parsedOutput);
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

async function handleTextCommand({ text, channel, client, logger = console, threadTs }) {
  const parsed = parseCommandText(text);
  if (!parsed) {
    return false;
  }

  const config = commandMap[parsed.commandName];
  if (!config) {
    logger.warn('Unknown text command received', {
      commandName: parsed.commandName,
      text: sanitizeInput(text),
    });

    await postSlackMessage(client, channel, buildMessagePayload('Unknown command', HELP_MESSAGE, true), threadTs);
    return true;
  }

  if (parsed.commandName === 'help') {
    logger.info('Showing help for text command', { command: parsed.commandName });

    await postSlackMessage(client, channel, buildMessagePayload('Help', HELP_MESSAGE, false), threadTs);
    return true;
  }

  const inputText = sanitizeInput(parsed.commandText);
  let scriptArgument = inputText || undefined;

  if (config.requiresText && !inputText) {
    await postSlackMessage(
      client,
      channel,
      buildMessagePayload('Missing input', `Usage: ${config.usage}\n\n${HELP_MESSAGE}`, true),
      threadTs
    );
    return true;
  }

  if (parsed.commandName === 'project info' || parsed.commandName === 'project last week') {
    const resolvedProject = await resolveProjectKey(inputText);

    if (!resolvedProject) {
      await postSlackMessage(
        client,
        channel,
        buildMessagePayload(
          'Project not found',
          `No project matched "${inputText}".\n\n${HELP_MESSAGE}`,
          true
        ),
        threadTs
      );
      return true;
    }

    if (resolvedProject.matchedBy === 'multiple') {
      const options = formatProjectOptions(resolvedProject.candidates);
      await postSlackMessage(
        client,
        channel,
        buildMessagePayload(
          'Multiple projects matched',
          `Please be more specific. I found these matches for "${inputText}":\n${options}\n\n${HELP_MESSAGE}`,
          true
        ),
        threadTs
      );
      return true;
    }

    scriptArgument = resolvedProject.projectKey;
  }

  if (config.inputMode === 'optional-months') {
    const parsedMonths = parseOptionalMonths(inputText);
    if (!parsedMonths.ok) {
      await postSlackMessage(
        client,
        channel,
        buildMessagePayload('Invalid input', `Usage: ${config.usage}\n${parsedMonths.message}\n\n${HELP_MESSAGE}`, true),
        threadTs
      );
      return true;
    }

    scriptArgument = parsedMonths.value;
  }

  if (config.inputMode === 'historical-month') {
    const parsedMonth = parseHistoricalMonth(inputText);
    if (!parsedMonth.ok) {
      await postSlackMessage(
        client,
        channel,
        buildMessagePayload('Invalid input', `Usage: ${config.usage}\n${parsedMonth.message}\n\n${HELP_MESSAGE}`, true),
        threadTs
      );
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
      await postSlackMessage(
        client,
        channel,
        buildMessagePayload(
          `Command completed with warnings: ${COMMAND_PREFIX}${parsed.commandName}`,
          [stdout, stderr].filter(Boolean).join('\n\n'),
          false
        ),
        threadTs
      );
      return true;
    }

    await postSlackMessage(
      client,
      channel,
      buildMessagePayload(`Command completed: ${COMMAND_PREFIX}${parsed.commandName}`, stdout, false),
      threadTs
    );
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

    await postSlackMessage(
      client,
      channel,
      buildMessagePayload(
        `Command failed: ${COMMAND_PREFIX}${parsed.commandName}`,
        [timeoutText, stderr || stdout || 'No error output.', '', HELP_MESSAGE].join('\n'),
        true
      ),
      threadTs
    );
    return true;
  }
}

module.exports = {
  handleTextCommand,
};