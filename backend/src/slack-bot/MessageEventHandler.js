const userRepository = require('../repositories/userRepository');
const { askPythonRouter } = require('../services/pythonRouterService');

class MessageEventHandler {
  constructor({ config, slackCommands, logger = console }) {
    this.config = config;
    this.slackCommands = slackCommands;
    this.logger = logger;
    this.conversationStore = new Map();
  }

  async persistSlackDmChannel(event, client) {
    if (!event?.user || !event?.channel) {
      return;
    }

    const slackAccountId = String(event.user);
    const slackDmChannelId = String(event.channel);

    try {
      const existingUser = await userRepository.findUserBySlackAccountId(slackAccountId);

      if (existingUser) {
        if (existingUser.slack_dm_channel_id !== slackDmChannelId) {
          await userRepository.setSlackDmChannelIdBySlackAccountId(slackAccountId, slackDmChannelId);
        }
        return;
      }

      const profile = await this.getSlackUserProfile(client, slackAccountId);
      const linkedUser = await userRepository.linkSlackIdentityByEmail({
        slackAccountId,
        slackDmChannelId,
        email: profile?.email,
      });

      if (linkedUser) {
        return;
      }

      await userRepository.upsertSlackUser({
        slackAccountId,
        slackDmChannelId,
        name: profile?.realName || null,
      });
    } catch (error) {
      this.logger.warn('Could not save slack_dm_channel_id:', error.message || error);
    }
  }

  async getSlackUserProfile(client, slackUserId) {
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
      this.logger.warn('Could not fetch Slack user profile:', error.message || error);
      return null;
    }
  }

  async handleMessage(event, client, onTimesheetReminderSetup) {
    try {
      if (!event.text) return;
      if (event.bot_id || event.subtype) return;

      const isDmChannel =
        event.channel_type === 'im' ||
        (typeof event.channel === 'string' && event.channel.startsWith('D'));

      if (isDmChannel) {
        await this.persistSlackDmChannel(event, client);
      }

      if (isDmChannel) {
        const handledReminderSetup = await this.slackCommands.handlePendingReminderSetup(event, client);
        if (handledReminderSetup) return;

        const handledUserCostSetup = await this.slackCommands.handlePendingUserCostSetup(event, client);
        if (handledUserCostSetup) return;

        const handledWorklogSetup = await this.slackCommands.handlePendingWorklogSetup(event, client);
        if (handledWorklogSetup) return;
      }

      const handledCommand = await this.slackCommands.handleTextCommand({
        text: event.text,
        channel: event.channel,
        client,
        logger: this.logger,
        threadTs: event.thread_ts,
        slackUserId: event.user,
        onTimesheetReminderSetup,
      });

      if (handledCommand) return;

      if (!this.config.enableDmRouter) return;

      this.logger.log('Incoming message event:', {
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

      // Only DMs, only user messages, no system/subtype traffic.
      if (!isDmChannel) return;
      if (event.bot_id || event.subtype) return;
      if (!event.text) return;

      const isThreadMessage = Boolean(event.thread_ts) && event.thread_ts !== event.ts;

      const userMessage = event.text;
      const conversationKey = `${event.user}:${event.channel}`;
      const existingMessages = this.conversationStore.get(conversationKey) || [];
      const updatedMessages = [...existingMessages, { role: 'user', content: userMessage }];

      const trimmedMessages = updatedMessages.slice(-this.config.maxConversationMessages);
      const aiReply = await askPythonRouter(trimmedMessages);
      const nextMessages = [...trimmedMessages, { role: 'assistant', content: aiReply }].slice(
        -this.config.maxConversationMessages
      );
      this.conversationStore.set(conversationKey, nextMessages);

      const targetChannel = event.channel;

      // Default: reply in main DM (not thread) unless explicitly enabled.
      const messagePayload = {
        channel: targetChannel,
        text: aiReply,
      };

      // Mirror thread context from incoming message to keep replies in the same Slack view.
      if (event.thread_ts) {
        messagePayload.thread_ts = event.thread_ts;
      } else if (this.config.replyInThread && event.ts) {
        messagePayload.thread_ts = event.ts;
      }

      const posted = await client.chat.postMessage(messagePayload);
      this.logger.log('Posted reply:', {
        ok: Boolean(posted?.ok),
        channel: posted?.channel,
        ts: posted?.ts || null,
        thread_ts: posted?.message?.thread_ts || null,
        mode: isThreadMessage ? 'mirrored-thread' : (this.config.replyInThread ? 'forced-thread' : 'main-dm'),
      });
    } catch (error) {
      this.logger.error('Error:', error);
      try {
        await client.chat.postMessage({
          channel: event.channel,
          text: 'Something went wrong while I tried to reply. Please try again later.',
        });
      } catch (postError) {
        this.logger.error('Could not post error message to Slack:', postError.message);
      }
    }
  }
}

module.exports = MessageEventHandler;
