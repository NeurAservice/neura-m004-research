/**
 * @file golden-set/assertions/research-quality.js
 * @description Кастомные assertion-функции для проверки качества research pipeline
 * @context Используются в promptfoo assertions как inline JavaScript.
 *          Каждая функция парсит JSON output, проверяет конкретный аспект и возвращает
 *          { pass: boolean, score: number, reason: string }.
 */

// ============================================
// Порядок грейдов для сравнения
// ============================================
const GRADE_ORDER = { 'A': 4, 'B': 3, 'C': 2, 'F': 1 };

// ============================================
// Утилита безопасного парсинга JSON
// ============================================

/**
 * Безопасно парсит JSON output от provider
 * @param {string} output - JSON-строка ответа API
 * @returns {{ data: object | null, error: string | null }}
 */
function safeParse(output) {
  try {
    if (typeof output !== 'string') {
      return { data: null, error: `Expected string, got ${typeof output}` };
    }
    return { data: JSON.parse(output), error: null };
  } catch (err) {
    return { data: null, error: `JSON parse error: ${err.message}` };
  }
}

// ============================================
// Assertion-функции
// ============================================

/**
 * Проверяет что грейд ≥ threshold (A > B > C > F)
 * @param {string} output - JSON output
 * @param {string} threshold - Минимальный допустимый грейд ('A', 'B', 'C', 'F')
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
function assertGradeAtLeast(output, threshold) {
  const { data, error } = safeParse(output);
  if (error) return { pass: false, score: 0, reason: error };

  const actualGrade = data.result?.grade;
  if (!actualGrade) return { pass: false, score: 0, reason: 'No grade in response' };

  const actualOrder = GRADE_ORDER[actualGrade] || 0;
  const minOrder = GRADE_ORDER[threshold] || 2;
  const pass = actualOrder >= minOrder;

  return {
    pass,
    score: actualOrder / 4,
    reason: `Grade: ${actualGrade}, expected >= ${threshold}`,
  };
}

/**
 * Проверяет compositeScore >= minScore
 * @param {string} output - JSON output
 * @param {number} minScore - Минимальный допустимый score (0.0–1.0)
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
function assertCompositeScoreAbove(output, minScore) {
  const { data, error } = safeParse(output);
  if (error) return { pass: false, score: 0, reason: error };

  const score = data.result?.quality?.compositeScore;
  if (score === undefined || score === null) {
    return { pass: false, score: 0, reason: 'No compositeScore in response' };
  }

  const pass = score >= minScore;
  return {
    pass,
    score,
    reason: `compositeScore: ${score.toFixed(3)}, expected >= ${minScore}`,
  };
}

/**
 * Проверяет что стоимость в допустимом диапазоне
 * @param {string} output - JSON output
 * @param {number} minCost - Минимальная ожидаемая стоимость USD
 * @param {number} maxCost - Максимальная допустимая стоимость USD
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
function assertCostInRange(output, minCost, maxCost) {
  const { data, error } = safeParse(output);
  if (error) return { pass: false, score: 0, reason: error };

  const cost = data.usage?.estimated_cost_usd;
  if (cost === undefined || cost === null) {
    return { pass: false, score: 0, reason: 'No estimated_cost_usd in usage' };
  }

  const pass = cost >= minCost && cost <= maxCost;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: `Cost: $${cost.toFixed(4)}, expected $${minCost}–$${maxCost}`,
  };
}

/**
 * Проверяет что отчёт не пустой (длина >= minLength)
 * @param {string} output - JSON output
 * @param {number} minLength - Минимальная длина отчёта в символах
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
function assertReportNotEmpty(output, minLength) {
  const { data, error } = safeParse(output);
  if (error) return { pass: false, score: 0, reason: error };

  const report = data.result?.report || '';
  const len = report.length;
  const pass = len >= minLength;

  return {
    pass,
    score: Math.min(len / minLength, 1),
    reason: `Report length: ${len} chars, expected >= ${minLength}`,
  };
}

/**
 * Проверяет наличие источников (>= minSources)
 * @param {string} output - JSON output
 * @param {number} minSources - Минимальное количество источников
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
function assertSourcesExist(output, minSources) {
  const { data, error } = safeParse(output);
  if (error) return { pass: false, score: 0, reason: error };

  const sources = data.result?.sources || [];
  const count = sources.length;
  const pass = count >= minSources;

  return {
    pass,
    score: Math.min(count / 5, 1),
    reason: `Sources: ${count}, expected >= ${minSources}`,
  };
}

/**
 * Проверяет что не все claims имеют status 'omitted'
 * @param {string} output - JSON output
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
function assertClaimsNotAllOmitted(output) {
  const { data, error } = safeParse(output);
  if (error) return { pass: false, score: 0, reason: error };

  const claims = data.result?.claims || [];
  if (claims.length === 0) {
    return { pass: false, score: 0, reason: 'No claims at all' };
  }

  const omitted = claims.filter(c => c.status === 'omitted').length;
  const pass = omitted < claims.length;

  return {
    pass,
    score: 1 - (omitted / claims.length),
    reason: `Claims: ${claims.length} total, ${omitted} omitted`,
  };
}

/**
 * Ищет ключевой факт в тексте отчёта (case-insensitive)
 * Для числовых значений — поиск с tolerance ±5%
 * @param {string} output - JSON output
 * @param {string} claimText - Подстрока для поиска
 * @returns {{ pass: boolean, score: number, reason: string }}
 */
function assertKeyClaimPresent(output, claimText) {
  const { data, error } = safeParse(output);
  if (error) return { pass: false, score: 0, reason: error };

  const report = (data.result?.report || '').toLowerCase();
  const searchText = claimText.toLowerCase();

  // Прямой поиск подстроки
  if (report.includes(searchText)) {
    return { pass: true, score: 1, reason: `Found: "${claimText}"` };
  }

  // Для числовых claims — поиск с tolerance ±5%
  const numMatch = claimText.match(/(\d+(?:\.\d+)?)/);
  if (numMatch) {
    const num = parseFloat(numMatch[1]);
    const lower = Math.floor(num * 0.95);
    const upper = Math.ceil(num * 1.05);
    for (let n = lower; n <= upper; n++) {
      if (report.includes(String(n))) {
        return { pass: true, score: 0.9, reason: `Found numeric match ~${n} for claim "${claimText}"` };
      }
    }
  }

  return { pass: false, score: 0, reason: `Not found: "${claimText}"` };
}

module.exports = {
  assertGradeAtLeast,
  assertCompositeScoreAbove,
  assertCostInRange,
  assertReportNotEmpty,
  assertSourcesExist,
  assertClaimsNotAllOmitted,
  assertKeyClaimPresent,
};
