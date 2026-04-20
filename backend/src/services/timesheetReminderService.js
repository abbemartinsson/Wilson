const analyticsRepository = require('../repositories/analyticsRepository');
const userRepository = require('../repositories/userRepository');

const TIME_ZONE = process.env.TIMESHEET_TIMEZONE || process.env.TIMEZONE || 'Europe/Stockholm';
const DEFAULT_REMINDER_TIME = process.env.TIMESHEET_REMINDER_TIME || '09:00';

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

function roundToTwoDecimals(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function getDatePartsInTimeZone(date, timeZone = TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const mapped = {};
  for (const part of parts) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      mapped[part.type] = Number.parseInt(part.value, 10);
    }
  }

  return {
    year: mapped.year,
    month: mapped.month,
    day: mapped.day,
  };
}

function getDateTimePartsInTimeZone(date, timeZone = TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'long',
  });

  const parts = formatter.formatToParts(date);
  const mapped = {};
  for (const part of parts) {
    if (part.type === 'literal') {
      continue;
    }
    mapped[part.type] = part.value;
  }

  return {
    weekday: String(mapped.weekday || '').toLowerCase(),
    year: Number.parseInt(mapped.year, 10),
    month: Number.parseInt(mapped.month, 10),
    day: Number.parseInt(mapped.day, 10),
    hour: Number.parseInt(mapped.hour, 10),
    minute: Number.parseInt(mapped.minute, 10),
    second: Number.parseInt(mapped.second, 10),
  };
}

function formatDateParts(parts) {
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

function addUtcDays(date, days) {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function getTimeZoneOffset(date, timeZone = TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  const asUtc = Date.UTC(
    Number.parseInt(values.year, 10),
    Number.parseInt(values.month, 10) - 1,
    Number.parseInt(values.day, 10),
    Number.parseInt(values.hour, 10),
    Number.parseInt(values.minute, 10),
    Number.parseInt(values.second, 10)
  );

  return asUtc - date.getTime();
}

function zonedTimeToUtc(dateParts, hour, minute, second, timeZone = TIME_ZONE) {
  const utcGuess = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, hour, minute, second));
  const offset = getTimeZoneOffset(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offset);
}

function getStockholmDateKey(date = new Date()) {
  return formatDateParts(getDatePartsInTimeZone(date, TIME_ZONE));
}

function getStockholmWeekday(date = new Date()) {
  return getDateTimePartsInTimeZone(date, TIME_ZONE).weekday;
}

function parseReminderTime(reminderTime = DEFAULT_REMINDER_TIME) {
  const normalized = String(reminderTime || '').trim();
  const match = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return { hour: 9, minute: 0 };
  }

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);

  return {
    hour: Number.isNaN(hour) ? 9 : hour,
    minute: Number.isNaN(minute) ? 0 : minute,
  };
}

function isReminderModeActive(mode) {
  return ['monday', 'friday', 'both'].includes(String(mode || '').toLowerCase());
}

function isReminderDueToday(mode, referenceDate = new Date()) {
  const weekday = getStockholmWeekday(referenceDate);
  const normalizedMode = String(mode || '').toLowerCase();

  if (normalizedMode === 'both') {
    return weekday === 'monday' || weekday === 'friday';
  }

  if (normalizedMode === 'monday') {
    return weekday === 'monday';
  }

  if (normalizedMode === 'friday') {
    return weekday === 'friday';
  }

  return false;
}

function isReminderRunDue(referenceDate = new Date(), reminderTime = DEFAULT_REMINDER_TIME) {
  const clock = getDateTimePartsInTimeZone(referenceDate, TIME_ZONE);
  const expected = parseReminderTime(reminderTime);
  const nowMinutes = (clock.hour * 60) + clock.minute;
  const scheduledMinutes = (expected.hour * 60) + expected.minute;

  return isReminderDueToday('both', referenceDate) && nowMinutes >= scheduledMinutes;
}

/**
 * Check if current time is within the reminder check window (5 minutes before to 1 minute after 09:00).
 * Window: 08:55 - 09:01 on Monday or Friday
 */
