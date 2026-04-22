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
      return { ok: false, message: 'Skriv ett belopp i kr/timme.' };
    }

    if (!/^-?\d+(?:[.,]\d+)?$/.test(normalized)) {
      return { ok: false, message: 'Jag kunde inte läsa beloppet. Skriv ett tal, till exempel 350 eller 350,50.' };
    }

    const value = Number.parseFloat(normalized.replace(',', '.'));
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, message: 'Beloppet måste vara ett tal större än 0.' };
    }

    return { ok: true, value: Math.round(value * 100) / 100 };
  }

  formatUserCostValue(value) {
    const numericValue = Number(value);
    if (Number.isNaN(numericValue)) {
      return 'okänd';
    }

    return `${this.formatter.formatCurrency(numericValue)}/timme`;
  }

  formatUserCostCandidate(user, index) {
    const name = this.formatter.escapeMrkdwn(user.name || 'Okänd');
    const email = user.email ? ` (${this.formatter.escapeMrkdwn(user.email)})` : '';
    const currentCost = user.cost != null ? ` - nuvarande ${this.formatUserCostValue(user.cost)}` : ' - ingen cost satt';
    return `${index}. ${name}${email}${currentCost}`;
  }

  buildSelectionMessage(firstName, candidates) {
    const lines = [
      `Jag hittade flera users med förnamnet *${this.formatter.escapeMrkdwn(firstName)}*.`,
      'Svara med numret för rätt person, eller skriv `!cancel` för att avbryta.',
      '',
    ];

    candidates.forEach((candidate, index) => {
      lines.push(this.formatUserCostCandidate(candidate, index + 1));
    });

    return lines.join('\n');
  }

  buildAmountMessage(user) {
    const name = this.formatter.escapeMrkdwn(user.name || 'Okänd');
    return [
      `Hur mycket kostar *${name}* per timme?`,
      'Svara med ett belopp i kr/timme, till exempel `350` eller `350,50`.',
      'Skriv `!cancel` om du vill avbryta.',
    ].join('\n');
  }

  async start({ text, channel, client, threadTs, slackUserId, sanitizeInput }) {
    const firstName = sanitizeInput(text).split(' ')[0];
    if (!firstName) {
      await this.sendMessage(client, channel, 'Usage: !user cost <förnamn>', threadTs, true);
      return true;
    }

    const candidates = await this.userRepository.findUsersByFirstName(firstName);

    if (candidates.length === 0) {
      await this.sendMessage(
        client,
        channel,
        `Jag hittade ingen user med förnamnet *${this.formatter.escapeMrkdwn(firstName)}*.`,
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
          `Svara med ett nummer mellan 1 och ${state.candidates.length}, eller skriv !cancel för att avbryta.`,
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
        await this.sendMessage(client, replyChannel, 'Jag kunde inte uppdatera cost på den usern.', threadTs, true);
        return true;
      }

      this.store.delete(key);
      await this.sendMessage(
        client,
        replyChannel,
        `Sparat: *${this.formatter.escapeMrkdwn(updatedUser.name || state.user.name || 'Okänd')}* kostar nu ${this.formatUserCostValue(parsedCost.value)}.`,
        threadTs
      );
      return true;
    }

    this.store.delete(key);
    return false;
  }
}

module.exports = UserCostSetupFlow;
