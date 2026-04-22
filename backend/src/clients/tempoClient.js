const axios = require('axios');
const config = require('../config').tempo;

// Simple Tempo client to wrap HTTP calls.
class TempoClient {
  constructor() {
    if (!config.baseUrl || !config.apiToken) {
      throw new Error('Tempo configuration is missing, make sure .env is loaded');
    }

    this.http = axios.create({
      baseURL: config.baseUrl,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.apiToken}`,
      },
    });
  }

  /**
   * Fetch all Tempo worklogs.
   * Returns an array of worklog objects as Tempo delivers them.
   */
  async fetchAllWorklogs() {
    const allWorklogs = [];
    const limit = 1000;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const resp = await this.http.get('/worklogs', {
        params: {
          offset,
          limit,
        },
      });

      const batch = resp.data.results || [];
      allWorklogs.push(...batch);

      // Tempo pagination can vary between tenants; use the safest continuation rule.
      // Keep paging while we receive full batches, stop when the API returns a short/empty batch.
      offset += batch.length;
      hasMore = batch.length === limit;
    }

    return allWorklogs;
  }

  async createWorklog({ issueId, timeSpentSeconds, startedAt, authorAccountId, description }) {
    if (!issueId) {
      throw new Error('Tempo createWorklog requires issueId');
    }

    if (!timeSpentSeconds || timeSpentSeconds <= 0) {
      throw new Error('Tempo createWorklog requires timeSpentSeconds > 0');
    }

    const startedDate = startedAt ? new Date(startedAt) : new Date();
    if (Number.isNaN(startedDate.getTime())) {
      throw new Error('Tempo createWorklog received invalid startedAt value');
    }

    const isoValue = startedDate.toISOString();
    const payload = {
      issueId: Number(issueId),
      timeSpentSeconds: Number(timeSpentSeconds),
      startDate: isoValue.slice(0, 10),
      startTime: isoValue.slice(11, 19),
      description: description || 'Logged via Slack bot',
    };

    if (authorAccountId) {
      payload.authorAccountId = authorAccountId;
    }

    const endpoints = ['/worklogs', '/core/3/worklogs'];
    let lastError = null;

    for (const endpoint of endpoints) {
      try {
        const resp = await this.http.post(endpoint, payload);
        return resp.data;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Tempo createWorklog failed without an error response');
  }
}

module.exports = new TempoClient();
