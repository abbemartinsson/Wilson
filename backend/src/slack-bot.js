const path = require('path');
const dotenv = require('dotenv');
const { App } = require('@slack/bolt');

// Ladda .env från projektets config-mapp för att göra bot-start robust.
dotenv.config({ path: path.join(__dirname, 'config', '.env') });
dotenv.config();

const { askPythonRouter } = require('./services/pythonRouterService');
const userRepo = require('./repositories/userRepository');
const timesheetReminderService = require('./services/timesheetReminderService');
const { handleTextCommand, handlePendingUserCostSetup } = require('./slackCommands');

const useSocketMode = process.env.SLACK_SOCKET_MODE !== 'false';
const restartDelayMs = Number.parseInt(process.env.SLACK_SOCKET_RESTART_DELAY_MS, 10) || 3000;
const replyInThread = process.env.SLACK_REPLY_IN_THREAD === 'true';
const enableDmRouter = process.env.SLACK_ENABLE_DM_ROUTER === 'true';
const enableTimesheetReminders = process.env.ENABLE_TIMESHEET_REMINDERS === 'true';
const reminderScheduleTime = process.env.TIMESHEET_REMINDER_TIME || timesheetReminderService.DEFAULT_REMINDER_TIME;
// Note: TIMESHEET_REMINDER_CHECK_INTERVAL_MS is deprecated. Scheduler now intelligently waits until the check window.

let isStarting = false;
let isRunning = false;
let restartTimer = null;
const conversationStore = new Map();
const reminderSetupStore = new Map();
const maxConversationMessages = Number.parseInt(process.env.SLACK_ROUTER_MAX_MESSAGES, 10) || 20;
let reminderSchedulerTimer = null;
let lastReminderMinuteKey = null;

async function getSlackUserProfile(client, slackUserId) {
  if (!client || !slackUserId) {
    return null;
  }

  try {
    const resp = await client.users.info({ user: slackUserId });
    const profile = resp?.user?.profile || {};

    return {
      email: profile.email || null,
      realName: resp?.user?.real_name || profile.real_name || profile.display_name || null,
    };
  } catch (error) {
    console.warn('Kunde inte hämta Slack-användarprofil:', error.message || error);
    return null;
  }
}

async function persistSlackDmChannel(event, client) {
  if (!event?.user || !event?.channel) {
    return;
  }

  const slackAccountId = String(event.user);
  const slackDmChannelId = String(event.channel);

  try {
    const existingUser = await userRepo.findUserBySlackAccountId(slackAccountId);

    if (existingUser) {
      if (existingUser.slack_dm_channel_id !== slackDmChannelId) {
        await userRepo.setSlackDmChannelIdBySlackAccountId(slackAccountId, slackDmChannelId);
      }
      return;
    }

    const profile = await getSlackUserProfile(client, slackAccountId);
    const linkedUser = await userRepo.linkSlackIdentityByEmail({
      slackAccountId,
      slackDmChannelId,
      email: profile?.email,
    });

    if (linkedUser) {
      return;
    }

    await userRepo.upsertSlackUser({
      slackAccountId,
      slackDmChannelId,
      name: profile?.realName || null,
    });
  } catch (error) {
    console.warn('Kunde inte spara slack_dm_channel_id:', error.message || error);
  }
}

function getConversationKey(event) {
  return `${event.user}:${event.channel}`;
}

function getReminderMinuteKey(referenceDate = new Date()) {
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
function getMillisecondsUntilNextCheckWindow(referenceDate = new Date()) {
  const clock = timesheetReminderService.getDateTimePartsInTimeZone(referenceDate, timesheetReminderService.TIME_ZONE);
  const expected = timesheetReminderService.parseReminderTime(reminderScheduleTime);

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
  // We need to find what UTC time corresponds to Stockholm time 08:55
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

async function startReminderSetup({ channel, client, threadTs, slackUserId }) {
  if (!slackUserId) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: 'I could not identify your Slack account.',
    });
    return;
  }

  reminderSetupStore.set(`${slackUserId}:${channel}`, {
    step: 'mode',
  });

  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: timesheetReminderService.buildReminderSetupPrompt(),
  });
}

