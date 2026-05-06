class OutputFormatter {
  constructor({ maxOutputChars = 3500 }) {
    this.maxOutputChars = maxOutputChars;
  }

  clipText(value, maxLength = this.maxOutputChars) {
    if (!value) return '';
    const normalized = String(value).trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}\n... (output truncated)`;
  }

  escapeMrkdwn(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  extractJsonPayload(rawText) {
    const text = String(rawText || '').trim();
    if (!text) {
      return null;
    }

    const attempts = [text];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === '{' || text[index] === '[') {
        attempts.push(text.slice(index));
      }
    }

    for (const candidate of attempts) {
      try {
        return JSON.parse(candidate);
      } catch (_error) {
        // Try the next candidate.
      }
    }

    return null;
  }

  formatNumber(value, decimals = 2) {
    const numericValue = Number(value);
    if (Number.isNaN(numericValue)) {
      return String(value);
    }

    if (Number.isInteger(numericValue)) {
      return String(numericValue);
    }

    return numericValue.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  }

  formatCurrency(value) {
    const numericValue = Number(value);
    if (Number.isNaN(numericValue)) {
      return String(value);
    }

    return `${new Intl.NumberFormat('sv-SE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(numericValue)} kr`;
  }

  formatDateOnly(dateString) {
    if (!dateString) return '';
    return String(dateString).split('T')[0];
  }

  formatInlineCode(text) {
    const safe = String(text ?? '').replace(/`/g, "'");
    return `\`${safe}\``;
  }

  formatDetailLine(label, value) {
    return `  - ${this.formatInlineCode(`${label}: ${value}`)}`;
  }

  formatPlainLinesAsBullets(rawText) {
    const lines = String(rawText || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return '• No results';
    }

    return lines.map((line) => `• ${this.escapeMrkdwn(line)}`).join('\n');
  }

  formatProjectInfo(report) {
    if (!report || typeof report !== 'object') {
      return this.formatPlainLinesAsBullets(report);
    }

    const lines = [
      `• 📁 ${this.escapeMrkdwn(report.projectName || 'Unknown project')} (${this.escapeMrkdwn(report.projectKey || 'Unknown key')})`,
      this.formatDetailLine('Total hours', `${this.formatNumber(report.totalHours ?? 0)} h`),
      this.formatDetailLine('Contributors', this.formatNumber(report.contributorsCount ?? 0)),
    ];

    if (report.startDate) {
      lines.push(this.formatDetailLine('Start date', this.escapeMrkdwn(this.formatDateOnly(report.startDate))));
    }

    if (report.lastLoggedIssue) {
      lines.push(this.formatDetailLine('Last log', this.escapeMrkdwn(this.formatDateOnly(report.lastLoggedIssue))));
    }

    return lines.join('\n');
  }

  formatProjectLastWeek(report) {
    if (!report || typeof report !== 'object') {
      return this.formatPlainLinesAsBullets(report);
    }

    const lines = [
      `• ⏱️ ${this.escapeMrkdwn(report.projectName || 'Unknown project')} (${this.escapeMrkdwn(report.projectKey || 'unknown key')})`,
      this.formatDetailLine('Hours', `${this.formatNumber(report.totalHours ?? 0)} h`),
    ];

    if (report.formattedDuration) {
      lines.push(this.formatDetailLine('Time', this.escapeMrkdwn(report.formattedDuration)));
    }

    if (report.period?.label) {
      lines.push(this.formatDetailLine('Period', this.escapeMrkdwn(report.period.label)));
    }

    return lines.join('\n');
  }

  formatProjectCost(report) {
    if (!report || typeof report !== 'object') {
      return this.formatPlainLinesAsBullets(report);
    }

    const lines = [
      `• 💰 ${this.escapeMrkdwn(report.projectName || 'Unknown project')} (${this.escapeMrkdwn(report.projectKey || 'unknown key')})`,
      this.formatDetailLine('Hours', `${this.formatNumber(report.totalHours ?? 0)} h`),
      this.formatDetailLine('Total cost', this.formatCurrency(report.totalCost ?? 0)),
      this.formatDetailLine('Participants', this.formatNumber(report.participantCount ?? 0)),
    ];

    if (report.period?.label) {
      lines.splice(2, 0, this.formatDetailLine('Period', this.escapeMrkdwn(report.period.label)));
    }

    if (report.missingCostCount > 0) {
      lines.push(this.formatDetailLine('Missing cost', this.formatNumber(report.missingCostCount)));
    }

    if (Array.isArray(report.participants) && report.participants.length > 0) {
      lines.push('');
      lines.push('  Cost breakdown:');

      for (const participant of report.participants) {
        const name = this.escapeMrkdwn(participant.name || 'Unknown');
        const email = participant.email ? ` (${this.escapeMrkdwn(participant.email)})` : '';
        const hours = this.formatNumber(participant.totalHours ?? 0);
        const rate = participant.costPerHour != null ? `${this.formatNumber(participant.costPerHour)} kr/h` : 'cost missing';
        const totalCost = participant.totalCost != null ? this.formatCurrency(participant.totalCost) : 'cost missing';
        lines.push(`    - ${this.formatInlineCode(`${name}${email}: ${hours} h, ${rate}, ${totalCost}`)}`);
      }
    }

    if (Array.isArray(report.missingCostUsers) && report.missingCostUsers.length > 0) {
      lines.push('');
      lines.push('  Users without cost:');

      for (const user of report.missingCostUsers) {
        const name = this.escapeMrkdwn(user.name || 'Unknown');
        const email = user.email ? ` (${this.escapeMrkdwn(user.email)})` : '';
        lines.push(`    - ${this.formatInlineCode(`${name}${email}: ${this.formatNumber(user.totalHours ?? 0)} h`)}`);
      }
    }

    if (report.missingCostCount > 0) {
      lines.push('');
      lines.push('  Note: total cost is a minimum because some users are missing cost values.');
    }

    if (Array.isArray(report.previous_years) && report.previous_years.length > 0) {
      lines.push('');
      lines.push('  Yearly breakdown:');
      for (const yearReport of report.previous_years) {
        lines.push(`    - ${this.formatInlineCode(`${yearReport.year}: ${this.formatNumber(yearReport.total_hours ?? 0)} h, ${this.formatNumber(yearReport.active_users ?? 0)} contributors`)}`);
      }
    }

    return lines.join('\n');
  }

  formatProjectParticipants(report) {
    if (!report || typeof report !== 'object') {
      return this.formatPlainLinesAsBullets(report);
    }

    const lines = [
      `• 👥 ${this.escapeMrkdwn(report.projectName || 'Unknown project')} (${this.escapeMrkdwn(report.projectKey || 'unknown key')})`,
      this.formatDetailLine('Participant count', this.formatNumber(report.totalParticipants ?? 0)),
    ];

    if (Array.isArray(report.participants) && report.participants.length > 0) {
      lines.push('');
      lines.push('  Participants:');
      for (const participant of report.participants) {
        const name = this.escapeMrkdwn(participant.name || 'Unknown');
        const hours = this.formatNumber(participant.totalHours ?? 0);
        const email = participant.email ? ` (${this.escapeMrkdwn(participant.email)})` : '';
        lines.push(`    - ${this.formatInlineCode(`${name}${email}: ${hours} h`)}`);
      }
    }

    return lines.join('\n');
  }

  formatWeeklyReport(report) {
    if (!report || typeof report !== 'object') {
      return this.formatPlainLinesAsBullets(report);
    }

    const lines = [
      `• 🗓️ ${this.escapeMrkdwn(report.projectName || 'Unknown project')} (${this.escapeMrkdwn(report.projectKey || 'unknown key')})`,
      this.formatDetailLine('Period', this.escapeMrkdwn(report.period?.label || 'unknown period')),
      this.formatDetailLine('Total time', `${this.formatNumber(report.totalHours ?? 0)} h`),
      this.formatDetailLine('Worklogs', this.formatNumber(report.totalWorklogs ?? 0)),
      this.formatDetailLine('Issues', this.formatNumber(report.uniqueTaskCount ?? 0)),
    ];

    if (Array.isArray(report.tasks) && report.tasks.length > 0) {
      lines.push('');
      lines.push('  Issues:');
      for (const task of report.tasks) {
        const issueKey = this.escapeMrkdwn(task.issueKey || `ISSUE-${task.issueId || ''}`);
        const issueType = this.escapeMrkdwn(task.issueType || 'Issue');
        const title = this.escapeMrkdwn(task.title || 'Unknown task');
        const hours = this.formatNumber(task.totalHours ?? 0);
        const worklogs = this.formatNumber(task.worklogCount ?? 0);
        lines.push(`    - ${this.formatInlineCode(`${issueKey} [${issueType}] ${title}: ${hours} h (${worklogs} worklogs)`)}`);
      }
    }

    return lines.join('\n');
  }

  formatWeeklyTeamReport(report) {
    if (!report || typeof report !== 'object') {
      return this.formatPlainLinesAsBullets(report);
    }

    const lines = [
      `• 👥 ${this.escapeMrkdwn(report.projectName || 'Unknown project')} (${this.escapeMrkdwn(report.projectKey || 'unknown key')})`,
      this.formatDetailLine('Period', this.escapeMrkdwn(report.period?.label || 'unknown period')),
      this.formatDetailLine('Total time', `${this.formatNumber(report.totalHours ?? 0)} h`),
      this.formatDetailLine('Worklogs', this.formatNumber(report.totalWorklogs ?? 0)),
      this.formatDetailLine('People', this.formatNumber(report.participantCount ?? 0)),
    ];

    if (Array.isArray(report.participants) && report.participants.length > 0) {
      lines.push('');
      lines.push('  Team:');
      for (const person of report.participants) {
        const name = this.escapeMrkdwn(person.name || `User ${person.userId || ''}`);
        const email = person.email ? ` (${this.escapeMrkdwn(person.email)})` : '';
        const hours = this.formatNumber(person.totalHours ?? 0);
        lines.push(`    - ${this.formatInlineCode(`${name}${email}: ${hours} h`)}`);
      }
    }

    return lines.join('\n');
  }

  formatProjectList(projects) {
    if (!Array.isArray(projects)) {
      return this.formatPlainLinesAsBullets(projects);
    }

    if (projects.length === 0) {
      return '• 📋 Active projects\n  No projects found';
    }

    const lines = [`• 📋 Active projects (${projects.length} total)`, ''];

    for (const project of projects) {
      const key = this.escapeMrkdwn(project.projectKey || 'unknown key');
      const name = this.escapeMrkdwn(project.projectName || 'Unknown project');
      lines.push(`  - ${this.formatInlineCode(`${name} (${key})`)}`);
    }

    return lines.join('\n');
  }

  formatWorkloadForecast(results) {
    const monthlyForecast = Array.isArray(results)
      ? results
      : (results?.forecast?.monthly_forecast || results?.monthly_forecast || results?.forecast || []);

    if (!Array.isArray(monthlyForecast)) {
      return this.formatPlainLinesAsBullets(results);
    }

    if (monthlyForecast.length === 0) {
      return '• 📈 Forecast\n  No forecast found';
    }

    return monthlyForecast
      .map((item) => {
        const month = this.escapeMrkdwn(item.month || 'unknown month');
        const predicted = this.formatNumber(item.predicted_hours ?? 0);
        const lowerBound = this.formatNumber(item.lower_bound ?? 0);
        const upperBound = this.formatNumber(item.upper_bound ?? 0);
        return [
          `• 📈 ${month}`,
          `  - ${this.formatInlineCode(`Forecast: ${predicted} h`)}`,
          `  - ${this.formatInlineCode(`Range: ${lowerBound}-${upperBound} h`)}`,
        ].join('\n');
      })
      .join('\n\n');
  }

  formatHistoricalComparison(report) {
    if (!report || typeof report !== 'object') {
      return this.formatPlainLinesAsBullets(report);
    }

    const lines = [];

    if (report.current_period) {
      lines.push('  Current year:');
      lines.push(`  - ${this.formatInlineCode(this.formatNumber(report.current_period.year ?? new Date().getFullYear(), 0))}`);
      lines.push(this.formatDetailLine('Hours', `${this.formatNumber(report.current_period.total_hours ?? 0)} h`));
      lines.push(this.formatDetailLine('Contributors', this.formatNumber(report.current_period.active_users ?? 0)));
      lines.push(this.formatDetailLine('Worklogs', this.formatNumber(report.current_period.worklog_count ?? 0)));
      lines.push('');
    }

    if (Array.isArray(report.previous_years) && report.previous_years.length > 0) {
      lines.push('  Previous years:');
      for (const yearReport of report.previous_years) {
        lines.push(`    - ${this.formatInlineCode(yearReport.year)}`);
        lines.push(`      - ${this.formatInlineCode(`Hours: ${this.formatNumber(yearReport.total_hours ?? 0)} h`)}`);
        lines.push(`      - ${this.formatInlineCode(`Contributors: ${this.formatNumber(yearReport.active_users ?? 0)}`)}`);
      }
      lines.push('');
    }

    if (report.summary) {
      lines.push('  Summary:');
      if (report.summary.trend) {
        lines.push(`    - ${this.formatInlineCode(`Trend: ${this.escapeMrkdwn(report.summary.trend)}`)}`);
      }
      if (report.summary.average_hours_across_years !== undefined) {
        lines.push(`    - ${this.formatInlineCode(`Average: ${this.formatNumber(report.summary.average_hours_across_years)} h`)}`);
      }
      if (report.summary.max_hours !== undefined) {
        lines.push(`    - ${this.formatInlineCode(`Max: ${this.formatNumber(report.summary.max_hours)} h`)}`);
      }
      if (report.summary.min_hours !== undefined) {
        lines.push(`    - ${this.formatInlineCode(`Min: ${this.formatNumber(report.summary.min_hours)} h`)}`);
      }
      if (report.summary.years_analyzed !== undefined) {
        lines.push(`    - ${this.formatInlineCode(`Years analyzed: ${this.formatNumber(report.summary.years_analyzed)}`)}`);
      }
    }

    return lines.filter(Boolean).join('\n');
  }

  formatFullHistory(report) {
    if (!report || typeof report !== 'object') {
      return this.formatPlainLinesAsBullets(report);
    }

    const monthlyPeriods = Array.isArray(report.monthly_periods) ? report.monthly_periods : [];

    const lines = [
      `• 📚 Full history (${this.formatNumber(monthlyPeriods.length, 0)} months with data)`,
    ];

    if (report.summary) {
      lines.push(this.formatDetailLine('Total hours', `${this.formatNumber(report.summary.total_hours ?? 0)} h`));
      lines.push(this.formatDetailLine('Contributors', this.formatNumber(report.summary.unique_contributors ?? 0)));
      lines.push(this.formatDetailLine('Worklogs', this.formatNumber(report.summary.total_worklogs ?? 0)));
      if (report.summary.first_period && report.summary.last_period) {
        lines.push(this.formatDetailLine('Range', `${this.escapeMrkdwn(report.summary.first_period)} to ${this.escapeMrkdwn(report.summary.last_period)}`));
      }
    }

    if (monthlyPeriods.length > 0) {
      lines.push('');
      lines.push('  Monthly breakdown:');
      for (const period of monthlyPeriods) {
        lines.push(
          `    - ${this.formatInlineCode(`${this.escapeMrkdwn(period.period || 'unknown')}: ${this.formatNumber(period.total_hours ?? 0)} h, ${this.formatNumber(period.active_users ?? 0)} contributors`)}`
        );
      }
    }

    return lines.join('\n');
  }

  formatCommandOutput(commandName, rawOutput) {
    const parsedOutput = this.extractJsonPayload(rawOutput);

    if (parsedOutput == null) {
      return this.formatPlainLinesAsBullets(rawOutput);
    }

    if (commandName === 'project info') {
      return this.formatProjectInfo(parsedOutput);
    }

    if (commandName === 'project last week') {
      return this.formatProjectLastWeek(parsedOutput);
    }

    if (commandName === 'project cost') {
      return this.formatProjectCost(parsedOutput);
    }

    if (commandName === 'project team') {
      return this.formatProjectParticipants(parsedOutput);
    }

    if (commandName === 'report w' || commandName === 'report m') {
      return this.formatWeeklyReport(parsedOutput);
    }

    if (commandName === 'report wt' || commandName === 'report mt') {
      return this.formatWeeklyTeamReport(parsedOutput);
    }

    if (commandName === 'projects') {
      return this.formatProjectList(parsedOutput);
    }

    if (commandName === 'forecast') {
      return this.formatWorkloadForecast(parsedOutput);
    }

    if (commandName === 'history') {
      return this.formatHistoricalComparison(parsedOutput);
    }

    if (commandName === 'full history') {
      return this.formatFullHistory(parsedOutput);
    }

    if (Array.isArray(parsedOutput)) {
      return this.formatPlainLinesAsBullets(parsedOutput.map((item) => JSON.stringify(item)).join('\n'));
    }

    if (typeof parsedOutput === 'object') {
      return this.formatPlainLinesAsBullets(
        Object.entries(parsedOutput)
          .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
          .join('\n')
      );
    }

    return this.formatPlainLinesAsBullets(String(parsedOutput));
  }
}

module.exports = OutputFormatter;
