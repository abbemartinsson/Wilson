class SlackBotConfig {
  constructor() {
    this.useSocketMode = process.env.SLACK_SOCKET_MODE !== 'false';
    this.restartDelayMs = Number.parseInt(process.env.SLACK_SOCKET_RESTART_DELAY_MS, 10) || 3000;
    this.replyInThread = process.env.SLACK_REPLY_IN_THREAD === 'true';
    this.enableDmRouter = process.env.SLACK_ENABLE_DM_ROUTER === 'true';
    this.enableTimesheetReminders = process.env.ENABLE_TIMESHEET_REMINDERS === 'true';
    this.reminderScheduleTime = process.env.TIMESHEET_REMINDER_TIME || '09:00';
    this.maxConversationMessages = Number.parseInt(process.env.SLACK_ROUTER_MAX_MESSAGES, 10) || 20;
  }

  validateSocketMode() {
    if (this.useSocketMode && !process.env.SLACK_APP_TOKEN) {
      throw new Error('SLACK_APP_TOKEN is missing. Enable Socket Mode in Slack and add the token to .env');
    }
  }
}

module.exports = SlackBotConfig;
