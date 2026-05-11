const axios = require('axios');
const userRepository = require('../repositories/userRepository');
const { decrypt, encrypt } = require('../utils/crypto');

const FORTNOX_TOKEN_URL = process.env.FORTNOX_TOKEN_URL || 'https://apps.fortnox.se/oauth-v1/token';
const FORTNOX_API_BASE_URL = String(process.env.FORTNOX_API_BASE_URL || 'https://api.fortnox.se').trim().replace(/\/$/, '');
const rawInvoiceEndpoint = String(process.env.FORTNOX_INVOICE_ENDPOINT || '/3/customerinvoices').trim();
const FORTNOX_INVOICE_ENDPOINT = rawInvoiceEndpoint
  ? (rawInvoiceEndpoint.startsWith('/') ? rawInvoiceEndpoint : `/${rawInvoiceEndpoint}`)
  : '/3/customerinvoices';
const FORTNOX_INVOICE_PAGE_SIZE = Number.parseInt(process.env.FORTNOX_INVOICE_PAGE_SIZE, 10) || 50;
const FORTNOX_INVOICE_MAX_PAGES = Number.parseInt(process.env.FORTNOX_INVOICE_MAX_PAGES, 10) || 5;

function normalizeProjectKey(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeLookupValue(value) {
  return String(value || '').trim().toUpperCase();
}

function getFortnoxOAuthConfig() {
  return {
    clientId: String(process.env.FORTNOX_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.FORTNOX_CLIENT_SECRET || '').trim(),
  };
}

function getBasicAuthorizationHeader() {
  const { clientId, clientSecret } = getFortnoxOAuthConfig();
  if (!clientId || !clientSecret) {
    throw new Error('FORTNOX_CLIENT_ID and FORTNOX_CLIENT_SECRET must be set');
  }

  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

function getInvoiceItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  const candidates = [
    payload?.CustomerInvoices,
    payload?.customerInvoices,
    payload?.CustomerInvoice,
    payload?.customerInvoice,
    payload?.Invoices,
    payload?.invoices,
    payload?.Data,
    payload?.data,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function getResponseMeta(payload) {
  return payload?.MetaInformation || payload?.metaInformation || payload?.Meta || payload?.meta || null;
}

function getTotalPages(meta) {
  const totalPages = Number.parseInt(meta?.TotalPages ?? meta?.totalPages, 10);
  return Number.isNaN(totalPages) ? null : totalPages;
}

function getInvoiceProjectField(invoice) {
  const candidates = [
    invoice?.pr,
    invoice?.PR,
    invoice?.Project,
    invoice?.project,
    invoice?.ProjectNumber,
    invoice?.projectNumber,
    invoice?.projectKey,
    invoice?.project_key,
    invoice?.Project?.Value,
    invoice?.Project?.Code,
    invoice?.Project?.Project,
    invoice?.Project?.Number,
    invoice?.Project?.Id,
    invoice?.project?.Value,
    invoice?.project?.Code,
    invoice?.project?.Project,
    invoice?.project?.Number,
    invoice?.project?.Id,
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim() !== '') {
      return String(candidate).trim();
    }
  }

  return null;
}

function isProjectMatch(invoice, projectKey) {
  const normalizedProjectKey = normalizeProjectKey(projectKey);
  if (!normalizedProjectKey) {
    return false;
  }

  const invoiceProjectField = getInvoiceProjectField(invoice);
  if (!invoiceProjectField) {
    return false;
  }

  return normalizeLookupValue(invoiceProjectField) === normalizedProjectKey;
}

function summarizeInvoice(invoice) {
  return {
    documentNumber: invoice?.DocumentNumber ?? invoice?.InvoiceNumber ?? invoice?.Number ?? invoice?.CustomerInvoiceNumber ?? null,
    invoiceDate: invoice?.InvoiceDate ?? invoice?.Date ?? invoice?.Created ?? invoice?.DueDate ?? null,
    total: invoice?.Total ?? invoice?.TotalAmount ?? invoice?.TotalToPay ?? invoice?.Gross ?? null,
    currency: invoice?.Currency ?? invoice?.currency ?? null,
    status: invoice?.Status ?? invoice?.State ?? invoice?.status ?? null,
    projectField: getInvoiceProjectField(invoice),
    customerName: invoice?.CustomerName ?? invoice?.Customer?.Name ?? invoice?.Customer?.CustomerName ?? null,
  };
}

async function refreshFortnoxAccessToken(refreshToken) {
  const response = await axios.post(
    FORTNOX_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: getBasicAuthorizationHeader(),
      },
    }
  );

  const tokenData = response.data || {};
  const accessToken = tokenData.access_token || tokenData.accessToken || null;
  const nextRefreshToken = tokenData.refresh_token || tokenData.refreshToken || refreshToken || null;

  if (!accessToken) {
    throw new Error('Fortnox did not return a refreshed access token');
  }

  return {
    accessToken,
    refreshToken: nextRefreshToken,
  };
}

