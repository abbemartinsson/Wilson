const axios = require('axios');
const config = require('../config').jira;

const DEFAULT_BOUNDED_ALL_ISSUES_JQL = 'updated >= "1970-01-01" ORDER BY created DESC';

// Simple Jira client to wrap HTTP calls. Only the bits we need so far.

class JiraClient {
  constructor() {
    if (!config.baseUrl || !config.email || !config.apiToken) {
      throw new Error('Jira configuration is missing, make sure .env is loaded');
    }
    this.http = axios.create({
      baseURL: config.baseUrl,
      auth: {
        username: config.email,
        password: config.apiToken,
      },
      headers: {
        'Accept': 'application/json',
      },
    });
  }

  /**
   * Fetch all Jira projects visible to the configured user.
   * Returns an array of project objects as Jira delivers them.
   */
  async fetchAllProjects() {
    // The Jira API for listing projects is GET /rest/api/3/project
    const resp = await this.http.get('/rest/api/3/project');
    return resp.data; // should be an array
  }

  async fetchIssueTypesByKeys(issueKeys = []) {
    const normalizedKeys = Array.from(
      new Set(
        issueKeys
          .map((key) => String(key || '').trim().toUpperCase())
          .filter(Boolean)
      )
    );

    if (normalizedKeys.length === 0) {
      return new Map();
    }

    const result = new Map();

    for (const keyChunk of chunkArray(normalizedKeys, 50)) {
      const jql = `issueKey in (${keyChunk.map((key) => `"${key}"`).join(', ')})`;
      const response = await this.http.get('/rest/api/3/search/jql', {
        params: {
          jql,
          maxResults: keyChunk.length,
          fields: 'issuetype,key',
        },
      });

      const issues = response.data?.issues || [];
      for (const issue of issues) {
        const issueKey = String(issue?.key || '').trim().toUpperCase();
        if (!issueKey) {
          continue;
        }

        result.set(issueKey, {
          issueTypeName: String(issue?.fields?.issuetype?.name || '').trim(),
          isSubtask: Boolean(issue?.fields?.issuetype?.subtask),
        });
      }
    }

    return result;
  }

  /**
   * Fetch all Jira users.
   * Returns an array of user objects as Jira delivers them.
   */
  async fetchAllUsers() {
    // The Jira API for listing users is GET /rest/api/3/users/search
    const resp = await this.http.get('/rest/api/3/users/search', {
      params: {
        maxResults: 1000, // Fetch up to 1000 users at once
      },
    });
    return resp.data; // should be an array
  }

  /**
   * Fetch Jira issues using JQL search.
    * Default JQL fetches all visible issues with a bounded query to satisfy Jira API constraints.
   * Returns an array of issue objects as Jira delivers them.
   */
    async fetchAllIssues(jql = DEFAULT_BOUNDED_ALL_ISSUES_JQL) {
    const allIssues = [];
    let nextPageToken = null;
    const maxResults = 100;
    let hasMore = true;

    while (hasMore) {
      const params = {
        jql,
        maxResults,
        fields: 'summary,status,assignee,project,timetracking',
      };

      // Enhanced search endpoint uses token-based pagination.
      if (nextPageToken) {
        params.nextPageToken = nextPageToken;
      }

      const resp = await this.http.get('/rest/api/3/search/jql', { params });

      const issues = resp.data.issues || [];
      allIssues.push(...issues);

      nextPageToken = resp.data.nextPageToken || null;
      const isLast = typeof resp.data.isLast === 'boolean'
        ? resp.data.isLast
        : !nextPageToken;
      hasMore = !isLast;
    }

    return allIssues;
  }
}

function chunkArray(values, chunkSize) {
  const chunks = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

module.exports = new JiraClient();
