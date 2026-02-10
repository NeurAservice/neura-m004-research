/**
 * @file golden-set/providers/m004-internal.js
 * @description Custom promptfoo provider для вызова m004 Internal API
 * @context Вызывает POST /api/internal/research с длинным timeout.
 *          Provider получает prompt (строку запроса) и context (переменные из dataset).
 * @dependencies M004_API_URL, M004_INTERNAL_API_KEY env vars
 */

const crypto = require('crypto');

/** Таймаут HTTP-запроса к internal API (15 минут) */
const HTTP_TIMEOUT_MS = 900_000;

/** Пауза перед retry (10 секунд) */
const RETRY_DELAY_MS = 10_000;

/** Максимум попыток */
const MAX_ATTEMPTS = 2;

/**
 * Выполняет HTTP POST запрос с таймаутом через нативный fetch
 * @param {string} url - URL запроса
 * @param {object} body - JSON-тело запроса
 * @param {Record<string, string>} headers - Заголовки
 * @param {number} timeoutMs - Таймаут в мс
 * @returns {Promise<object>} - Распарсенный JSON ответ
 */
async function httpPost(url, body, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${text.substring(0, 500)}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ожидание заданное количество мс
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Custom provider для promptfoo.
 * Вызывается для каждого test case из dataset.
 *
 * @param {string} prompt - Строка запроса из test case ({{query}})
 * @param {object} context - Объект с переменными, включая context.vars
 * @returns {Promise<{output: string} | {error: string}>}
 */
async function callApi(prompt, context) {
  // Поддержка обоих вариантов именования env vars (M004_ prefix и без)
  const apiUrl = process.env.M004_API_URL
    || `http://localhost:${process.env.PORT || '3004'}`;
  const apiKey = process.env.M004_INTERNAL_API_KEY
    || process.env.INTERNAL_API_KEY;

  if (!apiKey) {
    return { error: 'INTERNAL_API_KEY / M004_INTERNAL_API_KEY environment variable is not set' };
  }

  const requestId = `gs-smoke-${crypto.randomUUID()}`;
  const vars = context.vars || {};

  const body = {
    query: prompt,
    caller_module: 'golden-set',
    caller_request_id: requestId,
    options: {
      mode: vars.mode || 'simple',
      language: vars.language || 'ru',
      researchType: 'facts_and_analysis',
      maxReportLength: 'medium',
    },
  };

  const headers = {
    'X-Module-Api-Key': apiKey,
    'X-Request-Id': requestId,
  };

  const url = `${apiUrl.replace(/\/$/, '')}/api/internal/research`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      process.stderr.write(
        `[golden-set] Attempt ${attempt}/${MAX_ATTEMPTS} | ${requestId} | query: "${prompt.substring(0, 60)}..."\n`
      );

      const startMs = Date.now();
      const response = await httpPost(url, body, headers, HTTP_TIMEOUT_MS);
      const durationMs = Date.now() - startMs;

      process.stderr.write(
        `[golden-set] ✅ Success | ${requestId} | ${durationMs}ms | grade: ${response.result?.grade || '?'}\n`
      );

      return { output: JSON.stringify(response) };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[golden-set] ❌ Attempt ${attempt} failed | ${requestId} | ${errorMsg}\n`
      );

      if (attempt < MAX_ATTEMPTS) {
        process.stderr.write(`[golden-set] Waiting ${RETRY_DELAY_MS / 1000}s before retry...\n`);
        await sleep(RETRY_DELAY_MS);
      } else {
        return { error: `All ${MAX_ATTEMPTS} attempts failed. Last error: ${errorMsg}` };
      }
    }
  }

  return { error: 'Unexpected: exhausted all attempts without result' };
}

module.exports = class M004InternalProvider {
  constructor(options) {
    this.providerId = options?.id || 'm004-internal';
    this.label = options?.config?.label || 'm004-internal-api';
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context) {
    return callApi(prompt, context);
  }
};
