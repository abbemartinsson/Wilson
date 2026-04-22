const timesheetReminderService = require('../services/timesheetReminderService');

class TimesheetReminderScheduler {
  constructor({ config, logger = console }) {
    this.config = config;
    this.logger = logger;
    this.reminderSchedulerTimer = null;
    this.lastReminderMinuteKey = null;
  }

  getReminderMinuteKey(referenceDate = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timesheetReminderService.TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const parts = formatter.formatToParts(referenceDate);
    const mapped = {};
    for (const part of parts) {
      if (part.type !== 'literal') {
        mapped[part.type] = part.value;
      }
    }

    return `${mapped.year}-${mapped.month}-${mapped.day} ${mapped.hour}:${mapped.minute}`;
  }

  /**
   * Calculate milliseconds until the reminder check window starts.
   * Window is Monday/Friday 08:55-09:01.
   */
  getMillisecondsUntilNextCheckWindow(referenceDate = new Date()) {
    const clock = timesheetReminderService.getDateTimePartsInTimeZone(referenceDate, timesheetReminderService.TIME_ZONE);
    const expected = timesheetReminderService.parseReminderTime(this.config.reminderScheduleTime);

    // Window start: 5 minutes before scheduled time
    const windowStartMinutes = ((expected.hour * 60) + expected.minute) - 5;
    const windowStartHour = Math.floor(windowStartMinutes / 60);
    const windowStartMin = windowStartMinutes % 60;

    // Get current weekday
    let weekday = clock.weekday.toLowerCase();
    let daysUntilNextWindow = 0;

    if (weekday === 'monday' || weekday === 'friday') {
      // Today is Mon or Fri, check if window is still ahead
      const nowMinutes = (clock.hour * 60) + clock.minute;
      const windowEndMinutes = ((expected.hour * 60) + expected.minute) + 1;

      if (nowMinutes < windowStartMinutes) {
        // Window hasn't started yet today
        daysUntilNextWindow = 0;
      } else if (nowMinutes <= windowEndMinutes) {
        // We're in the window right now - check again in 1 minute
        return 60 * 1000;
      } else {
        // Window already passed today, schedule for next Mon/Fri
        daysUntilNextWindow = weekday === 'monday' ? 4 : 3; // Mon->Fri=4 days, Fri->Mon=3 days
      }
    } else {
      // Today is not Mon/Fri, find next Mon or Fri
      const dayMap = { sunday: 1, tuesday: 6, wednesday: 5, thursday: 4, saturday: 2 };
      daysUntilNextWindow = dayMap[weekday] || 0;
    }

    // Build target time in Stockholm timezone
    const targetDate = new Date(referenceDate.getTime() + (daysUntilNextWindow * 24 * 60 * 60 * 1000));
    const targetTz = timesheetReminderService.getDateTimePartsInTimeZone(targetDate, timesheetReminderService.TIME_ZONE);

    // Create a date for the target day at window start time
    const year = targetTz.year;
    const month = targetTz.month - 1;
    const day = targetTz.day;

    // Create UTC date by calculating the offset
    const testDate = new Date(year, month, day, windowStartHour, windowStartMin, 0);
    const testFormatted = new Intl.DateTimeFormat('en-CA', {
      timeZone: timesheetReminderService.TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(testDate);

    const [testYear, testMonth, testDay] = testFormatted.split('-').map(Number);
    const offset = new Date(testYear, testMonth - 1, testDay).getTime() - new Date(year, month, day).getTime();

    const targetUTC = new Date(testDate.getTime() - offset + (windowStartHour * 60 * 60 * 1000) + (windowStartMin * 60 * 1000));
    const msUntilWindow = Math.max(60 * 1000, targetUTC.getTime() - referenceDate.getTime());

    return msUntilWindow;
  }

  async checkScheduledReminders(client) {
    const now = new Date();

    if (!timesheetReminderService.isWithinReminderCheckWindow(now, this.config.reminderScheduleTime)) {
      return;
    }

    const minuteKey = this.getReminderMinuteKey(now);
    if (minuteKey === this.lastReminderMinuteKey) {
      return;
    }

    this.lastReminderMinuteKey = minuteKey;

    try {
      const result = await timesheetReminderService.sendDueTimesheetReminders({
        client,
        referenceDate: now,
        logger: this.logger,
      });

      this.logger.log('Timesheet reminders checked:', result);
    } catch (error) {
      this.logger.error('Failed to run timesheet reminders:', error.message || error);
    }
  }

  start(client) {
    if (!this.config.enableTimesheetReminders) {
      this.logger.log('Timesheet reminders are disabled (ENABLE_TIMESHEET_REMINDERS=false).');
      return;
    }

    if (this.reminderSchedulerTimer) {
      return;
    }

    this.logger.log(
      `Timesheet reminder scheduler started (${timesheetReminderService.TIME_ZONE}, ${this.config.reminderScheduleTime}). Checks every minute between 08:55-09:01 on Monday/Friday.`
    );

    const scheduleNextCheck = async () => {
      try {
        await this.checkScheduledReminders(client);
      } catch (error) {
        this.logger.error('Error in scheduled timesheet check:', error.message || error);
      }

      // Calculate delay until next check (within window) or until next window
      const now = new Date();
      const isInWindow = timesheetReminderService.isWithinReminderCheckWindow(now, this.config.reminderScheduleTime);

      let nextCheckMs;
      if (isInWindow) {
        // In window: check every 1 minute
        nextCheckMs = 60 * 1000;
      } else {
        // Not in window: wait until next window starts
        nextCheckMs = this.getMillisecondsUntilNextCheckWindow(now) || (60 * 1000);
      }

      // Add small random jitter to avoid thundering herd
      nextCheckMs += Math.random() * 5000;

      this.reminderSchedulerTimer = setTimeout(() => {
        this.reminderSchedulerTimer = null;
        void scheduleNextCheck();
      }, nextCheckMs);
    };

    void scheduleNextCheck();
  }

  stop() {
    if (this.reminderSchedulerTimer) {
      clearTimeout(this.reminderSchedulerTimer);
      this.reminderSchedulerTimer = null;
    }
  }
}

module.exports = TimesheetReminderScheduler;
