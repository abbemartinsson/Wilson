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
    const key = this.formatter.escapeMrkdwn(issue.jira_issue_key || 'unknown key');
    const title = this.formatter.formatInlineCode(issue.title || 'Unknown issue');
    const status = this.formatter.escapeMrkdwn(issue.status || 'Unknown status');

    return `${index}. ${key} - ${title} (${status})`;
  }

  buildSelectionMessage(issues) {
    const lines = [
      'I found these issues assigned to you.',
      'Reply with the number for the issue you want to log time on, or type `!cancel` to abort.',
      '',
    ];

    issues.forEach((issue, index) => {
      lines.push(this.formatIssueCandidate(issue, index + 1));
    });

    return lines.join('\n');
  }

  buildHoursMessage(issue) {
    const key = this.formatter.escapeMrkdwn(issue.jira_issue_key || 'unknown issue');
    const title = this.formatter.escapeMrkdwn(issue.title || 'Unknown issue');

    return [
      `How many hours do you want to log on *${key}*?`,
      `• ${title}`,
      'Reply with a number, for example `1.5` or `2`.',
      'Type `!cancel` if you want to abort.',
    ].join('\n');
  }

  buildConfirmationMessage(issue, hours) {
    const key = this.formatter.escapeMrkdwn(issue.jira_issue_key || 'unknown issue');
    const title = this.formatter.escapeMrkdwn(issue.title || 'Unknown issue');
    return `Saved: ${this.formatter.formatNumber(hours)} h on *${key}* - ${title}.`;
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
      .replace(/(?:h|hours?)$/g, '')
      .replace(',', '.');

    if (!normalized) {
      return { ok: false, message: 'Enter a number of hours, for example 1.5 or 2.' };
    }

    if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) {
      return { ok: false, message: 'I could not parse the time. Enter a number, for example 1.5 or 2.' };
    }

    const hours = Number.parseFloat(normalized);
    if (!Number.isFinite(hours) || hours <= 0) {
      return { ok: false, message: 'The time must be greater than 0.' };
    }

    if (hours > 24) {
      return { ok: false, message: 'The time seems too high for a worklog. Enter a value of 24 hours or less.' };
    }

    return { ok: true, value: hours };
  }

  async start({ channel, client, threadTs, slackUserId }) {
    if (!slackUserId) {
      await this.sendMessage(client, channel, 'I could not identify your Slack account.', threadTs);
      return true;
    }

    const user = await this.userRepository.findUserBySlackAccountId(slackUserId);
    if (!user) {
      await this.sendMessage(
        client,
        channel,
        'I found no user linked to your Slack account. Send me a DM first so I can link it.',
        threadTs
      );
      return true;
    }

    const allAssignedIssues = await this.issueRepository.findIssuesByAssigneeUserId(user.id);
    const issues = allAssignedIssues.filter((issue) => !this.isDoneLikeIssueStatus(issue.status));

    if (issues.length === 0) {
      await this.sendMessage(client, channel, 'I found no active (not done) issues assigned to you.', threadTs);
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
      await this.sendMessage(client, replyChannel, 'Worklog flow was cancelled.', threadTs);
      return true;
    }

    if (state.step === 'choose-issue') {
      const selection = Number.parseInt(rawText, 10);

      if (!Number.isInteger(selection) || selection < 1 || selection > state.issues.length) {
        await this.sendMessage(
          client,
          replyChannel,
          `Reply with a number between 1 and ${state.issues.length}, or type !cancel to abort.`,
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
          'Could not find an internal issue id for the selected issue. Run !worklog again after the next sync.',
          threadTs
        );
        return true;
      }

      if (!state.issue?.jira_issue_id) {
        this.store.delete(key);
        await this.sendMessage(
          client,
          replyChannel,
          'Could not find a Jira issue id for the selected issue. Run !worklog again after the next sync.',
          threadTs
        );
        return true;
      }

      if (!state.user?.jira_account_id) {
        this.store.delete(key);
        await this.sendMessage(
          client,
          replyChannel,
          'Your user is missing jira_account_id in the database. Run sync:users and try again.',
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
        const apiMessage = error?.response?.data?.message || error?.message || 'Unknown error from Tempo API';
        await this.sendMessage(
          client,
          replyChannel,
          `Could not log time in Tempo/Jira: ${this.formatter.escapeMrkdwn(String(apiMessage))}`,
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
        const localMessage = error?.message || 'Unknown error during local sync';
        await this.sendMessage(
          client,
          replyChannel,
          `Logging in Tempo/Jira succeeded, but local sync failed: ${this.formatter.escapeMrkdwn(String(localMessage))}`,
          threadTs
        );
        this.store.delete(key);
        return true;
      }

      this.store.delete(key);

      await this.sendMessage(
        client,
        replyChannel,
        `${this.buildConfirmationMessage(state.issue, parsedHours.value)}\nSynced to Tempo/Jira.`,
        threadTs
      );
      return true;
    }

    this.store.delete(key);
    return false;
  }
}

module.exports = WorklogSetupFlow;
