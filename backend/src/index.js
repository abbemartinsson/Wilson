require('dotenv').config({ path: './src/config/.env' });

const express = require('express');
const reportingService = require('./forecasting/reportingService');
const analyticsService = require('./forecasting/analyticsService');
const SlackOAuthHandler = require('./slack-bot/SlackOAuthHandler');

const app = express();
const port = Number.parseInt(process.env.PORT, 10) || 3000;

app.use(express.json());

// Initialize OAuth handler if enabled
let oauthHandler = null;
if (process.env.SLACK_ENABLE_OAUTH === 'true') {
  try {
    oauthHandler = new SlackOAuthHandler({ logger: console });
  } catch (error) {
    console.warn('OAuth handler initialization failed:', error.message);
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'reporting-api', timestamp: new Date().toISOString() });
});

app.get('/api/reporting/project-info', async (req, res) => {
  try {
    const projectKey = String(req.query.projectKey || '').trim();
    if (!projectKey) {
      return res.status(400).json({ error: 'projectKey is required' });
    }

    const report = await reportingService.getProjectInfo(projectKey);
    if (!report) {
      return res.status(404).json({ error: `No project found for key: ${projectKey}` });
    }

    return res.json(report);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.get('/api/reporting/project-last-week-hours', async (req, res) => {
  try {
    const projectKey = String(req.query.projectKey || '').trim();
    if (!projectKey) {
      return res.status(400).json({ error: 'projectKey is required' });
    }

    const report = await reportingService.getProjectLastWeekHours(projectKey);
    if (!report) {
      return res.status(404).json({ error: `No project found for key: ${projectKey}` });
    }

    return res.json(report);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.get('/api/reporting/search-projects', async (req, res) => {
  try {
    const query = String(req.query.query || '').trim();
    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    const projects = await reportingService.searchProjects(query);
    return res.json(projects);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.get('/api/reporting/workload-forecast', async (req, res) => {
  try {
    const months = Number.parseInt(req.query.months, 10) || 3;
    if (months < 1 || months > 12) {
      return res.status(400).json({ error: 'months must be between 1 and 12' });
    }

    const forecast = await reportingService.getWorkloadForecast(months);
    return res.json(forecast);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.get('/api/reporting/historical', async (req, res) => {
  try {
    const now = new Date();
    const month = Number.parseInt(req.query.month, 10) || (now.getMonth() + 1);
    const year = Number.parseInt(req.query.year, 10) || now.getFullYear();
    const yearsBack = Number.parseInt(req.query.yearsBack, 10) || 3;

    if (month < 1 || month > 12) {
      return res.status(400).json({ error: 'month must be between 1 and 12' });
    }

    const comparison = await reportingService.getHistoricalWorkloadComparison({
      month,
      year,
      yearsBack,
    });

    return res.json(comparison);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.get('/api/reporting/analytics', async (req, res) => {
  try {
    const monthsBack = Number.parseInt(req.query.monthsBack, 10) || 6;
    if (monthsBack < 1 || monthsBack > 24) {
      return res.status(400).json({ error: 'monthsBack must be between 1 and 24' });
    }

    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);

    const analytics = await reportingService.getWorkloadAnalytics({
      startDate,
      endDate: now,
    });

    return res.json(analytics);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.get('/api/reporting/worklogs', async (req, res) => {
  try {
    const startDateParam = req.query.startDate;
    const endDateParam = req.query.endDate;
    const projectKey = String(req.query.projectKey || '').trim() || undefined;

    const options = {};
    if (startDateParam) {
      const parsedStart = new Date(String(startDateParam));
      if (Number.isNaN(parsedStart.getTime())) {
        return res.status(400).json({ error: 'startDate must be an ISO date string' });
      }
      options.startDate = parsedStart;
    }

    if (endDateParam) {
      const parsedEnd = new Date(String(endDateParam));
      if (Number.isNaN(parsedEnd.getTime())) {
        return res.status(400).json({ error: 'endDate must be an ISO date string' });
      }
      options.endDate = parsedEnd;
    }

    if (projectKey) {
      options.projectKey = projectKey.toUpperCase();
    }

    const worklogs = await analyticsService.getHistoricalWorklogs(options);
    return res.json({
      total: worklogs.length,
      worklogs,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// OAuth endpoints
if (oauthHandler) {
  // Start OAuth install flow
  app.get('/slack/install', async (req, res) => {
    try {
      await oauthHandler.handleInstallPath(req, res);
    } catch (error) {
      console.error('OAuth install error:', error);
      return res.status(500).json({
        error: 'Failed to start OAuth installation',
        message: error.message,
      });
    }
  });

  // Handle OAuth callback
  app.get('/slack/oauth_redirect', async (req, res) => {
    try {
      await oauthHandler.handleCallback(req, res);
    } catch (error) {
      console.error('OAuth callback error:', error);
      return res.status(500).json({
        error: 'Failed to process OAuth callback',
        message: error.message,
      });
    }
  });
}

// Fortnox OAuth endpoints
let fortnoxAuthRouter = null;
try {
  fortnoxAuthRouter = require('./routes/fortnoxAuth');
  app.use('/', fortnoxAuthRouter);
  console.log('✓ Fortnox auth endpoints registered');
} catch (e) {
  console.error('✗ Fortnox auth router failed to load:', e.message, e.stack);
}

app.listen(port, () => {
  console.log(`Reporting API listening on port ${port}`);
  if (oauthHandler) {
    console.log(`Slack OAuth endpoints available at http://localhost:${port}/slack/install`);
  }
  if (fortnoxAuthRouter) {
    console.log(`Fortnox OAuth endpoints available at http://localhost:${port}/auth/fortnox/start`);
  }
});
