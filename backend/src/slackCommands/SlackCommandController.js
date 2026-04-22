const path = require('path');
const { execFile } = require('child_process');
const timesheetReminderService = require('../services/timesheetReminderService');
const userRepository = require('../repositories/userRepository');
const issueRepository = require('../repositories/issueRepository');
const worklogRepository = require('../repositories/worklogRepository');
const tempoClient = require('../clients/tempoClient');

const {
  COMMAND_PREFIX,
  commandMap,
  ROLE_PERMISSION_CONFIG,
  ROLE_LABELS,
  COMMAND_USAGE_TEXT,
  COMMAND_SHORT_DESCRIPTIONS,
  HELP_COMMAND_GROUPS,
} = require('./constants');
const RoleAccessService = require('./services/RoleAccessService');
const OutputFormatter = require('./services/OutputFormatter');
const UserCostSetupFlow = require('./flows/UserCostSetupFlow');
const WorklogSetupFlow = require('./flows/WorklogSetupFlow');
const TimesheetReminderSetupFlow = require('./flows/TimesheetReminderSetupFlow');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const REPORTING_SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'reporting.js');
const COMMAND_TIMEOUT_MS = Number.parseInt(process.env.SLACK_COMMAND_TIMEOUT_MS, 10) || 60000;
const MAX_OUTPUT_CHARS = Number.parseInt(process.env.SLACK_COMMAND_MAX_OUTPUT_CHARS, 10) || 3500;

class SlackCommandController {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.commandMap = commandMap;
    this.commandPrefix = COMMAND_PREFIX;

    this.roleAccessService = new RoleAccessService({
      commandMap,
      rolePermissionConfig: ROLE_PERMISSION_CONFIG,
      roleLabels: ROLE_LABELS,
      commandUsageText: COMMAND_USAGE_TEXT,
      commandShortDescriptions: COMMAND_SHORT_DESCRIPTIONS,
      helpCommandGroups: HELP_COMMAND_GROUPS,
      userRepository,
    });

    this.formatter = new OutputFormatter({ maxOutputChars: MAX_OUTPUT_CHARS });

    this.userCostFlow = new UserCostSetupFlow({
      userRepository,
      formatter: this.formatter,
      sendMessage: this.sendPlainTextMessage.bind(this),
    });

    this.worklogFlow = new WorklogSetupFlow({
      userRepository,
      issueRepository,
      worklogRepository,
      tempoClient,
      formatter: this.formatter,
      postSlackMessage: this.postSlackMessage.bind(this),
      buildPlainMessagePayload: this.buildPlainMessagePayload.bind(this),
      buildSplitPlainMessages: this.buildSplitPlainMessages.bind(this),
    });

