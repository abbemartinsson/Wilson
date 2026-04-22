const SlackBotManager = require('./SlackBotManager');
const MessageEventHandler = require('./MessageEventHandler');
const TimesheetReminderScheduler = require('./TimesheetReminderScheduler');
const SlackBotConfig = require('./SlackBotConfig');

class SlackBot {
  constructor({ slackCommands, logger = console }) {
    this.config = new SlackBotConfig();
    this.botManager = new SlackBotManager({ config: this.config, logger });
    this.messageHandler = new MessageEventHandler({ config: this.config, slackCommands, logger });
    this.reminderScheduler = new TimesheetReminderScheduler({ config: this.config, logger });
    this.logger = logger;
  }

  setupMessageListener() {
    const app = this.botManager.getApp();

    app.message(async ({ event, client }) => {
      await this.messageHandler.handleMessage(event, client, this.onTimesheetReminderSetup.bind(this));
    });
  }

  setupErrorHandlers() {
    const app = this.botManager.getApp();

    app.error(async (error) => {
      this.logger.error('Slack Bolt error:', error);
    });

    process.on('uncaughtException', (error) => {
      if (this.botManager.isSocketEofError(error)) {
        this.logger.warn('Fångade socket EOF-fel, boten försöker återansluta utan att avsluta processen.');
        this.botManager.scheduleRestart('uncaughtException/EOF');
        return;
      }

      this.logger.error('Okänt okontrollerat fel:', error);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      if (this.botManager.isSocketEofError(reason)) {
        this.logger.warn('Fångade socket EOF-rejection, boten försöker återansluta.');
        this.botManager.scheduleRestart('unhandledRejection/EOF');
        return;
      }

      this.logger.error('Unhandled rejection:', reason);
    });
  }

  async onTimesheetReminderSetup(client) {
    this.reminderScheduler.stop();
    this.reminderScheduler.start(client);
  }

  async initialize() {
    this.config.validateSocketMode();
    this.setupMessageListener();
    this.setupErrorHandlers();
  }

  async start() {
    await this.botManager.start();
    this.reminderScheduler.start(this.botManager.getApp().client);
  }

  async stop() {
    this.reminderScheduler.stop();
    this.botManager.clearRestartTimer();
    await this.botManager.stop();
  }
}

module.exports = SlackBot;
