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
const PDFReportFormatter = require('./services/PDFReportFormatter');
const UserCostSetupFlow = require('./flows/UserCostSetupFlow');
const WorklogSetupFlow = require('./flows/WorklogSetupFlow');
const TimesheetReminderSetupFlow = require('./flows/TimesheetReminderSetupFlow');

const chartGeneratorService = require('../services/chartGeneratorService');

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
    this.pdfFormatter = new PDFReportFormatter();

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

  async sendAccessDeniedMessage(client, channel, threadTs) {
    await this.postSlackMessage(
      client,
      channel,
      this.buildPlainMessagePayload('You do not have access to this bot.'),
      threadTs
    );
  }

  async ensureBotAccess({ slackUserId, client, channel, threadTs, logger = this.logger }) {
    if (!slackUserId) {
      await this.sendAccessDeniedMessage(client, channel, threadTs);
      return null;
    }

    try {
      const existingUser = await userRepository.findUserBySlackAccountId(slackUserId);
      if (existingUser) {
        if (!existingUser.email) {
          await this.sendAccessDeniedMessage(client, channel, threadTs);
          return null;
        }

        return existingUser;
      }

      if (!client?.users?.info) {
        await this.sendAccessDeniedMessage(client, channel, threadTs);
        return null;
      }

      const profileResponse = await client.users.info({ user: slackUserId });
      const profile = profileResponse?.user?.profile || {};
      const email = profile.email || null;

      if (!email) {
        await this.sendAccessDeniedMessage(client, channel, threadTs);
        return null;
      }

      const linkedUser = await userRepository.linkSlackIdentityByEmail({
        slackAccountId: slackUserId,
        slackDmChannelId: null,
        email,
      });

      if (!linkedUser) {
        await this.sendAccessDeniedMessage(client, channel, threadTs);
        return null;
      }

      return linkedUser;
    } catch (error) {
      logger.warn('Could not verify bot access', {
        slackUserId,
        message: error.message || error,
      });
      await this.sendAccessDeniedMessage(client, channel, threadTs);
      return null;
    }
  }

  sanitizeInput(text = '') {
    return String(text)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  buildMessagePayload(_title, body, _isError = false) {
    if (_isError) {
      return this.buildPlainMessagePayload('Command failed. Please try again later.', true);
    }

    const safeBody = body && body.trim() ? body.trim() : 'No output.';
    return this.buildPlainMessagePayload(safeBody);
  }

  buildPlainMessagePayload(body, _isError = false) {
    if (_isError) {
      const generic = 'Command failed. Please try again later.';
      return {
        text: generic,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: generic,
            },
          },
        ],
      };
    }

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
    if (_isError) {
      return [this.buildPlainMessagePayload('Command failed. Please try again later.', true)];
    }

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

  async uploadPDFFile(client, channel, pdfStream, filename, title, threadTs) {
    try {
      const response = await client.files.uploadV2({
        channel_id: channel,
        file: pdfStream,
        filename,
        title,
        thread_ts: threadTs,
      });
      return response;
    } catch (error) {
      // If it's a scope error, throw a more helpful message
      if (error.message && error.message.includes('missing_scope')) {
        throw new Error('Bot is missing files:write scope. Add the scope in Slack app settings and reinstall the app.');
      }
      this.logger.error('Failed to upload PDF file', {
        error: error.message,
        filename,
      });
      throw error;
    }
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
        message: 'Use a valid month name (for example january or february) or a number 1-12.',
      };
    }

    return { ok: true, value: String(monthNumber) };
  }

  parseCommandText(text) {
    const sanitizedText = this.sanitizeInput(text);
    if (!sanitizedText) {
      return null;
    }

    const prefix = String(this.commandPrefix || '');
    if (prefix && !sanitizedText.startsWith(prefix)) {
      return null;
    }

    const withoutPrefix = sanitizedText
      .slice(prefix.length)
      .trim()
      .replace(/-/g, ' ')
      .toLowerCase();

    const aliasedCommandText = withoutPrefix
      .replace(/^report\s+montly\b/, 'report m')
      .replace(/^report\s+monthly\s+team\b/, 'report mt')
      .replace(/^report\s+weekly\s+team\b/, 'report wt')
      .replace(/^report\s+monthly\b/, 'report m')
      .replace(/^report\s+weekly\b/, 'report w');

    if (!aliasedCommandText) {
      return { commandName: '', commandText: '' };
    }

    const commandNames = Object.keys(this.commandMap).sort((left, right) => right.split(' ').length - left.split(' ').length);

    for (const commandName of commandNames) {
      if (aliasedCommandText === commandName || aliasedCommandText.startsWith(`${commandName} `)) {
        return {
          commandName,
          commandText: aliasedCommandText.slice(commandName.length).trim(),
        };
      }
    }

    if (!prefix) {
      return null;
    }

    const [commandNameRaw, ...rest] = aliasedCommandText.split(' ');
    return {
      commandName: commandNameRaw,
      commandText: rest.join(' '),
    };
  }

  parseMonthlyReportInput(inputText) {
    const normalizedInput = String(inputText || '').trim();
    if (!normalizedInput) {
      return { projectInput: normalizedInput, monthNumber: null };
    }

    const inputParts = normalizedInput.split(/\s+/);
    if (inputParts.length < 2) {
      return { projectInput: normalizedInput, monthNumber: null };
    }

    const tryParseMonthToken = (token) => {
      const parsedMonth = this.parseHistoricalMonth(token);
      if (parsedMonth.ok && parsedMonth.value) {
        return parsedMonth.value;
      }
      return null;
    };

    const trailingMonth = tryParseMonthToken(inputParts[inputParts.length - 1]);
    if (trailingMonth) {
      return {
        projectInput: inputParts.slice(0, -1).join(' ').trim(),
        monthNumber: trailingMonth,
      };
    }

    const leadingMonth = tryParseMonthToken(inputParts[0]);
    if (leadingMonth) {
      return {
        projectInput: inputParts.slice(1).join(' ').trim(),
        monthNumber: leadingMonth,
      };
    }

    return { projectInput: normalizedInput, monthNumber: null };
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

    if (Array.isArray(scriptArgument)) {
      for (const arg of scriptArgument) {
        if (arg !== undefined && arg !== null && String(arg).trim() !== '') {
          args.push(String(arg));
        }
      }
    } else if (scriptArgument) {
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
    const authorizedUser = await this.ensureBotAccess({
      slackUserId,
      client,
      channel,
      threadTs,
      logger,
    });

    if (!authorizedUser) {
      return true;
    }

    const parsed = this.parseCommandText(text);
    if (!parsed) {
      logger.info('Non-command text received, suggesting help command', {
        text: this.sanitizeInput(text),
      });

      await this.postSlackMessage(
        client,
        channel,
        this.buildMessagePayload('Tip', 'Type help for available commands.', false),
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

    // Skip permission check for hidden commands
    if (!config.hidden && !this.roleAccessService.canUseCommand(userRole, parsed.commandName)) {
      logger.warn('User attempted command without permission', {
        commandName: parsed.commandName,
        slackUserId,
        userRole,
      });

      const messages = this.buildMultiMessagePayload(
        'Access denied',
        `You do not have permission for ${this.commandPrefix}${parsed.commandName}.\n\n${roleAwareHelpMessage}`,
        true
      );
      for (const message of messages) {
        await this.postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    if (parsed.commandName === 'help') {
      logger.info('Showing help for text command', { command: parsed.commandName });

      const messages = this.buildSplitPlainMessages(roleAwareHelpMessage, { maxLinesPerMessage: 4 });

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

    if (config.customHandler === 'lo-siento') {
      await this.sendPlainTextMessage(
        client,
        channel,
        'https://www.youtube.com/watch?v=YpKzQeusvkA',
        threadTs
      );
      return true;
    }

    const inputText = this.sanitizeInput(parsed.commandText);
    let scriptArgument = inputText || undefined;
    let projectInputForResolution = inputText;

    if (config.requiresText && !inputText) {
      const messages = this.buildMultiMessagePayload('Missing input', `Usage: ${config.usage}\n\n${roleAwareHelpMessage}`, true);
      for (const message of messages) {
        await this.postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    if (
      parsed.commandName === 'project info' ||
      parsed.commandName === 'project last week' ||
      parsed.commandName === 'project cost' ||
      parsed.commandName === 'report w' ||
      parsed.commandName === 'report m' ||
      parsed.commandName === 'report wt' ||
      parsed.commandName === 'report mt'
    ) {
      const isMonthlyReportCommand =
        parsed.commandName === 'report m' || parsed.commandName === 'report mt';
      const parsedMonthlyInput = isMonthlyReportCommand ? this.parseMonthlyReportInput(inputText) : null;

      const projectInputCandidates = [projectInputForResolution];
      if (
        parsedMonthlyInput &&
        parsedMonthlyInput.projectInput &&
        parsedMonthlyInput.projectInput !== projectInputForResolution
      ) {
        projectInputCandidates.push(parsedMonthlyInput.projectInput);
      }

      let resolvedProject = null;
      let resolvedFromInput = projectInputForResolution;
      let firstMultipleMatch = null;

      for (const candidateInput of projectInputCandidates) {
        const candidateResolution = await this.resolveProjectKey(candidateInput);
        if (!candidateResolution) {
          continue;
        }

        if (candidateResolution.matchedBy === 'multiple') {
          if (!firstMultipleMatch) {
            firstMultipleMatch = {
              input: candidateInput,
              resolution: candidateResolution,
            };
          }
          continue;
        }

        resolvedProject = candidateResolution;
        resolvedFromInput = candidateInput;
        break;
      }

      if (!resolvedProject) {
        if (firstMultipleMatch) {
          const options = this.formatProjectOptions(firstMultipleMatch.resolution.candidates);
          const messages = this.buildMultiMessagePayload(
            'Multiple projects matched',
            `Please be more specific. I found these matches for "${firstMultipleMatch.input}":\n${options}\n\n${roleAwareHelpMessage}`,
            true
          );
          for (const message of messages) {
            await this.postSlackMessage(client, channel, message, threadTs);
          }
          return true;
        }

        const messages = this.buildMultiMessagePayload(
          'Project not found',
          `No project matched "${projectInputForResolution}".\n\n${roleAwareHelpMessage}`,
          true
        );
        for (const message of messages) {
          await this.postSlackMessage(client, channel, message, threadTs);
        }
        return true;
      }

      scriptArgument = resolvedProject.projectKey;

      if (parsed.commandName === 'report w') {
        scriptArgument = [resolvedProject.projectKey, 'week'];
      }

      if (parsed.commandName === 'report m') {
        const monthNumber =
          isMonthlyReportCommand &&
            parsedMonthlyInput &&
            parsedMonthlyInput.projectInput === resolvedFromInput
            ? parsedMonthlyInput.monthNumber
            : null;

        scriptArgument = monthNumber
          ? [resolvedProject.projectKey, 'month', monthNumber]
          : [resolvedProject.projectKey, 'month'];
      }

      if (parsed.commandName === 'report wt') {
        scriptArgument = [resolvedProject.projectKey, 'week'];
      }

      if (parsed.commandName === 'report mt') {
        const monthNumber =
          isMonthlyReportCommand &&
            parsedMonthlyInput &&
            parsedMonthlyInput.projectInput === resolvedFromInput
            ? parsedMonthlyInput.monthNumber
            : null;

        scriptArgument = monthNumber
          ? [resolvedProject.projectKey, 'month', monthNumber]
          : [resolvedProject.projectKey, 'month'];
      }
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

    const isReportCommand = [
      'report w',
      'report m',
      'report wt',
      'report mt',
    ].includes(parsed.commandName);

    const isTeamReportCommand = ['report wt', 'report mt'].includes(parsed.commandName);

    try {
      const result = await this.runReportingScript(config.scriptCommand, scriptArgument);

      // Special handling for forecast command: generate chart and post Block Kit
      if (parsed.commandName === 'forecast') {
        try {
          const reportData = this.formatter.extractJsonPayload(result.stdout);
          if (reportData && typeof reportData === 'object') {
            const chartBuffer = await chartGeneratorService.generateForecastChart(reportData);
            const filename = `worklog-forecast-${Date.now()}.png`;

            let uploadResp;
            try {
              uploadResp = await this.uploadChartImage(client, channel, chartBuffer, filename, 'Workload Forecast', threadTs);
            } catch (uploadErr) {
              this.logger.warn('Forecast image upload failed', { error: uploadErr && uploadErr.message });
              await this.postSlackMessage(client, channel, this.buildPlainMessagePayload('⚠️ Could not upload forecast chart. Please ensure the bot has `files:write` scope and try again.'), threadTs);
              return true;
            }

            const fileInfo = uploadResp?.file || uploadResp?.files?.[0] || {};
            const imageUrl = fileInfo.url_private;

            const titleText = '*📊 Forecast (Upcoming months)*';
            const insights = [];
            // Build some simple insights from data
            try {
              const f = Array.isArray(reportData.forecast)
                ? reportData.forecast
                : (reportData?.forecast?.monthly_forecast || reportData?.monthly_forecast || []);

              if (f.length > 0) {
                // normalize predicted values if needed
                const values = f.map((it) => Number(it.forecast ?? it.predicted_hours ?? it.predicted ?? it.value ?? 0));
                const avg = values.reduce((s, v) => s + v, 0) / (values.length || 1);
                insights.push(`Stable ~${Math.round(avg)}h/month`);
                insights.push('High uncertainty range');
                insights.push('Trend: see chart');
              }
            } catch (e) {
              insights.push('Forecast available');
            }

            const blocks = [];
            blocks.push({
              type: 'section',
              text: { type: 'mrkdwn', text: `${titleText}\n• ${insights.join('\n• ')}` },
            });

            if (imageUrl) {
              blocks.push({ type: 'image', image_url: imageUrl, alt_text: 'Forecast chart' });
            } else {
              // If image URL is missing, inform the channel
              await this.postSlackMessage(client, channel, this.buildPlainMessagePayload('⚠️ Forecast chart uploaded but no preview URL available. Check app scopes and channel permissions.'), threadTs);
            }

            blocks.push({
              type: 'context',
              elements: [{ type: 'mrkdwn', text: 'Projection based on model and historical data. Numbers rounded to 2 decimals.' }],
            });

            blocks.push({
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'View details' },
                  action_id: 'forecast_view_details',
                  value: 'forecast_details',
                },
              ],
            });

            await this.postSlackMessage(client, channel, { blocks }, threadTs);
            return true;
          }
        } catch (err) {
          this.logger.warn('Forecast chart generation/upload failed', { error: err.message });
        }
      }

      // Handle report commands with PDF generation
      if (isReportCommand) {
        try {
          const reportData = this.formatter.extractJsonPayload(result.stdout);
          if (!reportData || typeof reportData !== 'object') {
            const errorMessage = this.buildPlainMessagePayload(
              '⚠️ The report could not be converted to PDF. Please try again later.'
            );
            await this.postSlackMessage(client, channel, errorMessage, threadTs);
            return true;
          }

          const pdfStream = isTeamReportCommand
            ? this.pdfFormatter.generateTeamReportPDF(reportData)
            : this.pdfFormatter.generateWeeklyReportPDF(reportData);

          const period = reportData.period?.label || 'Report';
          const projectKey = reportData.projectKey || 'PROJECT';
          const filename = `${projectKey}-${parsed.commandName.replace(/ /g, '-')}-${Date.now()}.pdf`;
          const title = `${reportData.projectName || projectKey} - ${period}`;

          // Upload only PDF for report commands.
          await this.uploadPDFFile(client, channel, pdfStream, filename, title, threadTs);
          return true;
        } catch (pdfError) {
          logger.warn('PDF generation/upload failed', {
            error: pdfError.message,
          });

          const errorMessage = this.buildPlainMessagePayload(
            '⚠️ PDF upload failed. Please try again later.',
            true
          );
          await this.postSlackMessage(client, channel, errorMessage, threadTs);
          return true;
        }
      }

      if (parsed.commandName === 'history' || parsed.commandName === 'full history') {
        const isFullHistoryCommand = parsed.commandName === 'full history';
        const stdout = this.formatter.clipText(this.formatter.formatCommandOutput(parsed.commandName, result.stdout));
        const stderrRaw = String(result.stderr || '').trim();
        const stderr = stderrRaw ? this.formatter.clipText(this.formatter.formatPlainLinesAsBullets(stderrRaw)) : '';

        // For 'full history' we do not send any textual output — only the chart image.
        if (!isFullHistoryCommand) {
          if (stderr) {
            const messages = this.buildMultiMessagePayload('Warnings', [stdout, stderr].filter(Boolean).join('\n\n'), false);
            for (const message of messages) {
              await this.postSlackMessage(client, channel, message, threadTs);
            }
          } else {
            const messages = this.buildSplitPlainMessages(stdout);
            for (const message of messages) {
              await this.postSlackMessage(client, channel, message, threadTs);
            }
          }
        }

        try {
          const reportData = this.formatter.extractJsonPayload(result.stdout);
          if (reportData && typeof reportData === 'object') {
            const chartBuffer = isFullHistoryCommand
              ? await chartGeneratorService.generateFullHistoryChart(reportData)
              : await chartGeneratorService.generateHistoricalComparisonChart(reportData);
            const filename = isFullHistoryCommand
              ? `worklog-full-history-${Date.now()}.png`
              : `worklog-history-${Date.now()}.png`;

            await this.uploadChartImage(
              client,
              channel,
              chartBuffer,
              filename,
              isFullHistoryCommand ? 'Worklog Full History Chart' : 'Worklog History Chart',
              threadTs
            );
          }
        } catch (chartError) {
          logger.warn('Historical chart generation/upload failed', {
            error: chartError.message,
          });
        }

        return true;
      }

      // Regular command handling
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
    const authorizedUser = await this.ensureBotAccess({
      slackUserId: event?.user,
      client,
      channel: event?.channel,
      threadTs: event?.thread_ts,
      logger: this.logger,
    });

    if (!authorizedUser) {
      return true;
    }

    return this.userCostFlow.handlePending(event, client);
  }

  async handlePendingWorklogSetup(event, client) {
    const authorizedUser = await this.ensureBotAccess({
      slackUserId: event?.user,
      client,
      channel: event?.channel,
      threadTs: event?.thread_ts,
      logger: this.logger,
    });

    if (!authorizedUser) {
      return true;
    }

    return this.worklogFlow.handlePending(event, client);
  }

  async handlePendingReminderSetup(event, client) {
    const authorizedUser = await this.ensureBotAccess({
      slackUserId: event?.user,
      client,
      channel: event?.channel,
      threadTs: event?.thread_ts,
      logger: this.logger,
    });

    if (!authorizedUser) {
      return true;
    }

    return this.reminderSetupFlow.handlePending(event, client);
  }

  /**
   * Upload chart image to Slack
   */
  async uploadChartImage(client, channel, chartBuffer, filename, title, threadTs) {
    try {
      const response = await client.files.uploadV2({
        channel_id: channel,
        file: chartBuffer,
        filename,
        title,
        thread_ts: threadTs,
      });
      return response;
    } catch (error) {
      this.logger.error('Failed to upload chart image', {
        error: error.message,
        filename,
      });
      throw error;
    }
  }
}

module.exports = SlackCommandController;
