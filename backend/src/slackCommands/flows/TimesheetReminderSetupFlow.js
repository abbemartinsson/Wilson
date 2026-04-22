const timesheetReminderService = require('../../services/timesheetReminderService');

class TimesheetReminderSetupFlow {
  constructor({ userRepository, formatter, postSlackMessage }) {
    this.userRepository = userRepository;
    this.formatter = formatter;
    this.postSlackMessage = postSlackMessage;
    this.store = new Map();
  }

  async start({ channel, client, threadTs, slackUserId }) {
    const key = `${slackUserId}:${channel}`;

    this.store.set(key, {
      step: 'mode',
    });

    const prompt = timesheetReminderService.buildReminderSetupPrompt();
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: prompt,
    });
  }

  async handlePending(event, client) {
    if (!event) {
      return false;
    }

    const key = `${event.user}:${event.channel}`;
    const state = this.store.get(key);

    if (!state) {
      return false;
    }

    const text = String(event.text || '')
      .trim()
      .toLowerCase()
      .replace(/[.,!?;:]+$/g, '');

    const replyChannel = event.channel;
    const threadTs = event.thread_ts;

    // Handle cancel command
    if (['!cancel', 'cancel', 'stop'].includes(text)) {
      this.store.delete(key);
      await client.chat.postMessage({
        channel: replyChannel,
        thread_ts: threadTs,
        text: 'Timesheet reminder setup cancelled.',
      });
      return true;
    }

    if (state.step === 'mode') {
      return this.handleModeStep(event, client, state, key);
    }

    if (state.step === 'hours') {
      return this.handleHoursStep(event, client, state, key);
    }

    this.store.delete(key);
    return false;
  }

  async handleModeStep(event, client, state, key) {
    const text = String(event.text || '')
      .trim()
      .toLowerCase()
      .replace(/[.,!?;:]+$/g, '');

    const validModes = ['monday', 'friday', 'both', 'off'];

    if (!validModes.includes(text)) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: 'Please reply with monday, friday, both, or off.',
      });
      return true;
    }

    // Handle "off" mode - disable reminders
    if (text === 'off') {
      try {
        const updated = await timesheetReminderService.setTimesheetReminderPreferencesBySlackAccountId(
          event.user,
          {
            timesheet_reminder_mode: 'off',
          }
        );

        if (!updated) {
          await client.chat.postMessage({
            channel: event.channel,
            thread_ts: event.thread_ts,
            text: 'I could not find your user profile yet. Please try again after a moment.',
          });
          return true;
        }

        this.store.delete(key);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts,
          text: 'Timesheet reminders are now turned off.',
        });
        return true;
      } catch (error) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts,
          text: 'An error occurred while saving your preferences. Please try again.',
        });
        this.store.delete(key);
        return true;
      }
    }

    // Move to hours step
    state.mode = text;
    state.step = 'hours';
    this.store.set(key, state);

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: 'How many hours do you work per week? Reply with a whole number, for example 40.',
    });

    return true;
  }

  async handleHoursStep(event, client, state, key) {
    const text = String(event.text || '')
      .trim()
      .toLowerCase()
      .replace(/[.,!?;:]+$/g, '');

    // Validate whole number
    if (!/^\d+$/.test(text)) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: 'Please reply with a whole number greater than 0, for example 40.',
      });
      return true;
    }

    const hours = Number.parseInt(text, 10);

    // Validate range
    if (hours < 1 || hours > 168) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: 'Please reply with a whole number between 1 and 168.',
      });
      return true;
    }

    try {
      const updated = await timesheetReminderService.setTimesheetReminderPreferencesBySlackAccountId(
        event.user,
        {
          timesheet_reminder_mode: state.mode,
          timesheet_reminder_target_hours: hours,
        }
      );

      if (!updated) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts,
          text: 'I could not find your user profile yet. Please try again after a moment.',
        });
        return true;
      }

      this.store.delete(key);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: `Saved. You will get reminders on ${state.mode} and your weekly target is ${hours} hours.`,
      });
      return true;
    } catch (error) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts,
        text: 'An error occurred while saving your preferences. Please try again.',
      });
      this.store.delete(key);
      return true;
    }
  }
}

module.exports = TimesheetReminderSetupFlow;
