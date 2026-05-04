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

    this.installer = new InstallProvider({
      clientId: process.env.SLACK_CLIENT_ID,
      clientSecret: process.env.SLACK_CLIENT_SECRET,
      stateSecret: process.env.SLACK_OAUTH_STATE_SECRET || 'my-secret',
    });
  }

  /**
   * Get the installation URL for OAuth flow
   * @param {string} redirectUri - The redirect URI after OAuth approval (e.g., https://wilsonapp.up.railway.app/slack/oauth_redirect)
   * @returns {string} Installation URL
   */
  getInstallationUrl(redirectUri) {
    const scopes = [
      'chat:write',
      'files:write',
      'im:history',
      'users:read',
      'users:read.email',
    ];

    const params = new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID,
      scope: scopes.join(','),
      redirect_uri: redirectUri,
    });

    return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
  }

  /**
   * Handle OAuth callback and return token info
   * @param {string} code - OAuth code from Slack
   * @returns {Promise<Object>} Token info { bot_token, bot_user_id, app_id, authed_user_id, workspace_id, workspace_name }
   */
  async handleCallback(code) {
    try {
      const result = await this.installer.authorize({ code });

      const tokenInfo = {
        bot_token: result.botToken,
        bot_user_id: result.botUserId,
        app_id: result.appId,
        authed_user_id: result.authedUserId,
        workspace_id: result.teamId,
        workspace_name: result.teamName,
      };

      this.logger.log(`OAuth successful for workspace: ${result.teamName} (${result.teamId})`);
      return tokenInfo;
    } catch (error) {
      this.logger.error('OAuth callback error:', error);
      throw new Error(`OAuth failed: ${error.message}`);
    }
  }
}

module.exports = SlackOAuthHandler;
