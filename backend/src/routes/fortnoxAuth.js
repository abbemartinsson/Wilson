const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const config = require('../config').supabase;
const { encrypt } = require('../utils/crypto');

const supabase = createClient(config.url, config.serviceRoleKey);
const router = express.Router();

const FORTNOX_AUTH_URL = process.env.FORTNOX_AUTH_URL || 'https://apps.fortnox.se/oauth-v1/auth';
const FORTNOX_TOKEN_URL = process.env.FORTNOX_TOKEN_URL || 'https://apps.fortnox.se/oauth-v1/token';
const FORTNOX_OAUTH_SCOPE = String(process.env.FORTNOX_OAUTH_SCOPE || process.env.FORTNOX_SCOPE || '').trim();

function getFortnoxOAuthConfig() {
  return {
    clientId: String(process.env.FORTNOX_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.FORTNOX_CLIENT_SECRET || '').trim(),
    redirectUrl: String(process.env.FORTNOX_REDIRECT_URL || '').trim(),
  };
}

router.get('/auth/fortnox/debug-config', (_req, res) => {
  const enabled = String(process.env.FORTNOX_DEBUG_CONFIG_ENABLED || '').toLowerCase() === 'true';
  if (!enabled) {
    return res.status(404).json({ error: 'Not found' });
  }

  const { clientId, clientSecret, redirectUrl } = getFortnoxOAuthConfig();
  let redirectUrlHost = null;
  if (redirectUrl) {
    try {
      redirectUrlHost = new URL(redirectUrl).host;
    } catch (_error) {
      redirectUrlHost = 'invalid-url';
    }
  }

  return res.json({
    ok: true,
    environment: process.env.NODE_ENV || 'unknown',
    fortnox: {
      hasClientId: Boolean(clientId),
      hasClientSecret: Boolean(clientSecret),
      hasRedirectUrl: Boolean(redirectUrl),
      redirectUrlHost,
    },
    railway: {
      hasRailwayPublicDomain: Boolean(String(process.env.RAILWAY_PUBLIC_DOMAIN || '').trim()),
      hasRailwayStaticUrl: Boolean(String(process.env.RAILWAY_STATIC_URL || '').trim()),
      hasRailwayDomain: Boolean(String(process.env.RAILWAY_DOMAIN || '').trim()),
    },
  });
});

router.get('/auth/fortnox/start', async (req, res) => {
  try {
    const slackUserId = String(req.query.slack_user_id || '').trim();
    if (!slackUserId) {
      return res.status(400).json({ error: 'slack_user_id is required as query param' });
    }

    const { clientId, redirectUrl } = getFortnoxOAuthConfig();
    if (!clientId || !redirectUrl) {
      return res.status(500).json({
        error: 'Fortnox OAuth is not configured on server',
        details: {
          missing: [
            ...(!clientId ? ['FORTNOX_CLIENT_ID'] : []),
            ...(!redirectUrl ? ['FORTNOX_REDIRECT_URL'] : []),
          ],
        },
      });
    }

    const state = slackUserId;
    const scope = FORTNOX_OAUTH_SCOPE || '';
    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('redirect_uri', redirectUrl);
    params.append('response_type', 'code');
    params.append('state', state);
    if (scope) params.append('scope', scope);

    const fortnoxAuthUrl = `${FORTNOX_AUTH_URL}?${params.toString()}`;
    return res.redirect(fortnoxAuthUrl);
  } catch (error) {
    console.error('Fortnox start error:', error);
    return res.status(500).json({ error: 'Failed to start Fortnox OAuth flow' });
  }
});

router.get('/auth/fortnox/callback', async (req, res) => {
  try {
    if (req.query.error) {
      const err = String(req.query.error || '');
      const desc = String(req.query.error_description || '');
      const state = String(req.query.state || '');
      console.error('Fortnox OAuth error callback:', err, desc, 'state:', state);
      return res.status(400).send(`<html><body><h2>Fortnox OAuth error</h2><p>${err}: ${desc}</p><p>state: ${state}</p></body></html>`);
    }

    const code = String(req.query.code || '').trim();
    const state = String(req.query.state || '').trim();

    if (!code) {
      return res.status(400).json({ error: 'code is required' });
    }

    if (!state) {
      return res.status(400).json({ error: 'state is required' });
    }

    const { clientId, clientSecret, redirectUrl } = getFortnoxOAuthConfig();
    if (!clientId || !clientSecret || !redirectUrl) {
      return res.status(500).send('Fortnox callback configuration missing on server');
    }

    const tokenResp = await axios.post(
      FORTNOX_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUrl,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const tokenData = tokenResp.data || {};
    const accessToken = tokenData.access_token || tokenData.accessToken || null;
    const refreshToken = tokenData.refresh_token || tokenData.refreshToken || null;
    let encryptedAccess = null;
    let encryptedRefresh = null;
    try {
      encryptedAccess = accessToken ? encrypt(accessToken) : null;
      encryptedRefresh = refreshToken ? encrypt(refreshToken) : null;
    } catch (err) {
      console.error('Encryption error:', err.message || err);
      return res.status(500).send('Server encryption configuration missing or invalid');
    }
    const expiresIn = Number.parseInt(tokenData.expires_in || tokenData.expiresIn || 0, 10) || 0;

    const now = new Date().toISOString();
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    const row = {
      slack_user_id: state,
      fortnox_access_token: encryptedAccess,
      fortnox_refresh_token: encryptedRefresh,
      expires_at: expiresAt,
      updated_at: now,
      created_at: now,
    };

    const { error } = await supabase
      .from('integrations')
      .upsert([row], { onConflict: 'slack_user_id' });

    if (error) {
      console.error('Supabase upsert error:', error);
      return res.status(500).send('Connected to Fortnox, but failed to save tokens.');
    }

    return res.send('<html><body><h2>Fortnox connected successfully ✅</h2><p>You can close this window.</p></body></html>');
  } catch (error) {
    console.error('Fortnox callback error:', error.response?.data || error.message || error);
    return res.status(500).send('Fortnox callback processing failed');
  }
});

module.exports = router;
