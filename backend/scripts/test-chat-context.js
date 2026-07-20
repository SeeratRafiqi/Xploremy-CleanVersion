'use strict';

require('dotenv').config();

const { resolveChatContextFallback } = require('../chat-context-resolver');
const { chatLlmWithFallback } = require('../gemini-client');
const { resolveChatContext, CONTEXT_RESOLVER_SYSTEM_PROMPT } = require('../chat-context-resolver');

const CALENDAR =
  'CALENDAR: Today in Malaysia: Tuesday, 30 June 2026 (ISO date 2026-06-30).';

const SEQUENCES = [
  {
    name: 'Concerts → cheaper follow-up',
    history: [
      { role: 'user', content: 'show me concerts this weekend' },
      { role: 'assistant', content: 'Here are some concerts for you!' },
    ],
    message: 'any cheaper ones?',
  },
  {
    name: 'Jazz → next month',
    history: [
      { role: 'user', content: 'jazz events in KL' },
      { role: 'assistant', content: 'Found jazz events in KL.' },
    ],
    message: 'what about next month?',
  },
  {
    name: 'Topic switch concerts → food',
    history: [
      { role: 'user', content: 'concerts this weekend' },
      { role: 'assistant', content: 'Here are concerts.' },
    ],
    message: 'any food festivals?',
  },
];

async function callLlm(userBlock, systemPrompt) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const base =
    process.env.DASHSCOPE_BASE_URL ||
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
  const model = process.env.DASHSCOPE_MODEL || 'qwen-plus';
  async function dashScopeFn(block, prompt) {
    const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: block },
        ],
        max_tokens: 700,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'DashScope error');
    return String(data.choices?.[0]?.message?.content || '').trim();
  }
  return chatLlmWithFallback({
    userBlock,
    systemPrompt,
    feature: 'chat_context_test',
    maxTokens: 700,
    dashScopeFn: dashScopeFn,
    anthropicFn: null,
  });
}

function printResolved(label, seq, resolved) {
  console.log(`\n=== ${seq.name} [${label}] ===`);
  console.log('Latest:', seq.message);
  console.log('followUp:', resolved.isFollowUp, '| reset:', resolved.isTopicReset);
  console.log('standaloneQuery:', resolved.standaloneQuery);
  console.log('keywords:', (resolved.keywords || []).join(', ') || '(none)');
  console.log('dateRange:', JSON.stringify(resolved.dateRange));
}

async function main() {
  console.log('Rule-based fallback (offline):');
  for (const seq of SEQUENCES) {
    printResolved('rules', seq, resolveChatContextFallback(seq.message, seq.history));
  }

  if (!process.env.GEMINI_API_KEY && !process.env.DASHSCOPE_API_KEY) {
    console.log('\nNo API keys — skipped live LLM tests.');
    return;
  }

  console.log('\nLive LLM context resolver:');
  for (const seq of SEQUENCES) {
    const resolved = await resolveChatContext({
      message: seq.message,
      history: seq.history,
      calendarBlock: CALENDAR,
      callLlm,
    });
    printResolved(resolved.source, seq, resolved);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