async function handlePendingReminderSetup(event, client) {
  const key = getConversationKey(event);
  const state = reminderSetupStore.get(key);

  if (!state) {
    return false;
  }

  const text = String(event.text || '').trim().toLowerCase().replace(/[.,!?;:]+$/g, '');
  const replyChannel = event.channel;
  const threadTs = event.thread_ts;

  if (text === '!cancel' || text === 'cancel' || text === 'stop') {
    reminderSetupStore.delete(key);
    await client.chat.postMessage({
      channel: replyChannel,
      thread_ts: threadTs,
      text: 'Timesheet reminder setup cancelled.',
    });
    return true;
  }

  if (state.step === 'mode') {
    if (!['monday', 'friday', 'both', 'off'].includes(text)) {
      await client.chat.postMessage({
        channel: replyChannel,
        thread_ts: threadTs,
        text: 'Please reply with monday, friday, both, or off.',
      });
      return true;
    }

    if (text === 'off') {
      const updated = await userRepo.updateTimesheetReminderPreferencesBySlackAccountId(event.user, {
        timesheetReminderMode: 'off',
      });

      if (!updated) {
        await client.chat.postMessage({
          channel: replyChannel,
          thread_ts: threadTs,
          text: 'I could not find your user profile yet. Please DM me once first and try again.',
        });
        return true;
      }

      reminderSetupStore.delete(key);
      await client.chat.postMessage({
        channel: replyChannel,
        thread_ts: threadTs,
        text: 'Timesheet reminders are now turned off.',
      });
      return true;
    }

    state.mode = text;
    state.step = 'hours';
    reminderSetupStore.set(key, state);

    await client.chat.postMessage({
      channel: replyChannel,
      thread_ts: threadTs,
      text: 'How many hours do you work per week? Reply with a whole number, for example 40.',
    });
    return true;
  }

  if (state.step === 'hours') {
    if (!/^\d+$/.test(text)) {
      await client.chat.postMessage({
        channel: replyChannel,
        thread_ts: threadTs,
        text: 'Please reply with a whole number greater than 0, for example 40.',
      });
      return true;
    }

    const hours = Number.parseInt(text, 10);
    if (hours < 1 || hours > 168) {
      await client.chat.postMessage({
        channel: replyChannel,
        thread_ts: threadTs,
        text: 'Please reply with a whole number between 1 and 168.',
      });
      return true;
    }

    const updated = await userRepo.updateTimesheetReminderPreferencesBySlackAccountId(event.user, {
      timesheetReminderMode: state.mode,
      capacityHoursPerWeek: hours,
    });

    if (!updated) {
      await client.chat.postMessage({
        channel: replyChannel,
        thread_ts: threadTs,
        text: 'I could not find your user profile yet. Please DM me once first and try again.',
      });
      return true;
    }

    reminderSetupStore.delete(key);
    await client.chat.postMessage({
      channel: replyChannel,
      thread_ts: threadTs,
      text: `Saved. You will get reminders on ${state.mode} and your weekly target is ${hours} hours.`,
    });
    return true;
  }

  reminderSetupStore.delete(key);
  return false;
}

async function checkScheduledTimesheetReminders() {
  if (!enableTimesheetReminders) {
    return;
  }

  const now = new Date();

  if (!timesheetReminderService.isWithinReminderCheckWindow(now, reminderScheduleTime)) {
    return;
  }

  const minuteKey = getReminderMinuteKey(now);
  if (minuteKey === lastReminderMinuteKey) {
    return;
  }

  lastReminderMinuteKey = minuteKey;

  try {
    const result = await timesheetReminderService.sendDueTimesheetReminders({
      client: app.client,
      referenceDate: now,
      logger: console,
    });

    console.log('Timesheet reminders checked:', result);
  } catch (error) {
    console.error('Failed to run timesheet reminders:', error.message || error);
  }
}

