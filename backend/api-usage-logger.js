require('dotenv').config();

const db = require('./db');

const PRICING = {
  'qwen-plus':        { input: 0.0004, output: 0.004 },
  'qwen-plus-latest': { input: 0.0004, output: 0.004 },
  'qwen-turbo':       { input: 0.00005, output: 0.0002 },
  'qwen3.5-plus':     { input: 0.0004, output: 0.0024 },
  'qwen3.6-plus':     { input: 0.0005, output: 0.003 },
  'qwen3.7-plus':     { input: 0.0004, output: 0.0016 }
};

function normalizeModelName(model) {
  if (!model) return null;
  return model.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

async function logApiUsage({
  provider,        // 'dashscope' or 'serpapi'
  feature,         // 'chatbot', 'itinerary', 'event_dna', 'hotels', 'flights'
  model = null,    // 'qwen-plus', 'qwen-turbo', null for serpapi
  inputTokens = 0,
  outputTokens = 0,
  success = true
}) {
  let estimatedCost = 0;

  if (provider === 'dashscope' && model) {
    const normalizedModel = normalizeModelName(model);
    if (PRICING[normalizedModel]) {
      estimatedCost =
        (inputTokens / 1000) * PRICING[normalizedModel].input +
        (outputTokens / 1000) * PRICING[normalizedModel].output;
    }
  } else if (provider === 'serpapi') {
    estimatedCost = 0; // Free plan - track quota instead of cost
  }

  try {
    await db.query(
      `INSERT INTO api_usage_log
         (provider, feature, model, input_tokens, output_tokens, estimated_cost, success)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [provider, feature, model, inputTokens, outputTokens, estimatedCost, success]
    );
  } catch (err) {
    console.error('[ApiUsageLogger] Failed to log:', err.message);
    // Never throw - logging failure should never break the
    // actual feature
  }
}

module.exports = { logApiUsage };
