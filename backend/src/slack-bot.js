const path = require('path');
const dotenv = require('dotenv');
const { App } = require('@slack/bolt');

// Ladda .env från projektets config-mapp för att göra bot-start robust.
dotenv.config({ path: path.join(__dirname, 'config', '.env') });
dotenv.config();

const useSocketMode = process.env.SLACK_SOCKET_MODE !== 'false';

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

    const userMessage = event.text;

    // Koppla till Ollama AI
    const aiReply = await myBotLogic(userMessage);

    // Skicka svar explicit i samma DM-kanal
    await client.chat.postMessage({
      channel: event.channel,
      text: `Du skrev: ${userMessage}\n\nSvar: ${aiReply}`,
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

// Din AI-logik här - använder Ollama
async function myBotLogic(text) {
  try {
    const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    const ollamaModel = process.env.OLLAMA_MODEL || 'llama2';

    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        prompt: text,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status}`);
    }

    const data = await response.json();
    return data.response || 'Ingen respons från AI:n';
  } catch (error) {
    console.error('Ollama error:', error.message);
    return 'Kunde inte nå AI:n. Är Ollama igång?';
  }
}

// Starta servern
(async () => {
  if (useSocketMode && !process.env.SLACK_APP_TOKEN) {
    throw new Error('SLACK_APP_TOKEN saknas. Aktivera Socket Mode i Slack och lägg till token i .env');
  }

  if (useSocketMode) {
    await app.start();
    console.log('Slack bot kör i Socket Mode (ingen ngrok behövs)');
  } else {
    await app.start(process.env.PORT || 3000);
    console.log(`Slack bot kör på port ${process.env.PORT || 3000}`);
  }

  console.log(`Ollama endpoint: ${process.env.OLLAMA_URL || 'http://localhost:11434'}`);
})();