function isWithinReminderCheckWindow(referenceDate = new Date(), reminderTime = DEFAULT_REMINDER_TIME) {
  // Only check on Monday or Friday
  if (!isReminderDueToday('both', referenceDate)) {
    return false;
  }

  const clock = getDateTimePartsInTimeZone(referenceDate, TIME_ZONE);
  const expected = parseReminderTime(reminderTime);

  // Calculate window boundaries: (reminderTime - 5 minutes) to (reminderTime + 1 minute)
  const windowStartMinutes = ((expected.hour * 60) + expected.minute) - 5;
  const windowEndMinutes = ((expected.hour * 60) + expected.minute) + 1;
  const nowMinutes = (clock.hour * 60) + clock.minute;

  return nowMinutes >= windowStartMinutes && nowMinutes <= windowEndMinutes;
}

function getPreviousWeekRangeInStockholm(referenceDate = new Date()) {
  const stockholmToday = getDatePartsInTimeZone(referenceDate, TIME_ZONE);
  const stockholmTodayDate = new Date(Date.UTC(stockholmToday.year, stockholmToday.month - 1, stockholmToday.day));

  const dayOfWeek = stockholmTodayDate.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;

  const mondayThisWeek = addUtcDays(stockholmTodayDate, -daysSinceMonday);
  const mondayLastWeek = addUtcDays(mondayThisWeek, -7);
  const sundayLastWeek = addUtcDays(mondayLastWeek, 6);

  const mondayParts = {
    year: mondayLastWeek.getUTCFullYear(),
    month: mondayLastWeek.getUTCMonth() + 1,
    day: mondayLastWeek.getUTCDate(),
  };
  const sundayParts = {
    year: sundayLastWeek.getUTCFullYear(),
    month: sundayLastWeek.getUTCMonth() + 1,
    day: sundayLastWeek.getUTCDate(),
  };

  return {
    startDate: formatDateParts(mondayParts),
    endDate: formatDateParts(sundayParts),
    startDateUtc: zonedTimeToUtc(mondayParts, 0, 0, 0, TIME_ZONE),
    endDateUtc: zonedTimeToUtc(sundayParts, 23, 59, 59, TIME_ZONE),
  };
}

function getCurrentWeekRangeInStockholm(referenceDate = new Date()) {
  const stockholmToday = getDatePartsInTimeZone(referenceDate, TIME_ZONE);
  const stockholmTodayDate = new Date(Date.UTC(stockholmToday.year, stockholmToday.month - 1, stockholmToday.day));

  const dayOfWeek = stockholmTodayDate.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;

  const mondayThisWeek = addUtcDays(stockholmTodayDate, -daysSinceMonday);
  const mondayParts = {
    year: mondayThisWeek.getUTCFullYear(),
    month: mondayThisWeek.getUTCMonth() + 1,
    day: mondayThisWeek.getUTCDate(),
  };

  return {
    startDate: formatDateParts(mondayParts),
    startDateUtc: zonedTimeToUtc(mondayParts, 0, 0, 0, TIME_ZONE),
    endDateUtc: referenceDate,
  };
}

function getCurrentMonthRangeInStockholm(referenceDate = new Date()) {
  const stockholmToday = getDatePartsInTimeZone(referenceDate, TIME_ZONE);
  const firstDayParts = {
    year: stockholmToday.year,
    month: stockholmToday.month,
    day: 1,
  };

  return {
    startDate: formatDateParts(firstDayParts),
    startDateUtc: zonedTimeToUtc(firstDayParts, 0, 0, 0, TIME_ZONE),
    endDateUtc: referenceDate,
  };
}

function secondsToHours(totalSeconds) {
  return roundToTwoDecimals((Number(totalSeconds) || 0) / 3600);
}

function secondsToHoursAndMinutes(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds || 0));
  return {
    hours: Math.floor(safeSeconds / 3600),
    minutes: Math.floor((safeSeconds % 3600) / 60),
  };
}

