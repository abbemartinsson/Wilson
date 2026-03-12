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

module.exports = new JiraClient();
