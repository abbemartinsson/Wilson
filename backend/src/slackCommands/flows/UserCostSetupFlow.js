class UserCostSetupFlow {
  constructor({ userRepository, formatter, sendMessage }) {
    this.userRepository = userRepository;
    this.formatter = formatter;
    this.sendMessage = sendMessage;
    this.store = new Map();
  }

  parseCostInput(inputText) {
    const normalized = String(inputText || '')
      .trim()
      .toLowerCase()
      .replace(/kr\s*\/\s*timme|kr\s*\/\s*h|kr\/timme|kr\/h|kr/g, '')
      .replace(/\s+/g, '');

    if (!normalized) {
      return { ok: false, message: 'Enter an amount in SEK/hour.' };
    }

    if (!/^-?\d+(?:[.,]\d+)?$/.test(normalized)) {
      return { ok: false, message: 'I could not parse the amount. Enter a number, for example 350 or 350.50.' };
    }

    const value = Number.parseFloat(normalized.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, message: 'The amount must be a number greater than 0.' };
    }

    return { ok: true, value: Math.round(value * 100) / 100 };
  }

  formatUserCostValue(value) {
    const numericValue = Number(value);
    if (Number.isNaN(numericValue)) {
      return 'unknown';
    }

    return `${this.formatter.formatCurrency(numericValue)}/hour`;
  }

  formatUserCostCandidate(user, index) {
    const name = this.formatter.escapeMrkdwn(user.name || 'Unknown');
    const email = user.email ? ` (${this.formatter.escapeMrkdwn(user.email)})` : '';
    const currentCost = user.cost != null ? ` - current ${this.formatUserCostValue(user.cost)}` : ' - no cost set';
    return `${index}. ${name}${email}${currentCost}`;
  }

  buildSelectionMessage(firstName, candidates) {
    const lines = [
      `I found multiple users with the first name *${this.formatter.escapeMrkdwn(firstName)}*.`,
      'Reply with the number for the correct person, or type `cancel` to abort.',
      '',
    ];

    candidates.forEach((candidate, index) => {
      lines.push(this.formatUserCostCandidate(candidate, index + 1));
    });

    return lines.join('\n');
  }

  buildAmountMessage(user) {
    const name = this.formatter.escapeMrkdwn(user.name || 'Unknown');
    return [
      `What is the hourly cost for *${name}*?`,
      'Reply with an amount in SEK/hour, for example `350` or `350.50`.',
      'Type `cancel` if you want to abort.',
    ].join('\n');
  }

  async start({ text, channel, client, threadTs, slackUserId, sanitizeInput }) {
    const firstName = sanitizeInput(text).split(' ')[0];
    if (!firstName) {
      await this.sendMessage(client, channel, 'Usage: user cost <first_name>', threadTs, true);
      return true;
    }

    const candidates = await this.userRepository.findUsersByFirstName(firstName);

    if (candidates.length === 0) {
      await this.sendMessage(
        client,
        channel,
        `I could not find a user with the first name *${this.formatter.escapeMrkdwn(firstName)}*.`,
        threadTs,
        true
      );
      return true;
    }

    const key = `${slackUserId}:${channel}`;

    if (candidates.length === 1) {
      this.store.set(key, {
        step: 'amount',
        user: candidates[0],
        requester: slackUserId,
      });

      await this.sendMessage(client, channel, this.buildAmountMessage(candidates[0]), threadTs);
      return true;
    }

    this.store.set(key, {
      step: 'choose-user',
      firstName,
      candidates,
      requester: slackUserId,
    });

    await this.sendMessage(client, channel, this.buildSelectionMessage(firstName, candidates), threadTs);
    return true;
  }

  async handlePending(event, client) {
    const key = `${event.user}:${event.channel}`;
    const state = this.store.get(key);

    if (!state) {
      return false;
    }

    const rawText = String(event.text || '').trim();
    const normalizedText = rawText.toLowerCase();
    const replyChannel = event.channel;
    const threadTs = event.thread_ts;

    if (normalizedText === '!cancel' || normalizedText === 'cancel' || normalizedText === 'stop') {
      this.store.delete(key);
      await this.sendMessage(client, replyChannel, 'User cost setup cancelled.', threadTs);
      return true;
    }

    if (state.step === 'choose-user') {
      const selection = Number.parseInt(rawText, 10);

      if (!Number.isInteger(selection) || selection < 1 || selection > state.candidates.length) {
        await this.sendMessage(
          client,
          replyChannel,
          `Reply with a number between 1 and ${state.candidates.length}, or type cancel to abort.`,
          threadTs,
          true
        );
        return true;
      }

      const selectedUser = state.candidates[selection - 1];
      this.store.set(key, {
        step: 'amount',
        user: selectedUser,
        requester: state.requester,
      });

      await this.sendMessage(client, replyChannel, this.buildAmountMessage(selectedUser), threadTs);
      return true;
    }

    if (state.step === 'amount') {
      const parsedCost = this.parseCostInput(rawText);

      if (!parsedCost.ok) {
        await this.sendMessage(client, replyChannel, parsedCost.message, threadTs, true);
        return true;
      }

      const updatedUser = await this.userRepository.updateUserCostById(state.user.id, parsedCost.value);
      if (!updatedUser) {
        await this.sendMessage(client, replyChannel, 'I could not update the cost for that user.', threadTs, true);
        return true;
      }

      this.store.delete(key);
      await this.sendMessage(
        client,
        replyChannel,
        `Saved: *${this.formatter.escapeMrkdwn(updatedUser.name || state.user.name || 'Unknown')}* now costs ${this.formatUserCostValue(parsedCost.value)}.`,
        threadTs
      );
      return true;
    }

    this.store.delete(key);
    return false;
  }
}

module.exports = UserCostSetupFlow;
