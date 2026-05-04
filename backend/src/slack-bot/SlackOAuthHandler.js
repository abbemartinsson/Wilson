const { InstallProvider } = require('@slack/oauth');

class SlackOAuthHandler {
  constructor({ logger = console }) {
    this.logger = logger;

    // Validate required environment variables
    if (!process.env.SLACK_CLIENT_ID) {
      throw new Error('SLACK_CLIENT_ID is required for OAuth');
    }
    if (!process.env.SLACK_CLIENT_SECRET) {
      throw new Error('SLACK_CLIENT_SECRET is required for OAuth');
    }

    this.redirectUri = process.env.SLACK_OAUTH_REDIRECT_URI || 'http://localhost:3000/slack/oauth_redirect';
    this.scopes = [
      'chat:write',
      'files:write',
      'im:history',
      'users:read',
      'users:read.email',
    ];
    this.installOptions = {
      scopes: this.scopes,
      redirectUri: this.redirectUri,
    };

    this.installer = new InstallProvider({
      clientId: process.env.SLACK_CLIENT_ID,
      clientSecret: process.env.SLACK_CLIENT_SECRET,
      stateSecret: process.env.SLACK_OAUTH_STATE_SECRET || 'my-secret',
      installUrlOptions: this.installOptions,
    });
  }

  async handleInstallPath(req, res) {
    return this.installer.handleInstallPath(req, res, undefined, this.installOptions);
  }

  /**
   * Handle OAuth callback and return token info.
   * This exchanges the code with Slack and renders the success page.
   * @returns {Promise<Object>} Token info { bot_token, bot_user_id, app_id, authed_user_id, workspace_id, workspace_name }
   */
  async handleCallback(req, res) {
    let tokenInfo = null;

    try {
      await this.installer.handleCallback(
        req,
        res,
        {
          successAsync: async (installation, _installOptions, _req, response) => {
            tokenInfo = this.buildTokenInfo(installation);
            this.logger.log(
              `OAuth successful for workspace: ${tokenInfo.workspace_name} (${tokenInfo.workspace_id})`
            );
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.writeHead(200);
            response.end(this.buildSuccessHtml(tokenInfo));
          },
          failureAsync: async (error, _installOptions, _req, response) => {
            this.logger.error('OAuth callback error:', error);
            response.statusCode = 400;
            response.setHeader('Content-Type', 'application/json; charset=utf-8');
            response.end(
              JSON.stringify({
                error: 'Failed to process OAuth callback',
                message: error.message,
              })
            );
          },
        },
        this.installOptions
      );

      if (!tokenInfo) {
        throw new Error('OAuth callback finished without installation data');
      }

      return tokenInfo;
    } catch (error) {
      this.logger.error('OAuth callback error:', error);
      throw new Error(`OAuth failed: ${error.message}`);
    }
  }

  buildTokenInfo(installation) {
    return {
      bot_token: installation?.bot?.token,
      bot_user_id: installation?.bot?.userId,
      app_id: installation?.appId,
      authed_user_id: installation?.user?.id,
      workspace_id: installation?.team?.id || installation?.enterprise?.id || null,
      workspace_name: installation?.team?.name || installation?.enterprise?.name || 'Unknown workspace',
    };
  }

  buildSuccessHtml(tokenInfo) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Slack Bot Installation Complete</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
          .success { background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
          .credentials { background: #f8f9fa; border: 1px solid #dee2e6; padding: 15px; border-radius: 5px; font-family: monospace; white-space: pre-wrap; }
          code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
          .warning { background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 5px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="success">
          <h2>Installation successful</h2>
          <p>The Slack bot has been installed to workspace: <strong>${tokenInfo.workspace_name}</strong></p>
        </div>

        <h3>Add these environment variables to Railway:</h3>
        <div class="credentials">SLACK_BOT_TOKEN=${tokenInfo.bot_token}
SLACK_BOT_USER_ID=${tokenInfo.bot_user_id}
SLACK_APP_ID=${tokenInfo.app_id}
SLACK_WORKSPACE_ID=${tokenInfo.workspace_id}
SLACK_WORKSPACE_NAME=${tokenInfo.workspace_name}</div>

        <div class="warning">
          <strong>Important:</strong>
          <ul>
            <li>Keep these values secret.</li>
            <li>Do not commit them to git.</li>
            <li>Restart Railway after adding them.</li>
          </ul>
        </div>
      </body>
      </html>
    `;
  }
}

module.exports = SlackOAuthHandler;
