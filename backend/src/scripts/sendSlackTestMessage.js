require('dotenv').config({ path: './src/config/.env' });

const axios = require('axios');
const userRepo = require('../repositories/userRepository');

const slackToken = process.env.SLACK_BOT_TOKEN;

function parseCliArgs(argv) {
  const parsed = {
    userId: '',
    channelId: '',
    message: '',
    useManualChannel: false,
  };

  const tokens = argv.slice(2);

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];

    if (token === '--user' && tokens[index + 1]) {
      parsed.userId = tokens[index + 1].trim();
      index++;
      continue;
    }

    if (token === '--channel' && tokens[index + 1]) {
      parsed.channelId = tokens[index + 1].trim();
      index++;
      continue;
    }

    if (token === '--message' && tokens[index + 1]) {
      parsed.message = tokens.slice(index + 1).join(' ').trim();
      break;
    }

    if (token === '--use-channel') {
      parsed.useManualChannel = true;
      continue;
    }
  }

  if (!parsed.userId && tokens[0] && !tokens[0].startsWith('--')) {
    parsed.userId = tokens[0].trim();
  }

  if (!parsed.channelId && tokens[1] && !tokens[1].startsWith('--')) {
    parsed.channelId = tokens[1].trim();
  }

  if (!parsed.message) {
    const positionalMessage = tokens.slice(2).filter(token => !token.startsWith('--')).join(' ').trim();
    parsed.message = positionalMessage;
  }

  return parsed;
}

async function postMessage(channel, text) {
  const response = await axios.post(
    'https://slack.com/api/chat.postMessage',
    {
      channel,
      text,
    },
    {
      headers: {
        Authorization: `Bearer ${slackToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
    }
  );

  if (!response?.data?.ok) {
    throw new Error(`Slack chat.postMessage failed: ${response?.data?.error || 'unknown_error'}`);
  }

  return response.data;
}

async function openDmChannel(slackAccountId) {
  const response = await axios.post(
    'https://slack.com/api/conversations.open',
    {
      users: slackAccountId,
    },
    {
      headers: {
        Authorization: `Bearer ${slackToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
    }
  );

  if (!response?.data?.ok) {
    throw new Error(`Slack conversations.open failed: ${response?.data?.error || 'unknown_error'}`);
  }

  return response.data.channel?.id || null;
}

async function main() {
  const cli = parseCliArgs(process.argv);
  const slackAccountId = (cli.userId || process.env.SLACK_TEST_USER_ID || '').trim();
  const explicitChannelId = (cli.channelId || '').trim();
  const useManualChannel = Boolean(cli.useManualChannel);
  const message = cli.message || 'Hej! Detta är ett testmeddelande från boten.';

  if (!slackToken) {
    console.error('Missing SLACK_BOT_TOKEN in src/config/.env');
    process.exit(1);
  }

  if (!slackAccountId) {
    console.error('Usage: npm run slack:test-dm -- --user <SLACK_ACCOUNT_ID> [--channel <CHANNEL_ID>] [--use-channel] [--message <TEXT>]');
    console.error('Alternative positional usage: npm run slack:test-dm -- <SLACK_ACCOUNT_ID> <CHANNEL_ID> [message]');
    console.error('Or set SLACK_TEST_USER_ID in src/config/.env');
    process.exit(1);
  }

  try {
    let targetChannel = null;

    if (explicitChannelId && useManualChannel) {
      targetChannel = explicitChannelId;
    }

    // Prefer Slack's canonical DM channel for a user. This avoids sending to a stale/wrong conversation id.
    if (!targetChannel) {
      const openedChannelId = await openDmChannel(slackAccountId);
      if (openedChannelId) {
        targetChannel = openedChannelId;
      }
    }

    if (!targetChannel) {
      const user = await userRepo.findUserBySlackAccountId(slackAccountId);
      targetChannel = user?.slack_dm_channel_id || null;
    }

    if (!targetChannel) {
      targetChannel = await openDmChannel(slackAccountId);
      if (!targetChannel) {
        throw new Error('Could not resolve DM channel id for target user');
      }
      await userRepo.setSlackDmChannelIdBySlackAccountId(slackAccountId, targetChannel);
    }

    const posted = await postMessage(targetChannel, message);
    console.log('Message sent');
    console.log(`channel: ${posted.channel}`);
    console.log(`ts: ${posted.ts}`);
  } catch (error) {
    console.error('Failed to send test DM:', error.message || error);
    process.exit(1);
  }
}

main();
