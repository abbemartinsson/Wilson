const path = require('path');
const dotenv = require('dotenv');

// Load .env from the project's config folder for robust bot startup.
dotenv.config({ path: path.join(__dirname, 'config', '.env') });
dotenv.config();

const SlackBot = require('./slack-bot/SlackBot');
const slackCommandsModule = require('./slackCommands');

const slackBot = new SlackBot({
  slackCommands: slackCommandsModule,
  logger: console,
});

(async () => {
  try {
    await slackBot.initialize();
    await slackBot.start();
  } catch (error) {
    console.error('Failed to start Slack bot:', error);
    process.exit(1);
  }
})();