async function fetchFortnoxInvoicePages(accessToken) {
  const invoices = [];
  let pagesFetched = 0;
  let page = 1;

  while (page <= FORTNOX_INVOICE_MAX_PAGES) {
    const response = await axios.get(`${FORTNOX_API_BASE_URL}${FORTNOX_INVOICE_ENDPOINT}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      params: {
        page,
        limit: FORTNOX_INVOICE_PAGE_SIZE,
      },
    });

    const items = getInvoiceItems(response.data);
    invoices.push(...items);
    pagesFetched += 1;

    const meta = getResponseMeta(response.data);
    const totalPages = getTotalPages(meta);
    if (items.length < FORTNOX_INVOICE_PAGE_SIZE) {
      break;
    }

    if (totalPages && page >= totalPages) {
      break;
    }

    page += 1;
  }

  return {
    invoices,
    pagesFetched,
  };
}

async function fetchFortnoxInvoicesWithRetry({ accessToken, refreshToken, userId }) {
  try {
    return await fetchFortnoxInvoicePages(accessToken);
  } catch (error) {
    const statusCode = error?.response?.status;
    if (!refreshToken || (statusCode !== 401 && statusCode !== 403)) {
      throw error;
    }

    const refreshed = await refreshFortnoxAccessToken(refreshToken);
    const encryptedAccessToken = encrypt(refreshed.accessToken);
    const encryptedRefreshToken = refreshed.refreshToken ? encrypt(refreshed.refreshToken) : null;

    await userRepository.updateFortnoxTokensByUserId(userId, {
      fortnoxAccessToken: encryptedAccessToken,
      fortnoxRefreshToken: encryptedRefreshToken,
    });

    const retryResult = await fetchFortnoxInvoicePages(refreshed.accessToken);
    return {
      ...retryResult,
      refreshedToken: true,
    };
  }
}

async function testFortnoxInvoiceLookup({ slackUserId, projectKey, logger = console }) {
  const normalizedProjectKey = normalizeProjectKey(projectKey);
  if (!slackUserId) {
    const error = new Error('Slack user id is required');
    error.code = 'MISSING_SLACK_USER';
    throw error;
  }

  if (!normalizedProjectKey) {
    const error = new Error('Project key is required');
    error.code = 'MISSING_PROJECT_KEY';
    throw error;
  }

  const user = await userRepository.findUserBySlackAccountIdWithFortnoxTokens(slackUserId);
  if (!user) {
    const error = new Error('Could not find a linked Slack user for Fortnox lookup');
    error.code = 'USER_NOT_FOUND';
    throw error;
  }

  if (!user.fortnox_access_token || !user.fortnox_refresh_token) {
    const error = new Error('Fortnox is not connected for this user');
    error.code = 'FORTNOX_NOT_CONNECTED';
    throw error;
  }

  let accessToken;
  let refreshToken;
  try {
    accessToken = decrypt(user.fortnox_access_token);
    refreshToken = decrypt(user.fortnox_refresh_token);
  } catch (error) {
    logger.error('Failed to decrypt Fortnox tokens', {
      userId: user.id,
      slackUserId,
      error: error.message,
    });
    const decryptError = new Error('Fortnox tokens could not be decrypted');
    decryptError.code = 'FORTNOX_TOKEN_DECRYPT_FAILED';
    throw decryptError;
  }

  const lookup = await fetchFortnoxInvoicesWithRetry({
    accessToken,
    refreshToken,
    userId: user.id,
  });

  const matchedInvoices = lookup.invoices.filter((invoice) => isProjectMatch(invoice, normalizedProjectKey));
  const summaries = matchedInvoices.slice(0, 5).map((invoice) => summarizeInvoice(invoice));

  return {
    ok: true,
    slackUserId,
    userId: user.id,
    userName: user.name || null,
    projectKey: normalizedProjectKey,
    invoicesChecked: lookup.invoices.length,
    pagesFetched: lookup.pagesFetched,
    invoiceEndpoint: `${FORTNOX_API_BASE_URL}${FORTNOX_INVOICE_ENDPOINT}`,
    refreshedToken: Boolean(lookup.refreshedToken),
    matchedCount: matchedInvoices.length,
    firstMatch: summaries[0] || null,
    matchedInvoices: summaries,
  };
}

module.exports = {
  testFortnoxInvoiceLookup,
};
