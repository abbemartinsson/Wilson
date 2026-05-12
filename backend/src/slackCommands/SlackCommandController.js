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
const excelReportService = require('../services/excelReportService');
const fortnoxInvoiceService = require('../services/fortnoxInvoiceService');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const REPORTING_SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'reporting.js');
const COMMAND_TIMEOUT_MS = Number.parseInt(process.env.SLACK_COMMAND_TIMEOUT_MS, 10) || 300000;
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
    this.excelReportService = excelReportService;

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

    // Slack limits section text to 3000 characters. Split into multiple
    // section blocks when necessary to avoid `invalid_blocks` errors.
    const MAX_SECTION_CHARS = 3000;

    const blocks = this.splitTextIntoBlocks(safeBody, MAX_SECTION_CHARS);

    // Set a concise fallback `text` property (used in notifications/previews)
    const fallbackText = safeBody.length > 2000 ? `${safeBody.slice(0, 1997)}...` : safeBody;

    return {
      text: fallbackText,
      blocks,
    };
  }

  splitTextIntoBlocks(text = '', maxChars = 3000) {
    const safe = String(text || '');
    if (safe.length === 0) {
      return [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'No output.' },
        },
      ];
    }

    if (safe.length <= maxChars) {
      return [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: safe },
        },
      ];
    }

    const lines = safe.split('\n');
    const chunks = [];
    let current = '';

    for (const line of lines) {
      if ((current.length ? current.length + 1 + line.length : line.length) <= maxChars) {
        current = current ? `${current}\n${line}` : line;
        continue;
      }

      if (current) {
        chunks.push(current);
        current = '';
      }

      if (line.length <= maxChars) {
        current = line;
        continue;
      }

      // If a single line is longer than maxChars, hard-split it.
      for (let i = 0; i < line.length; i += maxChars) {
        chunks.push(line.slice(i, i + maxChars));
      }
    }

    if (current) {
      chunks.push(current);
    }

    return chunks.map((c) => ({ type: 'section', text: { type: 'mrkdwn', text: c } }));
  }

  buildMultiMessagePayload(_title, body, _isError = false, options = {}) {
    if (_isError) {
      return [this.buildPlainMessagePayload('Command failed. Please try again later.', true)];
    }

    const safeBody = body && body.trim() ? body.trim() : 'No output.';
    return [this.buildPlainMessagePayload(safeBody)];
  }

  buildSplitPlainMessages(body, options = {}) {
    const safeBody = body && body.trim() ? body.trim() : 'No output.';
    return [this.buildPlainMessagePayload(safeBody)];
  }

  buildSectionBasedMessages(body, maxLinesPerMessage = 12) {
    const safeBody = body && body.trim() ? body.trim() : 'No output.';
    return [this.buildPlainMessagePayload(safeBody)];
  }

  buildHelpMessagesWithGrouping(sections, maxLinesPerMessage = 8) {
    if (!Array.isArray(sections) || sections.length === 0) {
      return [this.buildPlainMessagePayload('No commands available.')];
    }

    const messages = [];
    let currentMessageLines = [];
    let currentLineCount = 0;

    for (const section of sections) {
      const sectionLineCount = section.lines.length;
      const totalLinesIfAdded = currentLineCount + sectionLineCount + (currentLineCount > 0 ? 1 : 0); // +1 for spacing

      // If adding this section would exceed maxLines and we have content, start new message
      if (totalLinesIfAdded > maxLinesPerMessage && currentMessageLines.length > 0) {
        messages.push(this.buildPlainMessagePayload(currentMessageLines.join('\n')));
        currentMessageLines = [];
        currentLineCount = 0;
      }

      // Add spacing between sections (but not before header or after previous spacing)
      if (currentMessageLines.length > 0 && !currentMessageLines[currentMessageLines.length - 1].endsWith('')) {
        currentMessageLines.push('');
        currentLineCount += 1;
      }

      currentMessageLines.push(...section.lines);
      currentLineCount += sectionLineCount;
    }

    if (currentMessageLines.length > 0) {
      messages.push(this.buildPlainMessagePayload(currentMessageLines.join('\n')));
    }

    return messages.length > 0 ? messages : [this.buildPlainMessagePayload('No commands available.')];
  }

  buildUserCostListMessage(users) {
    const userList = Array.isArray(users) ? users : [];

    if (userList.length === 0) {
      return '• 👤 Users with email\n  No users with email found.';
    }

    const usersWithCost = [];
    const usersWithoutCost = [];

    for (const user of userList) {
      const name = this.formatter.escapeMrkdwn(user.name || 'Unknown user');
      const email = this.formatter.escapeMrkdwn(user.email || 'Unknown email');
      const hasCost = user.cost !== null && user.cost !== undefined && String(user.cost).trim() !== '';

      const costText = hasCost ? this.formatter.formatCurrency(user.cost) : 'no cost set';
      const entry = `  - ${this.formatter.formatInlineCode(`${name} (${email}) - ${costText}`)}`;

      if (hasCost) {
        usersWithCost.push(entry);
      } else {
        usersWithoutCost.push(entry);
      }
    }

    const lines = [`• 👤 Users with email (${userList.length} total)`, ''];

    lines.push(`  Users with cost (${usersWithCost.length}):`);
    if (usersWithCost.length > 0) {
      lines.push(...usersWithCost);
    } else {
      lines.push('  - None');
    }

    lines.push('');
    lines.push(`  Users without cost (${usersWithoutCost.length}):`);
    if (usersWithoutCost.length > 0) {
      lines.push(...usersWithoutCost);
    } else {
      lines.push('  - None');
    }

    lines.push('');
    lines.push(`  Summary: ${usersWithCost.length} with cost, ${usersWithoutCost.length} without cost`);

    return lines.join('\n');
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

  getPublicBaseUrl() {
    const explicitBaseUrl = String(process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
    if (explicitBaseUrl) {
      return explicitBaseUrl;
    }

    const explicitStartUrl = String(process.env.FORTNOX_START_URL || '').trim().replace(/\/$/, '');
    if (explicitStartUrl) {
      return explicitStartUrl.replace(/\/auth\/fortnox\/start\/?$/, '');
    }

    const redirectUrl = String(process.env.FORTNOX_REDIRECT_URL || '').trim();
    if (redirectUrl) {
      const inferredBaseUrl = redirectUrl.replace(/\/auth\/fortnox\/callback\/?$/, '').replace(/\/auth\/fortnox\/start\/?$/, '');
      if (inferredBaseUrl) {
        return inferredBaseUrl;
      }
    }

    const railwayDomain =
      String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim() ||
      String(process.env.RAILWAY_STATIC_URL || '').trim() ||
      String(process.env.RAILWAY_DOMAIN || '').trim();

    if (railwayDomain) {
      return railwayDomain.startsWith('http://') || railwayDomain.startsWith('https://')
        ? railwayDomain.replace(/\/$/, '')
        : `https://${railwayDomain.replace(/\/$/, '')}`;
    }

    return null;
  }

  getFortnoxStartUrl(slackUserId) {
    const publicBaseUrl = this.getPublicBaseUrl();
    if (publicBaseUrl) {
      return `${publicBaseUrl}/auth/fortnox/start?slack_user_id=${encodeURIComponent(slackUserId)}`;
    }

    return null;
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

  async uploadExcelFile(client, channel, excelBuffer, filename, title, threadTs) {
    try {
      const response = await client.files.uploadV2({
        channel_id: channel,
        file: excelBuffer,
        filename,
        title,
        thread_ts: threadTs,
      });
      return response;
    } catch (error) {
      if (error.message && error.message.includes('missing_scope')) {
        throw new Error('Bot is missing files:write scope. Add the scope in Slack app settings and reinstall the app.');
      }

      this.logger.error('Failed to upload Excel file', {
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

  parseProjectCostInput(inputText) {
    const normalizedInput = String(inputText || '').trim();
    if (!normalizedInput) {
      return { projectInput: normalizedInput, yearNumber: null, monthNumber: null };
    }

    const inputParts = normalizedInput.split(/\s+/);
    const tryParseYearToken = (token) => {
      if (!/^\d{4}$/.test(token)) {
        return null;
      }

      const parsedYear = Number.parseInt(token, 10);
      return parsedYear >= 1900 && parsedYear <= 2100 ? parsedYear : null;
    };

    const tryParseMonthToken = (token) => {
      const parsedMonth = this.parseHistoricalMonth(token);
      if (!parsedMonth.ok || !parsedMonth.value) {
        return null;
      }

      const monthNumber = Number.parseInt(parsedMonth.value, 10);
      return Number.isInteger(monthNumber) && monthNumber >= 1 && monthNumber <= 12
        ? monthNumber
        : null;
    };

    const tryParseYearMonthPair = (firstToken, secondToken) => {
      const firstYear = tryParseYearToken(firstToken);
      const secondMonth = tryParseMonthToken(secondToken);
      if (firstYear && secondMonth) {
        return { yearNumber: firstYear, monthNumber: secondMonth };
      }

      const firstMonth = tryParseMonthToken(firstToken);
      const secondYear = tryParseYearToken(secondToken);
      if (firstMonth && secondYear) {
        return { yearNumber: secondYear, monthNumber: firstMonth };
      }

      return null;
    };

    if (inputParts.length >= 2) {
      const trailingPair = tryParseYearMonthPair(
        inputParts[inputParts.length - 2],
        inputParts[inputParts.length - 1]
      );
      if (trailingPair) {
        return {
          projectInput: inputParts.slice(0, -2).join(' ').trim(),
          yearNumber: trailingPair.yearNumber,
          monthNumber: trailingPair.monthNumber,
        };
      }

      const leadingPair = tryParseYearMonthPair(inputParts[0], inputParts[1]);
      if (leadingPair) {
        return {
          projectInput: inputParts.slice(2).join(' ').trim(),
          yearNumber: leadingPair.yearNumber,
          monthNumber: leadingPair.monthNumber,
        };
      }
    }

    if (inputParts.length < 2) {
      return { projectInput: normalizedInput, yearNumber: null, monthNumber: null };
    }

    const trailingYear = tryParseYearToken(inputParts[inputParts.length - 1]);
    if (trailingYear) {
      return {
        projectInput: inputParts.slice(0, -1).join(' ').trim(),
        yearNumber: trailingYear,
        monthNumber: null,
      };
    }

    const leadingYear = tryParseYearToken(inputParts[0]);
    if (leadingYear) {
      return {
        projectInput: inputParts.slice(1).join(' ').trim(),
        yearNumber: leadingYear,
        monthNumber: null,
      };
    }

    return { projectInput: normalizedInput, yearNumber: null, monthNumber: null };
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

  formatFortnoxInvoiceTestMessage(result) {
    const invoiceLabel = result.invoicesChecked === 1 ? 'invoice' : 'invoices';
    const matchedLabel = result.matchedCount === 1 ? 'invoice' : 'invoices';
    const projectNumber = result.projectNumber || result.projectKey;
    const lines = [
      `Fortnox invoice test for Jira key ${result.projectKey} / Fortnox project number ${projectNumber}`,
      result.userName ? `User: ${result.userName}` : null,
      `Checked ${result.invoicesChecked} ${invoiceLabel} across ${result.pagesFetched} page${result.pagesFetched === 1 ? '' : 's'}`,
      `Matched ${result.matchedCount} ${matchedLabel} where the invoice project field matched ${projectNumber}`,
      result.totalCost ? `*Total cost: ${result.totalCost.toLocaleString('sv-SE')} ${result.firstMatch?.currency || 'SEK'}*` : null,
    ].filter(Boolean);

    if (result.refreshedToken) {
      lines.push('Fortnox access token was refreshed during this lookup.');
    }

    if (!result.firstMatch) {
      lines.push('', 'No matching invoice found.', `Endpoint: ${result.invoiceEndpoint}`);
      return lines.join('\n');
    }

    lines.push('', 'First match:');
    lines.push(`- documentNumber: ${result.firstMatch.documentNumber ?? 'n/a'}`);
    lines.push(`- invoiceDate: ${result.firstMatch.invoiceDate ?? 'n/a'}`);
    lines.push(`- total: ${result.firstMatch.total ?? 'n/a'}`);
    lines.push(`- currency: ${result.firstMatch.currency ?? 'n/a'}`);
    lines.push(`- status: ${result.firstMatch.status ?? 'n/a'}`);
    lines.push(`- projectField: ${result.firstMatch.projectField ?? 'n/a'}`);

    if (Array.isArray(result.matchedInvoices) && result.matchedInvoices.length > 1) {
      const otherMatches = result.matchedInvoices.slice(1, 5).map((invoice, index) => {
        return `${index + 2}. ${invoice.documentNumber ?? 'n/a'} | ${invoice.invoiceDate ?? 'n/a'} | ${invoice.total ?? 'n/a'} | pr=${invoice.projectField ?? 'n/a'}`;
      });

      lines.push('', 'Other matches:', ...otherMatches);
    }

    lines.push('', `Endpoint: ${result.invoiceEndpoint}`);
    return lines.join('\n');
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

    this.logger.info('runReportingScript', {
      scriptCommand,
      scriptArgument,
      fullArgs: args,
      fullCommand: `${process.execPath} ${args.join(' ')}`,
      cwd: PROJECT_ROOT,
    });

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
            this.logger.error('runReportingScript ERROR', {
              error: error.message,
              errorCode: error.code,
              errorSignal: error.signal,
              killed: error.killed,
              stdoutLength: stdout?.length,
              stderrContent: stderr,
              scriptCommand,
            });
            reject({
              error,
              stdout,
              stderr,
              timeout: error.killed || error.signal === 'SIGTERM',
            });
            return;
          }

          this.logger.info('runReportingScript SUCCESS', {
            scriptCommand,
            stdoutLength: stdout?.length,
          });

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
    const inputText = this.sanitizeInput(parsed.commandText);

    const config = this.commandMap[parsed.commandName];
    if (!config) {
      logger.warn('Unknown text command received', {
        commandName: parsed.commandName,
        text: this.sanitizeInput(text),
      });

      await this.postSlackMessage(
        client,
        channel,
        this.buildPlainMessagePayload('❌ Unknown command. Here are the available commands:'),
        threadTs
      );

      const helpSections = this.roleAccessService.buildHelpSectionsByRole(userRole);
      const messages = this.buildHelpMessagesWithGrouping(helpSections, 10);
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

      await this.postSlackMessage(
        client,
        channel,
        this.buildPlainMessagePayload(`🔒 You do not have permission for \`${this.commandPrefix}${parsed.commandName}\`. Here are your available commands:`),
        threadTs
      );

      const helpSections = this.roleAccessService.buildHelpSectionsByRole(userRole);
      const messages = this.buildHelpMessagesWithGrouping(helpSections, 10);
      for (const message of messages) {
        await this.postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    if (parsed.commandName === 'help') {
      logger.info('Showing help for text command', { command: parsed.commandName });

      await this.postSlackMessage(
        client,
        channel,
        this.buildPlainMessagePayload(roleAwareHelpMessage),
        threadTs
      );
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

    if (config.customHandler === 'user-cost-list') {
      const users = await userRepository.listUsersWithEmailAndCost();
      const body = this.buildUserCostListMessage(users);
      const messages = this.buildSplitPlainMessages(body, { maxLinesPerMessage: 10 });

      for (const message of messages) {
        await this.postSlackMessage(client, channel, message, threadTs);
      }

      return true;
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

    if (config.customHandler === 'fortnox-login') {
      if (!slackUserId) {
        await this.postSlackMessage(
          client,
          channel,
          this.buildPlainMessagePayload('I could not identify your Slack account.'),
          threadTs
        );
        return true;
      }

      const loginUrl = this.getFortnoxStartUrl(slackUserId);
      if (!loginUrl) {
        await this.postSlackMessage(
          client,
          channel,
          this.buildPlainMessagePayload('Could not resolve a public URL for Fortnox login. Set APP_BASE_URL, FORTNOX_START_URL, FORTNOX_REDIRECT_URL, or a Railway public domain variable.'),
          threadTs
        );
        return true;
      }

      const body = `Open Fortnox login here: <${loginUrl}|Connect Fortnox>`;
      await this.postSlackMessage(client, channel, this.buildPlainMessagePayload(body), threadTs);
      return true;
    }

    if (config.customHandler === 'fortnox-invoice-test') {
      if (!slackUserId) {
        await this.postSlackMessage(
          client,
          channel,
          this.buildPlainMessagePayload('I could not identify your Slack account.'),
          threadTs
        );
        return true;
      }

      if (!inputText) {
        await this.postSlackMessage(
          client,
          channel,
          this.buildPlainMessagePayload(`ℹ️ Missing required input.\nUsage: \`${config.usage}\``),
          threadTs
        );
        return true;
      }

      const resolution = await this.resolveProjectKey(inputText);
      if (!resolution) {
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

      if (resolution.matchedBy === 'multiple') {
        const options = this.formatProjectOptions(resolution.candidates);
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

      try {
        const result = await fortnoxInvoiceService.testFortnoxInvoiceLookup({
          slackUserId,
          projectKey: resolution.projectKey,
          logger,
        });

        const body = this.formatFortnoxInvoiceTestMessage(result);
        await this.postSlackMessage(client, channel, this.buildPlainMessagePayload(body), threadTs);
        return true;
      } catch (error) {
        logger.error('Fortnox invoice test failed', {
          error: error.message,
          code: error.code,
          slackUserId,
          projectKey: resolution.projectKey,
        });

        const message = error.code === 'FORTNOX_NOT_CONNECTED'
          ? 'Fortnox is not connected for this user. Run fortnox login first.'
          : `Fortnox invoice test failed: ${error.message || 'unknown error'}`;

        await this.postSlackMessage(
          client,
          channel,
          this.buildPlainMessagePayload(message),
          threadTs
        );
        return true;
      }
    }

    let scriptArgument = inputText || undefined;
    let projectInputForResolution = inputText;

    if (config.requiresText && !inputText) {
      await this.postSlackMessage(
        client,
        channel,
        this.buildPlainMessagePayload(`ℹ️ Missing required input.\nUsage: \`${config.usage}\``),
        threadTs
      );

      const helpSections = this.roleAccessService.buildHelpSectionsByRole(userRole);
      const messages = this.buildHelpMessagesWithGrouping(helpSections, 10);
      for (const message of messages) {
        await this.postSlackMessage(client, channel, message, threadTs);
      }
      return true;
    }

    // Special handling for 'project cost total' - parse year/month but skip project resolution
    if (parsed.commandName === 'project cost total') {
      const parsedTotalCostInput = this.parseProjectCostInput(inputText);
      const yearNumber = parsedTotalCostInput?.yearNumber;
      const monthNumber = parsedTotalCostInput?.monthNumber;

      if (yearNumber && monthNumber) {
        scriptArgument = ['total', String(yearNumber), String(monthNumber)];
      } else if (yearNumber) {
        scriptArgument = ['total', String(yearNumber)];
      } else {
        scriptArgument = 'total';
      }
    } else if (
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
      const parsedProjectCostInput = parsed.commandName === 'project cost'
        ? this.parseProjectCostInput(inputText)
        : null;

      const projectInputCandidates = [
        parsedProjectCostInput?.projectInput || projectInputForResolution,
      ];
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
        } else {
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
      }

      if (resolvedProject) {
        scriptArgument = resolvedProject.projectKey;

        if (parsed.commandName === 'project cost') {
          const yearNumber =
            parsedProjectCostInput &&
            parsedProjectCostInput.projectInput === resolvedFromInput
              ? parsedProjectCostInput.yearNumber
              : null;
          const monthNumber =
            parsedProjectCostInput &&
            parsedProjectCostInput.projectInput === resolvedFromInput
              ? parsedProjectCostInput.monthNumber
              : null;

          if (yearNumber && monthNumber) {
            scriptArgument = [resolvedProject.projectKey, String(yearNumber), String(monthNumber)];
          } else if (yearNumber) {
            scriptArgument = [resolvedProject.projectKey, String(yearNumber)];
          }
        }

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
      scriptArgumentDebug: Array.isArray(scriptArgument) ? scriptArgument : `string: ${scriptArgument}`,
    });

    // Extra debug logging for project cost total
    if (parsed.commandName === 'project cost total') {
      logger.info('PROJECT_COST_TOTAL_DEBUG', {
        commandName: parsed.commandName,
        inputText,
        scriptCommand: config.scriptCommand,
        scriptArgument,
        scriptArgumentType: Array.isArray(scriptArgument) ? 'array' : typeof scriptArgument,
      });
    }

    const isReportCommand = [
      'report w',
      'report m',
      'report wt',
      'report mt',
    ].includes(parsed.commandName);

    const isTeamReportCommand = ['report wt', 'report mt'].includes(parsed.commandName);

    try {
      const result = await this.runReportingScript(config.scriptCommand, scriptArgument);

      if (parsed.commandName === 'project cost total') {
        try {
          const reportData = this.formatter.extractJsonPayload(result.stdout);
          if (!Array.isArray(reportData) || reportData.length === 0) {
            await this.postSlackMessage(
              client,
              channel,
              this.buildPlainMessagePayload('The report could not be converted to Excel. Please try again later.'),
              threadTs
            );
            return true;
          }

          const excelBuffer = await this.excelReportService.buildProjectCostTotalWorkbook(reportData);
          const periodLabel = reportData[0]?.period?.label ? `-${reportData[0].period.label}` : '';
          const filename = `project-cost-total${periodLabel}-${Date.now()}.xlsx`;
          const title = `Project cost total${reportData[0]?.period?.label ? ` - ${reportData[0].period.label}` : ''}`;

          await this.uploadExcelFile(client, channel, excelBuffer, filename, title, threadTs);
          return true;
        } catch (excelError) {
          logger.warn('Excel generation/upload failed', {
            error: excelError.message,
          });

          await this.postSlackMessage(
            client,
            channel,
            this.buildPlainMessagePayload('Excel upload failed. Please try again later.'),
            threadTs
          );
          return true;
        }
      }

      if (parsed.commandName === 'project cost') {
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

        try {
          const reportData = this.formatter.extractJsonPayload(result.stdout);
          if (!reportData || typeof reportData !== 'object' || Array.isArray(reportData)) {
            await this.postSlackMessage(
              client,
              channel,
              this.buildPlainMessagePayload('The report could not be converted to Excel. Please try again later.'),
              threadTs
            );
            return true;
          }

          const excelBuffer = await this.excelReportService.buildProjectCostWorkbook(reportData);
          const safeProjectKey = String(reportData.projectKey || 'project')
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-');
          const periodLabel = reportData.period?.label
            ? `-${String(reportData.period.label).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`
            : '';
          const filename = `project-cost-${safeProjectKey}${periodLabel}-${Date.now()}.xlsx`;
          const title = `Project cost${reportData.projectName ? ` - ${reportData.projectName}` : ''}${reportData.period?.label ? ` (${reportData.period.label})` : ''}`;

          await this.uploadExcelFile(client, channel, excelBuffer, filename, title, threadTs);
          return true;
        } catch (excelError) {
          logger.warn('Project cost Excel generation/upload failed', {
            error: excelError.message,
          });

          await this.postSlackMessage(
            client,
            channel,
            this.buildPlainMessagePayload('Excel upload failed. Please try again later.'),
            threadTs
          );
          return true;
        }
      }

      // Special handling for forecast command: post text output, then generate chart
      if (parsed.commandName === 'forecast') {
        const stdout = this.formatter.clipText(this.formatter.formatCommandOutput(parsed.commandName, result.stdout));
        const stderrRaw = String(result.stderr || '').trim();
        const stderr = stderrRaw ? this.formatter.clipText(this.formatter.formatPlainLinesAsBullets(stderrRaw)) : '';

        // Post text output first
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

        // Then generate and post chart
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

            if (imageUrl) {
              const blocks = [];
              blocks.push({ type: 'image', image_url: imageUrl, alt_text: 'Forecast chart' });
              await this.postSlackMessage(client, channel, { blocks }, threadTs);
            }
          }
        } catch (err) {
          this.logger.warn('Forecast chart generation/upload failed', { error: err.message });
        }

        return true;
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