function startTimesheetReminderScheduler() {
  if (!enableTimesheetReminders) {
    console.log('Timesheet reminders are disabled (ENABLE_TIMESHEET_REMINDERS=false).');
    return;
  }

  if (reminderSchedulerTimer) {
    return;
  }

  console.log(`Timesheet reminder scheduler started (${timesheetReminderService.TIME_ZONE}, ${reminderScheduleTime}). Checks every minute between 08:55-09:01 on Monday/Friday.`);

  async function scheduleNextCheck() {
    try {
      await checkScheduledTimesheetReminders();
    } catch (error) {
      console.error('Error in scheduled timesheet check:', error.message || error);
    }

    // Calculate delay until next check (within window) or until next window
    const now = new Date();
    const isInWindow = timesheetReminderService.isWithinReminderCheckWindow(now, reminderScheduleTime);

    let nextCheckMs;
    if (isInWindow) {
      // In window: check every 1 minute
      nextCheckMs = 60 * 1000;
    } else {
      // Not in window: wait until next window starts
      nextCheckMs = getMillisecondsUntilNextCheckWindow(now) || (60 * 1000);
    }

    // Add small random jitter to avoid thundering herd
    nextCheckMs += Math.random() * 5000;

    reminderSchedulerTimer = setTimeout(() => {
      reminderSchedulerTimer = null;
      void scheduleNextCheck();
    }, nextCheckMs);
  }

  void scheduleNextCheck();
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: useSocketMode,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Lyssna på message och filtrera till DM
app.event('message', async ({ event, client }) => {
  try {
    if (!event.text) return;
    if (event.bot_id || event.subtype) return;

    const isDmChannel =
      event.channel_type === 'im' ||
      (typeof event.channel === 'string' && event.channel.startsWith('D'));

    if (isDmChannel) {
      await persistSlackDmChannel(event, client);
    }

    if (isDmChannel) {
      const handledReminderSetup = await handlePendingReminderSetup(event, client);
      if (handledReminderSetup) return;

      const handledUserCostSetup = await handlePendingUserCostSetup(event, client);
      if (handledUserCostSetup) return;
    }

    const handledCommand = await handleTextCommand({
      text: event.text,
      channel: event.channel,
      client,
      logger: console,
      threadTs: event.thread_ts,
      slackUserId: event.user,
      onTimesheetReminderSetup: startReminderSetup,
    });

    if (handledCommand) return;

    if (!enableDmRouter) return;

    console.log('Incoming message event:', {
      channel_type: event.channel_type,
      channel: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts || null,
      subtype: event.subtype || null,
      has_bot_id: Boolean(event.bot_id),
      has_text: Boolean(event.text),
      has_thread_ts: Boolean(event.thread_ts),
      is_dm_channel: isDmChannel,
    });

    // Bara DM, endast användarmeddelanden, ingen system/subtype-trafik.
    if (!isDmChannel) return;
    if (event.bot_id || event.subtype) return;
    if (!event.text) return;

    const isThreadMessage = Boolean(event.thread_ts) && event.thread_ts !== event.ts;

    const userMessage = event.text;
    const conversationKey = `${event.user}:${event.channel}`;
    const existingMessages = conversationStore.get(conversationKey) || [];
    const updatedMessages = [...existingMessages, { role: 'user', content: userMessage }];

    const trimmedMessages = updatedMessages.slice(-maxConversationMessages);
    const aiReply = await askPythonRouter(trimmedMessages);
    const nextMessages = [...trimmedMessages, { role: 'assistant', content: aiReply }].slice(
      -maxConversationMessages
    );
    conversationStore.set(conversationKey, nextMessages);

    const targetChannel = event.channel;

    // Standard: svara i huvud-DM (inte i thread) om inte uttryckligen aktiverat.
    const messagePayload = {
      channel: targetChannel,
      text: aiReply,
    };

    // Mirror thread context from incoming message to keep replies in the same Slack view.
    if (event.thread_ts) {
      messagePayload.thread_ts = event.thread_ts;
    } else if (replyInThread && event.ts) {
      messagePayload.thread_ts = event.ts;
    }

    const posted = await client.chat.postMessage(messagePayload);
    console.log('Posted reply:', {
      ok: Boolean(posted?.ok),
      channel: posted?.channel,
      ts: posted?.ts || null,
      thread_ts: posted?.message?.thread_ts || null,
      mode: isThreadMessage ? 'mirrored-thread' : (replyInThread ? 'forced-thread' : 'main-dm'),
    });
  } catch (error) {
    console.error('Fel:', error);
    try {
      await client.chat.postMessage({
        channel: event.channel,
        text: 'Något gick fel när jag försökte svara. Försök igen senare.',
      });
    } catch (postError) {
      console.error('Kunde inte posta felmeddelande i Slack:', postError.message);
    }
  }
});

app.error(async (error) => {
  console.error('Slack Bolt error:', error);
});

function isSocketEofError(error) {
  if (!error) return false;

  const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
  const syscall = typeof error.syscall === 'string' ? error.syscall.toLowerCase() : '';
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';

  return code === 'EOF' || syscall === 'write' || message.includes('write eof');
}

async function startSlackApp() {
  if (isStarting || isRunning) return;
  isStarting = true;

  try {
    if (useSocketMode) {
      await app.start();
      isRunning = true;
      console.log('Slack bot kör i Socket Mode (ingen ngrok behövs)');
    } else {
      await app.start(process.env.PORT || 3000);
      isRunning = true;
      console.log(`Slack bot kör på port ${process.env.PORT || 3000}`);
    }

    console.log('Python chatbot-router is enabled for Slack replies.');
  } finally {
    isStarting = false;
  }
}

function scheduleSocketRestart(reason) {
  if (!useSocketMode) return;
  if (restartTimer) return;

  console.warn(`Socket problem upptäckt (${reason}). Försöker återansluta om ${restartDelayMs} ms...`);

  restartTimer = setTimeout(async () => {
    restartTimer = null;

    try {
      if (isRunning) {
        await app.stop();
      }
    } catch (stopError) {
      console.error('Kunde inte stoppa Slack-app innan restart:', stopError.message);
    } finally {
      isRunning = false;
    }

    try {
      await startSlackApp();
    } catch (startError) {
      console.error('Återanslutning misslyckades:', startError);
      scheduleSocketRestart('retry');
    }
  }, restartDelayMs);
}

process.on('uncaughtException', (error) => {
  if (isSocketEofError(error)) {
    console.warn('Fångade socket EOF-fel, boten försöker återansluta utan att avsluta processen.');
    scheduleSocketRestart('uncaughtException/EOF');
    return;
  }

  console.error('Okänt okontrollerat fel:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  if (isSocketEofError(reason)) {
    console.warn('Fångade socket EOF-rejection, boten försöker återansluta.');
    scheduleSocketRestart('unhandledRejection/EOF');
    return;
  }

  console.error('Unhandled rejection:', reason);
});

// Starta servern
(async () => {
  if (useSocketMode && !process.env.SLACK_APP_TOKEN) {
    throw new Error('SLACK_APP_TOKEN saknas. Aktivera Socket Mode i Slack och lägg till token i .env');
  }

  await startSlackApp();
  startTimesheetReminderScheduler();
})();
