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
      return '• Inga resultat';
    }

    return lines.map((line) => `• ${this.escapeMrkdwn(line)}`).join('\n');
  }

  formatProjectInfo(report) {
    if (!report || typeof report !== 'object') {
      return this.formatPlainLinesAsBullets(report);
    }

    const lines = [
      `• 📁 ${this.escapeMrkdwn(report.projectName || 'Okänt projekt')} (${this.escapeMrkdwn(report.projectKey || 'Okänd nyckel')})`,
      this.formatDetailLine('Timmar totalt', `${this.formatNumber(report.totalHours ?? 0)} h`),
      this.formatDetailLine('Arbetare', this.formatNumber(report.contributorsCount ?? 0)),
    ];

    if (report.startDate) {
      lines.push(this.formatDetailLine('Startdatum', this.escapeMrkdwn(this.formatDateOnly(report.startDate))));
    }

    if (report.lastLoggedIssue) {
      lines.push(this.formatDetailLine('Senaste logg', this.escapeMrkdwn(this.formatDateOnly(report.lastLoggedIssue))));
    }

    return lines.join('\n');
  }

  formatProjectLastWeek(report) {
    if (!report || typeof report !== 'object') {
      return this.formatPlainLinesAsBullets(report);
    }

    const lines = [
      `• ⏱️ ${this.escapeMrkdwn(report.projectName || 'Okänt projekt')} (${this.escapeMrkdwn(report.projectKey || 'okänd nyckel')})`,
      this.formatDetailLine('Timmar', `${this.formatNumber(report.totalHours ?? 0)} h`),
    ];

    if (report.formattedDuration) {
      lines.push(this.formatDetailLine('Tid', this.escapeMrkdwn(report.formattedDuration)));
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
      `• 💰 ${this.escapeMrkdwn(report.projectName || 'Okänt projekt')} (${this.escapeMrkdwn(report.projectKey || 'okänd nyckel')})`,
      this.formatDetailLine('Timmar', `${this.formatNumber(report.totalHours ?? 0)} h`),
      this.formatDetailLine('Totalkostnad', this.formatCurrency(report.totalCost ?? 0)),
      this.formatDetailLine('Deltagare', this.formatNumber(report.participantCount ?? 0)),
    ];

    if (report.missingCostCount > 0) {
      lines.push(this.formatDetailLine('Saknar cost', this.formatNumber(report.missingCostCount)));
    }

    if (Array.isArray(report.participants) && report.participants.length > 0) {
      lines.push('');
      lines.push('  Kostnadsfördelning:');

      for (const participant of report.participants) {
        const name = this.escapeMrkdwn(participant.name || 'Okänd');
        const email = participant.email ? ` (${this.escapeMrkdwn(participant.email)})` : '';
        const hours = this.formatNumber(participant.totalHours ?? 0);
        const rate = participant.costPerHour != null ? `${this.formatNumber(participant.costPerHour)} kr/h` : 'cost saknas';
        const totalCost = participant.totalCost != null ? this.formatCurrency(participant.totalCost) : 'kostnad saknas';
        lines.push(`    - ${this.formatInlineCode(`${name}${email}: ${hours} h, ${rate}, ${totalCost}`)}`);
      }
    }

    if (Array.isArray(report.missingCostUsers) && report.missingCostUsers.length > 0) {
      lines.push('');
      lines.push('  Användare utan cost:');

      for (const user of report.missingCostUsers) {
        const name = this.escapeMrkdwn(user.name || 'Okänd');
        const email = user.email ? ` (${this.escapeMrkdwn(user.email)})` : '';
        lines.push(`    - ${this.formatInlineCode(`${name}${email}: ${this.formatNumber(user.totalHours ?? 0)} h`)}`);
      }
    }

    if (report.missingCostCount > 0) {
      lines.push('');
      lines.push('  Obs: totalen är ett minimum eftersom vissa users saknar cost.');
    }

    return lines.join('\n');
  }

  formatProjectParticipants(report) {
    if (!report || typeof report !== 'object') {
      return this.formatPlainLinesAsBullets(report);
    }

    const lines = [
      `• 👥 ${this.escapeMrkdwn(report.projectName || 'Okänt projekt')} (${this.escapeMrkdwn(report.projectKey || 'okänd nyckel')})`,
      this.formatDetailLine('Antal deltagare', this.formatNumber(report.totalParticipants ?? 0)),
    ];

    if (Array.isArray(report.participants) && report.participants.length > 0) {
      lines.push('');
      lines.push('  Deltagare:');
      for (const participant of report.participants) {
        const name = this.escapeMrkdwn(participant.name || 'Okänd');
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
      `• 🗓️ ${this.escapeMrkdwn(report.projectName || 'Okänt projekt')} (${this.escapeMrkdwn(report.projectKey || 'okänd nyckel')})`,
      this.formatDetailLine('Period', this.escapeMrkdwn(report.period?.label || 'okänd period')),
      this.formatDetailLine('Total tid', `${this.formatNumber(report.totalHours ?? 0)} h`),
      this.formatDetailLine('Antal loggar', this.formatNumber(report.totalWorklogs ?? 0)),
      this.formatDetailLine('Issues', this.formatNumber(report.uniqueTaskCount ?? 0)),
    ];

    if (Array.isArray(report.tasks) && report.tasks.length > 0) {
      lines.push('');
      lines.push('  Issues:');
      for (const task of report.tasks) {
        const issueKey = this.escapeMrkdwn(task.issueKey || `ISSUE-${task.issueId || ''}`);
        const issueType = this.escapeMrkdwn(task.issueType || 'Issue');
        const title = this.escapeMrkdwn(task.title || 'Okänd task');
        const hours = this.formatNumber(task.totalHours ?? 0);
        const worklogs = this.formatNumber(task.worklogCount ?? 0);
        lines.push(`    - ${this.formatInlineCode(`${issueKey} [${issueType}] ${title}: ${hours} h (${worklogs} loggar)`)}`);
      }
    }

    return lines.join('\n');
  }

  formatWeeklyTeamReport(report) {
    if (!report || typeof report !== 'object') {
      return this.formatPlainLinesAsBullets(report);
    }

    const lines = [
      `• 👥 ${this.escapeMrkdwn(report.projectName || 'Okänt projekt')} (${this.escapeMrkdwn(report.projectKey || 'okänd nyckel')})`,
      this.formatDetailLine('Period', this.escapeMrkdwn(report.period?.label || 'okänd period')),
      this.formatDetailLine('Total tid', `${this.formatNumber(report.totalHours ?? 0)} h`),
      this.formatDetailLine('Antal loggar', this.formatNumber(report.totalWorklogs ?? 0)),
      this.formatDetailLine('Personer', this.formatNumber(report.participantCount ?? 0)),
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
      return '• 📋 Aktiva projekt\n  Inga projekt hittades';
    }

    const lines = [`• 📋 Aktiva projekt (${projects.length} totalt)`, ''];

    for (const project of projects) {
      const key = this.escapeMrkdwn(project.projectKey || 'okänd nyckel');
      const name = this.escapeMrkdwn(project.projectName || 'Okänt projekt');
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
      return '• 📈 Prognos\n  Ingen prognos hittades';
    }

    return monthlyForecast
      .map((item) => {
        const month = this.escapeMrkdwn(item.month || 'okänd månad');
        const predicted = this.formatNumber(item.predicted_hours ?? 0);
        const lowerBound = this.formatNumber(item.lower_bound ?? 0);
        const upperBound = this.formatNumber(item.upper_bound ?? 0);
        return [
          `• 📈 ${month}`,
          `  - ${this.formatInlineCode(`Prognos: ${predicted} h`)}`,
          `  - ${this.formatInlineCode(`Intervall: ${lowerBound}-${upperBound} h`)}`,
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
      lines.push('  Nuvarande år:');
      lines.push(`  - ${this.formatInlineCode(this.formatNumber(report.current_period.year ?? new Date().getFullYear(), 0))}`);
      lines.push(this.formatDetailLine('Timmar', `${this.formatNumber(report.current_period.total_hours ?? 0)} h`));
      lines.push(this.formatDetailLine('Arbetare', this.formatNumber(report.current_period.active_users ?? 0)));
      lines.push(this.formatDetailLine('Worklogs', this.formatNumber(report.current_period.worklog_count ?? 0)));
      lines.push('');
    }

    if (Array.isArray(report.previous_years) && report.previous_years.length > 0) {
      lines.push('  Tidigare år:');
      for (const yearReport of report.previous_years) {
        lines.push(`    - ${this.formatInlineCode(yearReport.year)}`);
        lines.push(`      - ${this.formatInlineCode(`Timmar: ${this.formatNumber(yearReport.total_hours ?? 0)} h`)}`);
        lines.push(`      - ${this.formatInlineCode(`Arbetare: ${this.formatNumber(yearReport.active_users ?? 0)}`)}`);
      }
      lines.push('');
    }

    if (report.summary) {
      lines.push('  Sammanfattning:');
      if (report.summary.trend) {
        lines.push(`    - ${this.formatInlineCode(`Trend: ${this.escapeMrkdwn(report.summary.trend)}`)}`);
      }
      if (report.summary.average_hours_across_years !== undefined) {
        lines.push(`    - ${this.formatInlineCode(`Snitt: ${this.formatNumber(report.summary.average_hours_across_years)} h`)}`);
      }
      if (report.summary.max_hours !== undefined) {
        lines.push(`    - ${this.formatInlineCode(`Max: ${this.formatNumber(report.summary.max_hours)} h`)}`);
      }
      if (report.summary.min_hours !== undefined) {
        lines.push(`    - ${this.formatInlineCode(`Min: ${this.formatNumber(report.summary.min_hours)} h`)}`);
      }
      if (report.summary.years_analyzed !== undefined) {
        lines.push(`    - ${this.formatInlineCode(`År analyserade: ${this.formatNumber(report.summary.years_analyzed)}`)}`);
      }
    }

    return lines.filter(Boolean).join('\n');
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
