const axios = require('axios');
const reportingService = require('../forecasting/reportingService');

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'llama3';
const DEFAULT_LANGUAGE = 'Swedish';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_ANALYTICS_MONTHS = 6;
const DEFAULT_FORECAST_MONTHS = 3;

async function generateAssistantReply(userQuestion) {
  const question = String(userQuestion || '').trim();

  if (!question) {
    return 'Jag behöver en fråga för att kunna hjälpa till.';
  }

  const context = await buildDataContext(question);
  const prompt = buildPrompt({ question, context });

  return callOllama(prompt);
}

async function buildDataContext(question) {
  const context = {
    generatedAt: new Date().toISOString(),
    question,
  };

  const now = new Date();
  const monthsBack = Number.parseInt(process.env.AI_ANALYTICS_MONTHS, 10) || DEFAULT_ANALYTICS_MONTHS;
  const startDate = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);

  try {
    context.workloadAnalytics = await reportingService.getWorkloadAnalytics({
      startDate,
      endDate: now,
    });
  } catch (error) {
    console.error('Could not fetch workload analytics for AI context:', error.message);
    context.workloadAnalytics = null;
  }

  try {
    const forecastMonths = Number.parseInt(process.env.AI_FORECAST_MONTHS, 10) || DEFAULT_FORECAST_MONTHS;
    context.forecastSummary = await reportingService.getWorkloadForecastSummary(forecastMonths);
  } catch (error) {
    console.error('Could not fetch forecast summary for AI context:', error.message);
    context.forecastSummary = null;
  }

  const mentionedProjectKey = extractProjectKey(question);
  if (mentionedProjectKey) {
    try {
      context.projectInfo = await reportingService.getProjectInfo(mentionedProjectKey);
    } catch (error) {
      console.error('Could not fetch project info for AI context:', error.message);
      context.projectInfo = null;
    }
  }

  return context;
}

function extractProjectKey(question) {
  // Match likely Jira project keys like ABC or ABCD from natural language.
  const match = String(question || '').toUpperCase().match(/\b([A-Z]{2,10})\b/);
  return match ? match[1] : null;
}

function buildPrompt({ question, context }) {
  const answerLanguage = process.env.AI_RESPONSE_LANGUAGE || DEFAULT_LANGUAGE;

  return [
    'You are a project planning assistant for internal delivery analytics.',
    '',
    'User question:',
    question,
    '',
    'Data from Supabase analytics backend:',
    JSON.stringify(context, null, 2),
    '',
    'Instructions:',
    `- Answer in ${answerLanguage}`,
    '- Be concise and concrete',
    '- Use numbers and percentages when available in provided data',
    '- If data is missing, state that clearly and avoid inventing values',
    '- Keep business logic grounded in provided backend analytics',
  ].join('\n');
}

async function callOllama(prompt) {
  const ollamaUrl = process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL;
  const ollamaModel = process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL;
  const timeoutMs = Number.parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS;

  const response = await axios.post(
    `${ollamaUrl}/api/generate`,
    {
      model: ollamaModel,
      prompt,
      stream: false,
    },
    {
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json' },
    }
  );

  const answer = response?.data?.response;
  if (!answer || !String(answer).trim()) {
    return 'Jag kunde inte generera ett svar just nu. Prova igen.';
  }

  return String(answer).trim();
}

module.exports = {
  generateAssistantReply,
};