    this.reminderSetupFlow = new TimesheetReminderSetupFlow({
      userRepository,
      formatter: this.formatter,
      postSlackMessage: this.postSlackMessage.bind(this),
    });
  }

  sanitizeInput(text = '') {
    return String(text)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  buildMessagePayload(_title, body, _isError = false) {
    const safeBody = body && body.trim() ? body.trim() : 'No output.';
    return this.buildPlainMessagePayload(safeBody);
  }

  buildPlainMessagePayload(body) {
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

  buildMultiMessagePayload(_title, body, _isError = false, options = {}) {
    const safeBody = body && body.trim() ? body.trim() : 'No output.';
    const maxLinesPerMessage = Number.parseInt(options.maxLinesPerMessage, 10) || 4;
    const lines = safeBody.split('\n');

    if (lines.length <= maxLinesPerMessage) {
      return [this.buildPlainMessagePayload(safeBody)];
    }

    const messages = [];
    let currentContent = [];

    for (let i = 0; i < Math.min(maxLinesPerMessage, lines.length); i += 1) {
      currentContent.push(lines[i]);
    }

    messages.push(this.buildPlainMessagePayload(currentContent.join('\n')));

    for (let i = maxLinesPerMessage; i < lines.length; i += maxLinesPerMessage) {
      const chunk = lines.slice(i, Math.min(i + maxLinesPerMessage, lines.length)).join('\n');
      messages.push(this.buildPlainMessagePayload(chunk));
    }

    return messages;
  }

  buildSplitPlainMessages(body, options = {}) {
    const safeBody = body && body.trim() ? body.trim() : 'No output.';
    const maxLinesPerMessage = Number.parseInt(options.maxLinesPerMessage, 10) || 4;
    const lines = safeBody.split('\n');

    if (lines.length <= maxLinesPerMessage) {
      return [this.buildPlainMessagePayload(safeBody)];
    }

    const messages = [];
    for (let i = 0; i < lines.length; i += maxLinesPerMessage) {
      const chunk = lines.slice(i, Math.min(i + maxLinesPerMessage, lines.length)).join('\n');
      messages.push(this.buildPlainMessagePayload(chunk));
    }

    return messages;
  }

  async postSlackMessage(client, channel, payload, threadTs) {
    return client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      ...payload,
    });
  }

  async sendPlainTextMessage(client, channel, body, threadTs) {
    await this.postSlackMessage(client, channel, this.buildPlainMessagePayload(body), threadTs);
  }

  parseOptionalMonths(inputText) {
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

  parseHistoricalMonth(inputText) {
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

  parseCommandText(text) {
    const sanitizedText = this.sanitizeInput(text);
    if (!sanitizedText.startsWith(this.commandPrefix)) {
      return null;
    }

    const withoutPrefix = sanitizedText
      .slice(this.commandPrefix.length)
      .trim()
      .replace(/-/g, ' ')
      .toLowerCase();

    if (!withoutPrefix) {
      return { commandName: '', commandText: '' };
    }

    const commandNames = Object.keys(this.commandMap).sort((left, right) => right.split(' ').length - left.split(' ').length);

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

  normalizeProjectInput(value = '') {
    return String(value).trim().toLowerCase();
  }

  formatProjectOptions(projects) {
    return projects
      .slice(0, 5)
      .map((project) => `- ${project.projectName} (${project.projectKey})`)
      .join('\n');
  }

  async resolveProjectKey(inputText) {
    const normalizedInput = String(inputText || '').trim();
    if (!normalizedInput) {
      return null;
    }

    const reportingService = require('../forecasting/reportingService');
    const projects = await reportingService.searchProjects(normalizedInput);
    if (!projects || projects.length === 0) {
      return null;
    }

    const exactNameMatch = projects.find(
      (project) => this.normalizeProjectInput(project.projectName) === this.normalizeProjectInput(normalizedInput)
    );
    if (exactNameMatch) {
      return { projectKey: exactNameMatch.projectKey, matchedBy: 'name' };
    }

    const exactKeyMatch = projects.find(
      (project) => this.normalizeProjectInput(project.projectKey) === this.normalizeProjectInput(normalizedInput)
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

  runReportingScript(scriptCommand, scriptArgument) {
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

  async handleTextCommand({
    text,
    channel,
    client,
    logger = this.logger,
    threadTs,
    slackUserId,
    onTimesheetReminderSetup,
  }) {
    const parsed = this.parseCommandText(text);
    if (!parsed) {
      logger.info('Non-command text received, suggesting help command', {
        text: this.sanitizeInput(text),
      });

      await this.postSlackMessage(
        client,
        channel,
        this.buildMessagePayload('Tips', 'Skriv !help för att se tillgängliga kommandon.', false),
        threadTs
      );
      return true;
    }

    const userRole = await this.roleAccessService.resolveUserRole(slackUserId, logger);
    const roleAwareHelpMessage = this.roleAccessService.buildHelpMessageForRole(userRole);

    const config = this.commandMap[parsed.commandName];
    if (!config) {
      logger.warn('Unknown text command received', {
        commandName: parsed.commandName,
        text: this.sanitizeInput(text),
      });

      const messages = this.buildMultiMessagePayload('Unknown command', roleAwareHelpMessage, true);
      for (const message of messages) {
        await this.postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    if (!this.roleAccessService.canUseCommand(userRole, parsed.commandName)) {
      logger.warn('User attempted command without permission', {
        commandName: parsed.commandName,
        slackUserId,
        userRole,
      });

      const messages = this.buildMultiMessagePayload(
        'Access denied',
        `Du har inte behörighet för ${this.commandPrefix}${parsed.commandName}.\n\n${roleAwareHelpMessage}`,
        true
      );
      for (const message of messages) {
        await this.postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    if (parsed.commandName === 'help') {
      logger.info('Showing help for text command', { command: parsed.commandName });

      const helpSections = roleAwareHelpMessage
        .split('\n\n')
        .map((section) => section.trim())
        .filter(Boolean);

      const messages = helpSections.map((section) => this.buildPlainMessagePayload(section));

      for (const message of messages) {
        await this.postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    if (config.customHandler === 'timesheet-reminder-setup') {
      return this.reminderSetupFlow.start({
        channel,
        client,
        threadTs,
        slackUserId,
        logger,
      });
    }

    if (config.customHandler === 'user-cost-setup') {
      return this.userCostFlow.start({
        text: parsed.commandText,
        channel,
        client,
        threadTs,
        slackUserId,
        sanitizeInput: this.sanitizeInput.bind(this),
      });
    }

    if (config.customHandler === 'worklog-setup') {
      return this.worklogFlow.start({
        channel,
        client,
        threadTs,
        slackUserId,
      });
    }

    if (config.customHandler === 'timesheet-reminder-status') {
      if (!slackUserId) {
        const messages = this.buildMultiMessagePayload(
          'Reminder status',
          'I could not identify your Slack account.',
          true
        );
        for (const message of messages) {
          await this.postSlackMessage(client, channel, message, threadTs);
        }
        return true;
      }

      const user = await timesheetReminderService.getUserReminderStatusBySlackAccountId(slackUserId);
      const body = timesheetReminderService.buildReminderStatusMessage(user);
      await this.postSlackMessage(client, channel, this.buildPlainMessagePayload(body), threadTs);
      return true;
    }

    if (config.customHandler === 'timesheet-hours') {
      if (!slackUserId) {
        const messages = this.buildMultiMessagePayload('Reminder overview', 'I could not identify your Slack account.', true);
        for (const message of messages) {
          await this.postSlackMessage(client, channel, message, threadTs);
        }
        return true;
      }

      const summary = await timesheetReminderService.getUserTimesheetSummaryBySlackAccountId(slackUserId);
      const body = timesheetReminderService.buildCurrentHoursMessage(summary);
      await this.postSlackMessage(client, channel, this.buildMessagePayload('Reminder overview', body, false), threadTs);
      return true;
    }

    const inputText = this.sanitizeInput(parsed.commandText);
    let scriptArgument = inputText || undefined;

    if (config.requiresText && !inputText) {
      const messages = this.buildMultiMessagePayload('Missing input', `Usage: ${config.usage}\n\n${roleAwareHelpMessage}`, true);
      for (const message of messages) {
        await this.postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    if (parsed.commandName === 'project info' || parsed.commandName === 'project last week' || parsed.commandName === 'project cost') {
      const resolvedProject = await this.resolveProjectKey(inputText);

      if (!resolvedProject) {
        const messages = this.buildMultiMessagePayload(
          'Project not found',
          `No project matched "${inputText}".\n\n${roleAwareHelpMessage}`,
          true
        );
        for (const message of messages) {
          await this.postSlackMessage(client, channel, message, threadTs);
        }
        return true;
      }

      if (resolvedProject.matchedBy === 'multiple') {
        const options = this.formatProjectOptions(resolvedProject.candidates);
        const messages = this.buildMultiMessagePayload(
          'Multiple projects matched',
          `Please be more specific. I found these matches for "${inputText}":\n${options}\n\n${roleAwareHelpMessage}`,
          true
        );
        for (const message of messages) {
          await this.postSlackMessage(client, channel, message, threadTs);
        }
        return true;
      }

      scriptArgument = resolvedProject.projectKey;
    }

    if (config.inputMode === 'optional-months') {
      const parsedMonths = this.parseOptionalMonths(inputText);
      if (!parsedMonths.ok) {
        const messages = this.buildMultiMessagePayload(
          'Invalid input',
          `Usage: ${config.usage}\n${parsedMonths.message}\n\n${roleAwareHelpMessage}`,
          true
        );
        for (const message of messages) {
          await this.postSlackMessage(client, channel, message, threadTs);
        }
        return true;
      }

      scriptArgument = parsedMonths.value;
    }

    if (config.inputMode === 'historical-month') {
      const parsedMonth = this.parseHistoricalMonth(inputText);
      if (!parsedMonth.ok) {
        const messages = this.buildMultiMessagePayload('Missing input', `Usage: ${config.usage}\n\n${roleAwareHelpMessage}`, true);
        for (const message of messages) {
          await this.postSlackMessage(client, channel, message, threadTs);
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
      const result = await this.runReportingScript(config.scriptCommand, scriptArgument);
      const stdout = this.formatter.clipText(this.formatter.formatCommandOutput(parsed.commandName, result.stdout));
      const stderrRaw = String(result.stderr || '').trim();
      const stderr = stderrRaw ? this.formatter.clipText(this.formatter.formatPlainLinesAsBullets(stderrRaw)) : '';

      if (stderr) {
        const messages = this.buildMultiMessagePayload('Warnings', [stdout, stderr].filter(Boolean).join('\n\n'), false);
        for (const message of messages) {
          await this.postSlackMessage(client, channel, message, threadTs);
        }
        return true;
      }

      const messages = this.buildSplitPlainMessages(stdout);
      for (const message of messages) {
        await this.postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    } catch (failure) {
      const stderrRaw = String(failure.stderr || '').trim();
      const stderr = stderrRaw ? this.formatter.clipText(this.formatter.formatPlainLinesAsBullets(stderrRaw)) : '';
      const stdout = this.formatter.clipText(this.formatter.formatCommandOutput(parsed.commandName, failure.stdout));
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

      const messages = this.buildMultiMessagePayload(
        `Command failed: ${this.commandPrefix}${parsed.commandName}`,
        [timeoutText, stderr || stdout || 'No error output.', '', roleAwareHelpMessage].join('\n'),
        true
      );
      for (const message of messages) {
        await this.postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }
  }

  async handlePendingUserCostSetup(event, client) {
    return this.userCostFlow.handlePending(event, client);
  }

  async handlePendingWorklogSetup(event, client) {
    return this.worklogFlow.handlePending(event, client);
  }

  async handlePendingReminderSetup(event, client) {
    return this.reminderSetupFlow.handlePending(event, client);
  }
}

module.exports = SlackCommandController;
