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
  // Display installation URL
  app.get('/slack/install', (_req, res) => {
    const installUrl = oauthHandler.getInstallationUrl(
      process.env.SLACK_OAUTH_REDIRECT_URI || `https://${_req.get('host')}/slack/oauth_redirect`
    );

    res.json({
      message: 'Click the link below to install the Slack bot',
      installUrl,
      note: 'After installation, you will be redirected to see your bot token and other credentials to add to your .env file',
    });
  });

  // Handle OAuth callback
  app.get('/slack/oauth_redirect', async (req, res) => {
    const code = req.query.code;
    const error = req.query.error;

    if (error) {
      return res.status(400).json({
        error: `OAuth failed: ${error}`,
        description: req.query.error_description || 'No additional details',
      });
    }

    if (!code) {
      return res.status(400).json({ error: 'No authorization code provided' });
    }

    try {
      const tokenInfo = await oauthHandler.handleCallback(code);

      // Return token info in HTML for easy copy-paste
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Slack Bot Installation Complete</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
            .success { background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
            .credentials { background: #f8f9fa; border: 1px solid #dee2e6; padding: 15px; border-radius: 5px; font-family: monospace; }
            code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
            .copy-btn { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-top: 10px; }
            .copy-btn:hover { background: #0056b3; }
            .warning { background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 5px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="success">
            <h2>✅ Installation Successful!</h2>
            <p>The Slack bot has been installed to workspace: <strong>${tokenInfo.workspace_name}</strong></p>
          </div>

          <h3>Step 1: Add these environment variables to Railway or your .env file:</h3>
          <div class="credentials">
            SLACK_BOT_TOKEN=${tokenInfo.bot_token}<br>
            SLACK_BOT_USER_ID=${tokenInfo.bot_user_id}<br>
            SLACK_APP_ID=${tokenInfo.app_id}
          </div>
          <button class="copy-btn" onclick="copyToClipboard()">Copy to Clipboard</button>

          <h3>Step 2: Update your bot configuration:</h3>
          <ul>
            <li>If you were using Socket Mode, you can now use HTTP mode instead (set <code>SLACK_SOCKET_MODE=false</code>)</li>
            <li>For Socket Mode, you still need <code>SLACK_APP_TOKEN</code> from Slack App settings</li>
          </ul>

          <div class="warning">
            <strong>⚠️ Important:</strong>
            <ul>
              <li>Keep <code>SLACK_BOT_TOKEN</code> and <code>SLACK_CLIENT_SECRET</code> secret</li>
              <li>Do NOT commit these values to git (use Railway secrets instead)</li>
              <li>Restart your bot after adding the environment variables</li>
            </ul>
          </div>

          <script>
            function copyToClipboard() {
              const text = 'SLACK_BOT_TOKEN=${tokenInfo.bot_token}\\nSLACK_BOT_USER_ID=${tokenInfo.bot_user_id}\\nSLACK_APP_ID=${tokenInfo.app_id}';
              navigator.clipboard.writeText(text).then(() => {
                alert('Copied to clipboard!');
              });
            }
          </script>
        </body>
        </html>
      `;

      return res.send(html);
    } catch (error) {
      console.error('OAuth callback error:', error);
      return res.status(500).json({
        error: 'Failed to process OAuth callback',
        message: error.message,
      });
    }
  });
}

app.listen(port, () => {
  console.log(`Reporting API listening on port ${port}`);
  if (oauthHandler) {
    console.log(`Slack OAuth endpoints available at http://localhost:${port}/slack/install`);
  }
});
