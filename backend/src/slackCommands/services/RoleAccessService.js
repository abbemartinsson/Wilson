class RoleAccessService {
  constructor({
    commandMap,
    rolePermissionConfig,
    roleLabels,
    commandUsageText,
    commandShortDescriptions,
    helpCommandGroups,
    userRepository,
  }) {
    this.commandMap = commandMap;
    this.rolePermissionConfig = rolePermissionConfig;
    this.roleLabels = roleLabels;
    this.commandUsageText = commandUsageText;
    this.commandShortDescriptions = commandShortDescriptions;
    this.helpCommandGroups = helpCommandGroups;
    this.userRepository = userRepository;
    this.allCommandNames = Object.keys(commandMap);
    this.roleCommands = this.buildRoleCommands(rolePermissionConfig);
  }

  buildRoleCommands(permissionConfig) {
    const allCommandsSet = new Set(this.allCommandNames);
    const result = {};

    for (const [roleName, roleConfig] of Object.entries(permissionConfig)) {
      if (roleConfig?.all === true) {
        result[roleName] = [...this.allCommandNames];
        continue;
      }

      const configuredCommands = Array.isArray(roleConfig?.commands) ? roleConfig.commands : [];
      const invalidCommandNames = configuredCommands.filter((commandName) => !allCommandsSet.has(commandName));

      if (invalidCommandNames.length > 0) {
        throw new Error(
          `Invalid command(s) in ROLE_PERMISSION_CONFIG for role "${roleName}": ${invalidCommandNames.join(', ')}`
        );
      }

      result[roleName] = [...configuredCommands];
    }

    return result;
  }

  normalizeUserRole(role) {
    const normalized = String(role || '').trim().toLowerCase();
    if (!normalized || !this.roleCommands[normalized]) {
      return this.userRepository.DEFAULT_USER_ROLE;
    }

    return normalized;
  }

  async resolveUserRole(slackUserId, logger = console) {
    try {
      const role = await this.userRepository.findRoleBySlackAccountId(slackUserId);
      return this.normalizeUserRole(role);
    } catch (error) {
      logger.warn('Could not resolve user role, defaulting to member', {
        slackUserId,
        message: error.message || error,
      });
      return this.userRepository.DEFAULT_USER_ROLE;
    }
  }

  getAllowedCommandsForRole(role) {
    const normalizedRole = this.normalizeUserRole(role);
    return this.roleCommands[normalizedRole] || this.roleCommands[this.userRepository.DEFAULT_USER_ROLE];
  }

  canUseCommand(role, commandName) {
    return this.getAllowedCommandsForRole(role).includes(commandName);
  }

  buildHelpMessageForRole(role) {
    const normalizedRole = this.normalizeUserRole(role);
    const roleLabel = this.roleLabels[normalizedRole] || normalizedRole;
    const allowedCommands = this.getAllowedCommandsForRole(normalizedRole);
    const allowedSet = new Set(allowedCommands);
    const usedCommandNames = new Set();
    const helpLines = [`📚 Available commands for role: *${roleLabel}*`, ''];

    for (const group of this.helpCommandGroups) {
      const visibleCommands = group.commands.filter((commandName) => allowedSet.has(commandName));
      if (visibleCommands.length === 0) {
        continue;
      }

      visibleCommands.forEach((commandName) => usedCommandNames.add(commandName));

      helpLines.push(`• ${group.emoji} *${group.title}:*`);
      for (const commandName of visibleCommands) {
        const usage = this.commandUsageText[commandName] || this.commandMap[commandName]?.usage || commandName;
        const shortDescription = this.commandShortDescriptions[commandName] || 'No description available.';
        helpLines.push(`   - \`${usage}\` - ${shortDescription}`);
      }

      helpLines.push('');
    }

    const ungroupedCommands = allowedCommands.filter(
      (commandName) => commandName !== 'help' && !usedCommandNames.has(commandName)
    );

    if (ungroupedCommands.length > 0) {
      helpLines.push('• 🧩 *Other:*');
      for (const commandName of ungroupedCommands) {
        const usage = this.commandUsageText[commandName] || this.commandMap[commandName]?.usage || commandName;
        const shortDescription = this.commandShortDescriptions[commandName] || 'No description available.';
        helpLines.push(`   - \`${usage}\` - ${shortDescription}`);
      }

      helpLines.push('');
    }

    while (helpLines.length > 0 && helpLines[helpLines.length - 1] === '') {
      helpLines.pop();
    }

    return helpLines.join('\n');
  }
}

module.exports = RoleAccessService;
