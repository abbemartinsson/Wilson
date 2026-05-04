class SlackBotConfig {
  constructor() {
    this.useSocketMode = process.env.SLACK_SOCKET_MODE !== 'false';
    this.restartDelayMs = Number.parseInt(process.env.SLACK_SOCKET_RESTART_DELAY_MS, 10) || 3000;
    this.replyInThread = process.env.SLACK_REPLY_IN_THREAD === 'true';
    this.enableDmRouter = process.env.SLACK_ENABLE_DM_ROUTER === 'true';
    this.enableTimesheetReminders = process.env.ENABLE_TIMESHEET_REMINDERS === 'true';
    this.reminderScheduleTime = process.env.TIMESHEET_REMINDER_TIME || '09:00';
    this.maxConversationMessages = Number.parseInt(process.env.SLACK_ROUTER_MAX_MESSAGES, 10) || 20;

    // OAuth
    this.enableOAuth = process.env.SLACK_ENABLE_OAUTH === 'true';
    this.oauthRedirectUri = process.env.SLACK_OAUTH_REDIRECT_URI || 'http://localhost:3000/slack/oauth_redirect';
  }

  validateSocketMode() {
    if (this.useSocketMode && !process.env.SLACK_APP_TOKEN) {
      throw new Error('SLACK_APP_TOKEN is missing. Enable Socket Mode in Slack and add the token to .env');
    }
  }

  validateOAuth() {
    if (this.enableOAuth) {
      if (!process.env.SLACK_CLIENT_ID) {
        throw new Error('SLACK_CLIENT_ID is required when OAuth is enabled');
      }
      if (!process.env.SLACK_CLIENT_SECRET) {
        throw new Error('SLACK_CLIENT_SECRET is required when OAuth is enabled');
      }
    }
  }
}

module.exports = SlackBotConfig;
