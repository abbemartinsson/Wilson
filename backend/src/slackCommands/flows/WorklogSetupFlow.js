class WorklogSetupFlow {
  constructor({ userRepository, issueRepository, worklogRepository, tempoClient, formatter, postSlackMessage, buildPlainMessagePayload, buildSplitPlainMessages }) {
    this.userRepository = userRepository;
    this.issueRepository = issueRepository;
    this.worklogRepository = worklogRepository;
    this.tempoClient = tempoClient;
    this.formatter = formatter;
    this.postSlackMessage = postSlackMessage;
    this.buildPlainMessagePayload = buildPlainMessagePayload;
    this.buildSplitPlainMessages = buildSplitPlainMessages;
    this.store = new Map();
  }

  async sendMessage(client, channel, body, threadTs) {
    await this.postSlackMessage(client, channel, this.buildPlainMessagePayload(body), threadTs);
  }

  formatIssueCandidate(issue, index) {
    const key = this.formatter.escapeMrkdwn(issue.jira_issue_key || 'okänd nyckel');
    const title = this.formatter.formatInlineCode(issue.title || 'Okänd issue');
    const status = this.formatter.escapeMrkdwn(issue.status || 'Okänd status');

    return `${index}. ${key} - ${title} (${status})`;
  }

  buildSelectionMessage(issues) {
    const lines = [
      'Jag hittade dessa issues som är assignade till dig.',
      'Svara med numret för den issue du vill logga tid på, eller skriv `!cancel` för att avbryta.',
      '',
    ];

    issues.forEach((issue, index) => {
      lines.push(this.formatIssueCandidate(issue, index + 1));
    });

    return lines.join('\n');
  }

  buildHoursMessage(issue) {
    const key = this.formatter.escapeMrkdwn(issue.jira_issue_key || 'okänd issue');
    const title = this.formatter.escapeMrkdwn(issue.title || 'Okänd issue');

    return [
      `Hur många timmar vill du logga på *${key}*?`,
      `• ${title}`,
      'Svara med ett tal, till exempel `1,5` eller `2`.',
      'Skriv `!cancel` om du vill avbryta.',
    ].join('\n');
  }

  buildConfirmationMessage(issue, hours) {
    const key = this.formatter.escapeMrkdwn(issue.jira_issue_key || 'okänd issue');
    const title = this.formatter.escapeMrkdwn(issue.title || 'Okänd issue');
    return `Sparat: ${this.formatter.formatNumber(hours)} h på *${key}* - ${title}.`;
  }

  isDoneLikeIssueStatus(status) {
    const normalized = String(status || '')
      .trim()
      .toLowerCase();

    if (!normalized) {
      return false;
    }

    const doneMarkers = ['done', 'closed', 'resolved', 'complete', 'completed', 'klar', 'slutford', 'fardig'];
    return doneMarkers.some((marker) => normalized.includes(marker));
  }

  parseWorklogHours(inputText) {
    const normalized = String(inputText || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/(?:tim|timmar|h|hours?)$/g, '')
      .replace(',', '.');

    if (!normalized) {
      return { ok: false, message: 'Skriv ett antal timmar, till exempel 1,5 eller 2.' };
    }

    if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
      return { ok: false, message: 'Jag kunde inte läsa tiden. Skriv ett tal, till exempel 1,5 eller 2.' };
    }

    const hours = Number.parseFloat(normalized);
    if (!Number.isFinite(hours) || hours <= 0) {
      return { ok: false, message: 'Tiden måste vara större än 0.' };
    }

    if (hours > 24) {
      return { ok: false, message: 'Tiden verkar för hög för en worklogg. Skriv ett värde på 24 timmar eller mindre.' };
    }

    return { ok: true, value: hours };
  }

  async start({ channel, client, threadTs, slackUserId }) {
    if (!slackUserId) {
      await this.sendMessage(client, channel, 'Jag kunde inte identifiera ditt Slack-konto.', threadTs);
      return true;
    }

    const user = await this.userRepository.findUserBySlackAccountId(slackUserId);
    if (!user) {
      await this.sendMessage(
        client,
        channel,
        'Jag hittade ingen användare kopplad till ditt Slack-konto. Skriv gärna ett DM först så jag kan länka dig.',
        threadTs
      );
      return true;
    }

    const allAssignedIssues = await this.issueRepository.findIssuesByAssigneeUserId(user.id);
    const issues = allAssignedIssues.filter((issue) => !this.isDoneLikeIssueStatus(issue.status));

    if (issues.length === 0) {
      await this.sendMessage(client, channel, 'Jag hittade inga aktiva (ej done) issues som är assignade till dig.', threadTs);
      return true;
    }

    const key = `${slackUserId}:${channel}`;
    this.store.set(key, {
      step: 'choose-issue',
      user,
      issues,
      requester: slackUserId,
    });

    const selectionMessage = this.buildSelectionMessage(issues);
    const messages = this.buildSplitPlainMessages(selectionMessage, { maxLinesPerMessage: 12 });
    for (const message of messages) {
      await this.postSlackMessage(client, channel, message, threadTs);
    }

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
      await this.sendMessage(client, replyChannel, 'Worklog-flödet avbröts.', threadTs);
      return true;
    }

    if (state.step === 'choose-issue') {
      const selection = Number.parseInt(rawText, 10);

      if (!Number.isInteger(selection) || selection < 1 || selection > state.issues.length) {
        await this.sendMessage(
          client,
          replyChannel,
          `Svara med ett nummer mellan 1 och ${state.issues.length}, eller skriv !cancel för att avbryta.`,
          threadTs
        );
        return true;
      }

      const selectedIssue = state.issues[selection - 1];
      this.store.set(key, {
        step: 'hours',
        user: state.user,
        issue: selectedIssue,
        requester: state.requester,
      });

      await this.sendMessage(client, replyChannel, this.buildHoursMessage(selectedIssue), threadTs);
      return true;
    }

    if (state.step === 'hours') {
      const parsedHours = this.parseWorklogHours(rawText);

      if (!parsedHours.ok) {
        await this.sendMessage(client, replyChannel, parsedHours.message, threadTs);
        return true;
      }

      if (!state.issue?.id) {
        this.store.delete(key);
        await this.sendMessage(
          client,
          replyChannel,
          'Kunde inte hitta internt issue-id för vald issue. Kör !worklog igen efter nästa sync.',
          threadTs
        );
        return true;
      }

      if (!state.issue?.jira_issue_id) {
        this.store.delete(key);
        await this.sendMessage(
          client,
          replyChannel,
          'Kunde inte hitta Jira issue-id för vald issue. Kör !worklog igen efter nästa sync.',
          threadTs
        );
        return true;
      }

      if (!state.user?.jira_account_id) {
        this.store.delete(key);
        await this.sendMessage(
          client,
          replyChannel,
          'Din användare saknar jira_account_id i databasen. Kör sync:users och testa igen.',
          threadTs
        );
        return true;
      }

      const startedAt = new Date(Date.now() - parsedHours.value * 60 * 60 * 1000).toISOString();
      const timeSpentSeconds = Math.round(parsedHours.value * 3600);

      let createdTempoWorklog;
      try {
        createdTempoWorklog = await this.tempoClient.createWorklog({
          issueId: state.issue.jira_issue_id,
          timeSpentSeconds,
          startedAt,
          authorAccountId: state.user.jira_account_id,
          description: 'Logged via Slack worklog command',
        });
      } catch (error) {
        const apiMessage = error?.response?.data?.message || error?.message || 'Okänt fel från Tempo API';
        await this.sendMessage(
          client,
          replyChannel,
          `Kunde inte logga i Tempo/Jira: ${this.formatter.escapeMrkdwn(String(apiMessage))}`,
          threadTs
        );
        return true;
      }

      const tempoShapeWorklog = {
        id: createdTempoWorklog?.tempoWorklogId || createdTempoWorklog?.id || createdTempoWorklog?.worklogId,
        issue: { id: String(state.issue.jira_issue_id) },
        author: { accountId: state.user.jira_account_id },
        timeSpentSeconds,
        startedAt,
      };

      try {
        await this.worklogRepository.upsertWorklogs([tempoShapeWorklog]);
      } catch (error) {
        const localMessage = error?.message || 'Okänt fel vid lokal sync';
        await this.sendMessage(
          client,
          replyChannel,
          `Loggning i Tempo/Jira lyckades men lokal sync misslyckades: ${this.formatter.escapeMrkdwn(String(localMessage))}`,
          threadTs
        );
        this.store.delete(key);
        return true;
      }

      this.store.delete(key);

      await this.sendMessage(
        client,
        replyChannel,
        `${this.buildConfirmationMessage(state.issue, parsedHours.value)}\nSynkat till Tempo/Jira.`,
        threadTs
      );
      return true;
    }

    this.store.delete(key);
    return false;
  }
}

module.exports = WorklogSetupFlow;