function formatFriendlyDateTime(value) {
  if (!value) {
    return 'never';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function formatReminderMode(mode) {
  const normalized = String(mode || 'off').toLowerCase();
  if (normalized === 'monday') return 'Monday';
  if (normalized === 'friday') return 'Friday';
  if (normalized === 'both') return 'Monday + Friday';
  return 'Off';
}

function formatTargetHours(user) {
  if (user?.capacity_hours_per_week === null || user?.capacity_hours_per_week === undefined) {
    return 'not set';
  }

  return `${formatNumber(user.capacity_hours_per_week)}h/week`;
}

function buildReminderSetupPrompt() {
  return [
    'Choose a reminder mode: monday, friday, both, or off.',
    'If you choose monday, friday, or both, I will ask for your weekly target hours next.',
    'Weekly target hours must be a whole number, for example 40.',
  ].join('\n');
}

function buildReminderStatusMessage(user) {
  if (!user) {
    return 'No reminder profile found for this Slack account.';
  }

  return [
    `• ⏰ Timesheet reminder status`,
    `  - Mode: ${formatReminderMode(user.timesheet_reminder_mode)}`,
    `  - Weekly target: ${formatTargetHours(user)}`,
    `  - Last reminder sent: ${formatFriendlyDateTime(user.last_timesheet_reminder_sent_at)}`,
  ].join('\n');
}

function buildCurrentHoursMessage(summary) {
  if (!summary) {
    return 'No timesheet data found for this Slack account.';
  }

  return [
    `• 📊 Timesheet overview`,
    `  - This week: ${formatNumber(summary.weekHoursToDate)}h logged`,
    `  - This month: ${formatNumber(summary.monthHoursToDate)}h logged`,
    summary.targetHours !== null && summary.targetHours !== undefined
      ? `  - Weekly target: ${formatNumber(summary.targetHours)}h`
      : '  - Weekly target: not set',
  ].join('\n');
}

function buildReminderMessage(summary) {
  if (!summary) {
    return 'No timesheet data found for this Slack account.';
  }

  const targetHours = summary.targetHours !== null && summary.targetHours !== undefined
    ? `${formatNumber(summary.reportedHours)}/${formatNumber(summary.targetHours)} hours`
    : `${formatNumber(summary.reportedHours)} hours`;
  const missingSentence = summary.missingDaysCount === 0
    ? 'All days have time reported.'
    : `${summary.missingDaysCount === 1 ? 'One day has' : `${summary.missingDaysCount} days have`} no time reported at all.`;

  return [
    `You have reported ${targetHours} from the previous week. ${missingSentence}`,
    'Do you want to do that now?',
  ].join(' ');
}

async function getUserReminderStatusBySlackAccountId(slackAccountId) {
  if (!slackAccountId) {
    return null;
  }

  const user = await userRepository.findUserBySlackAccountId(slackAccountId);
  if (!user) {
    return null;
  }

  return user;
}

async function getUserTimesheetSummaryByUserId(userId, referenceDate = new Date()) {
  if (!userId) {
    return null;
  }

  const user = await getUserById(userId);
  if (!user) {
    return null;
  }

  const previousWeekRange = getPreviousWeekRangeInStockholm(referenceDate);
  const currentWeekRange = getCurrentWeekRangeInStockholm(referenceDate);
  const currentMonthRange = getCurrentMonthRangeInStockholm(referenceDate);

  const [previousWeekWorklogs, currentWeekWorklogs, currentMonthWorklogs] = await Promise.all([
    analyticsRepository.getAllWorklogsForForecast({
      userId,
      startDate: previousWeekRange.startDateUtc,
      endDate: previousWeekRange.endDateUtc,
    }),
    analyticsRepository.getAllWorklogsForForecast({
      userId,
      startDate: currentWeekRange.startDateUtc,
      endDate: currentWeekRange.endDateUtc,
    }),
    analyticsRepository.getAllWorklogsForForecast({
      userId,
      startDate: currentMonthRange.startDateUtc,
      endDate: currentMonthRange.endDateUtc,
    }),
  ]);

  const reportedSeconds = previousWeekWorklogs.reduce((sum, worklog) => sum + (worklog.time_spent_seconds || 0), 0);
  const weekSeconds = currentWeekWorklogs.reduce((sum, worklog) => sum + (worklog.time_spent_seconds || 0), 0);
  const monthSeconds = currentMonthWorklogs.reduce((sum, worklog) => sum + (worklog.time_spent_seconds || 0), 0);

  const dayTotals = new Map();
  for (const worklog of previousWeekWorklogs) {
    const dayKey = getStockholmDateKey(new Date(worklog.started_at));
    dayTotals.set(dayKey, (dayTotals.get(dayKey) || 0) + (worklog.time_spent_seconds || 0));
  }

  const missingDays = [];
  let currentDate = new Date(previousWeekRange.startDateUtc.getTime());
  for (let index = 0; index < 7; index += 1) {
    const dateKey = getStockholmDateKey(currentDate);

    if (!dayTotals.has(dateKey) || dayTotals.get(dateKey) === 0) {
      missingDays.push(dateKey);
    }

    currentDate = addUtcDays(currentDate, 1);
  }

  return {
    user,
    reportedHours: secondsToHours(reportedSeconds),
    targetHours: user.capacity_hours_per_week ?? null,
    missingDaysCount: missingDays.length,
    missingDays,
    weekHoursToDate: secondsToHours(weekSeconds),
    monthHoursToDate: secondsToHours(monthSeconds),
    period: {
      timeZone: TIME_ZONE,
      previousWeek: {
        startDate: previousWeekRange.startDate,
        endDate: previousWeekRange.endDate,
      },
      currentWeek: {
        startDate: currentWeekRange.startDate,
      },
      currentMonth: {
        startDate: currentMonthRange.startDate,
      },
    },
  };
}

async function getUserTimesheetSummaryBySlackAccountId(slackAccountId, referenceDate = new Date()) {
  const user = await getUserReminderStatusBySlackAccountId(slackAccountId);
  if (!user) {
    return null;
  }

  return getUserTimesheetSummaryByUserId(user.id, referenceDate);
}

async function setTimesheetReminderPreferencesBySlackAccountId(slackAccountId, updates = {}) {
  if (!slackAccountId) {
    return null;
  }

  return userRepository.updateTimesheetReminderPreferencesBySlackAccountId(slackAccountId, updates);
}

async function sendDueTimesheetReminders({ client, referenceDate = new Date(), logger = console } = {}) {
  if (!client?.chat?.postMessage) {
    throw new Error('Slack client is required to send timesheet reminders');
  }

  const users = await userRepository.listUsersWithTimesheetReminders();
  const sentUsers = [];
  const skippedUsers = [];

  for (const user of users) {
    try {
      if (!isReminderDueToday(user.timesheet_reminder_mode, referenceDate)) {
        skippedUsers.push({ userId: user.id, reason: 'not due today' });
        continue;
      }

      const summary = await getUserTimesheetSummaryByUserId(user.id, referenceDate);
      if (!summary) {
        skippedUsers.push({ userId: user.id, reason: 'no summary' });
        continue;
      }

      const lastSentAt = user.last_timesheet_reminder_sent_at ? new Date(user.last_timesheet_reminder_sent_at) : null;
      if (lastSentAt && !Number.isNaN(lastSentAt.getTime())) {
        const lastSentKey = getStockholmDateKey(lastSentAt);
        const todayKey = getStockholmDateKey(referenceDate);
        if (lastSentKey === todayKey) {
          skippedUsers.push({ userId: user.id, reason: 'already sent today' });
          continue;
        }
      }

      await client.chat.postMessage({
        channel: user.slack_dm_channel_id,
        text: buildReminderMessage(summary),
      });

      await userRepository.updateTimesheetReminderSentAtByUserId(user.id, referenceDate.toISOString());
      sentUsers.push({ userId: user.id, slackAccountId: user.slack_account_id || null });
    } catch (error) {
      logger.error('Failed to send timesheet reminder', {
        userId: user.id,
        error: error.message || error,
      });
      skippedUsers.push({ userId: user.id, reason: error.message || 'unknown error' });
    }
  }

  return {
    sentCount: sentUsers.length,
    skippedCount: skippedUsers.length,
    sentUsers,
    skippedUsers,
  };
}

async function getUserById(userId) {
  if (!userId) {
    return null;
  }

  return userRepository.findUserById(userId);
}

module.exports = {
  TIME_ZONE,
  DEFAULT_REMINDER_TIME,
  formatNumber,
  getStockholmDateKey,
  getStockholmWeekday,
  getDateTimePartsInTimeZone,
  parseReminderTime,
  isReminderModeActive,
  isReminderDueToday,
  isReminderRunDue,
  isWithinReminderCheckWindow,
  getPreviousWeekRangeInStockholm,
  getCurrentWeekRangeInStockholm,
  getCurrentMonthRangeInStockholm,
  buildReminderSetupPrompt,
  buildReminderStatusMessage,
  buildCurrentHoursMessage,
  buildReminderMessage,
  getUserReminderStatusBySlackAccountId,
  getUserTimesheetSummaryByUserId,
  getUserTimesheetSummaryBySlackAccountId,
  setTimesheetReminderPreferencesBySlackAccountId,
  sendDueTimesheetReminders,
};
