const path = require('path');
const dotenv = require('dotenv');
const { App } = require('@slack/bolt');

// Ladda .env från projektets config-mapp för att göra bot-start robust.
dotenv.config({ path: path.join(__dirname, 'config', '.env') });
dotenv.config();

const { askPythonRouter } = require('./services/pythonRouterService');

const useSocketMode = process.env.SLACK_SOCKET_MODE !== 'false';
const restartDelayMs = Number.parseInt(process.env.SLACK_SOCKET_RESTART_DELAY_MS, 10) || 3000;
const replyInThread = process.env.SLACK_REPLY_IN_THREAD === 'true';

let isStarting = false;
let isRunning = false;
let restartTimer = null;
const conversationStore = new Map();
const maxConversationMessages = Number.parseInt(process.env.SLACK_ROUTER_MAX_MESSAGES, 10) || 20;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: useSocketMode,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Lyssna på message och filtrera till DM
app.event('message', async ({ event, client }) => {
  try {
    const isDmChannel =
      event.channel_type === 'im' ||
      (typeof event.channel === 'string' && event.channel.startsWith('D'));

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
})();
