const SlackCommandController = require('./slackCommands/SlackCommandController');

const controller = new SlackCommandController();

module.exports = {
  handleTextCommand: controller.handleTextCommand.bind(controller),
  handlePendingUserCostSetup: controller.handlePendingUserCostSetup.bind(controller),
  handlePendingWorklogSetup: controller.handlePendingWorklogSetup.bind(controller),
  handlePendingReminderSetup: controller.handlePendingReminderSetup.bind(controller),
};
