'use strict';

const { logApiUsage } = require('./api-usage-logger');

function hasGemini() {
  return Boolean(process.env.GEMINI_API_KEY && String(process.env.GEMINI_API_KEY).trim());
}

function geminiModel() {
  return process.env.GEMINI_MODEL || 'gemini-2.0-flash';
}

/**
 * Call Google Gemini generateContent API.
 * @returns {Promise<string>} assistant text
 */
async function chatGemini({ systemPrompt, userBlock, feature = 'chatbot', maxTokens = 1200 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const model = geminiModel();
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    systemInstruction: systemPrompt
      ? { parts: [{ text: String(systemPrompt) }] }
      : undefined,
    contents: [{ role: 'user', parts: [{ text: String(userBlock) }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0.7,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errMsg =
      data.error?.message || data.message || `Gemini error (${response.status})`;
    logApiUsage({
      provider: 'gemini',
      feature,
      model,
      success: false,
    }).catch(() => {});
    throw new Error(errMsg);
  }

  const parts = data.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts
        .map((p) => (p && p.text ? String(p.text) : ''))
        .join('')
        .trim()
    : '';
  if (!text) throw new Error('Empty response from Gemini');

  const usage = data.usageMetadata || {};
  logApiUsage({
    provider: 'gemini',
    feature,
    model: data.modelVersion || model,
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
    success: true,
  }).catch(() => {});

  return text;
}

/**
 * Prefer Gemini; fall back to provided handlers (DashScope, then Anthropic).
 */
async function chatLlmWithFallback({
  userBlock,
  systemPrompt,
  feature = 'chatbot',
  maxTokens = 1200,
  dashScopeFn,
  anthropicFn,
}) {
  if (hasGemini()) {
    try {
      return await chatGemini({ systemPrompt, userBlock, feature, maxTokens });
    } catch (err) {
      console.warn(`Gemini failed (${feature}):`, err.message);
      if (typeof dashScopeFn === 'function') {
        try {
          return await dashScopeFn(userBlock, systemPrompt);
        } catch (dashErr) {
          console.warn('DashScope fallback failed:', dashErr.message);
          if (typeof anthropicFn === 'function') return await anthropicFn(userBlock, systemPrompt);
          throw dashErr;
        }
      }
      if (typeof anthropicFn === 'function') return await anthropicFn(userBlock, systemPrompt);
      throw err;
    }
  }
  if (typeof dashScopeFn === 'function') {
    try {
      return await dashScopeFn(userBlock, systemPrompt);
    } catch (e) {
      if (typeof anthropicFn === 'function') return await anthropicFn(userBlock, systemPrompt);
      throw e;
    }
  }
  if (typeof anthropicFn === 'function') return await anthropicFn(userBlock, systemPrompt);
  throw new Error('Configure GEMINI_API_KEY, DASHSCOPE_API_KEY, or ANTHROPIC_API_KEY');
}

module.exports = {
  hasGemini,
  geminiModel,
  chatGemini,
  chatLlmWithFallback,
};
