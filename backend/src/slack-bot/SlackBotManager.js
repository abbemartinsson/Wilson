const { App } = require('@slack/bolt');

class SlackBotManager {
  constructor({ config, logger = console }) {
    this.config = config;
    this.logger = logger;
    this.app = new App({
      token: process.env.SLACK_BOT_TOKEN,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      socketMode: config.useSocketMode,
      appToken: process.env.SLACK_APP_TOKEN,
    });
    this.isStarting = false;
    this.isRunning = false;
    this.restartTimer = null;
  }

  getApp() {
    return this.app;
  }

  isSocketEofError(error) {
    if (!error) return false;

    const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
    const syscall = typeof error.syscall === 'string' ? error.syscall.toLowerCase() : '';
    const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';

    return code === 'EOF' || syscall === 'write' || message.includes('write eof');
  }

  async start() {
    if (this.isStarting || this.isRunning) return;
    this.isStarting = true;

    try {
      if (this.config.useSocketMode) {
        await this.app.start();
        this.isRunning = true;
        this.logger.log('Slack bot kör i Socket Mode (ingen ngrok behövs)');
      } else {
        await this.app.start(process.env.PORT || 3000);
        this.isRunning = true;
        this.logger.log(`Slack bot kör på port ${process.env.PORT || 3000}`);
      }

      this.logger.log('Python chatbot-router is enabled for Slack replies.');
    } finally {
      this.isStarting = false;
    }
  }

  async stop() {
    if (this.isRunning) {
      await this.app.stop();
      this.isRunning = false;
    }
  }

  scheduleRestart(reason) {
    if (!this.config.useSocketMode) return;
    if (this.restartTimer) return;

    this.logger.warn(
      `Socket problem upptäckt (${reason}). Försöker återansluta om ${this.config.restartDelayMs} ms...`
    );

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;

      try {
        if (this.isRunning) {
          await this.stop();
        }
      } catch (stopError) {
        this.logger.error('Kunde inte stoppa Slack-app innan restart:', stopError.message);
      } finally {
        this.isRunning = false;
      }

      try {
        await this.start();
      } catch (startError) {
        this.logger.error('Återanslutning misslyckades:', startError);
        this.scheduleRestart('retry');
      }
    }, this.config.restartDelayMs);
  }

  clearRestartTimer() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }
}

module.exports = SlackBotManager;
