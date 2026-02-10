/**
 * @file src/services/pipeline/output.ts
 * @description Phase 5: Output — синтез финального отчёта с Source Masking, grade system, improved metrics
 * @context Claude получает ТОЛЬКО верифицированные факты + источники из SourceRegistry.
 *          Сырой research-текст НЕ передаётся. Composite score определяет grade → format.
 * @dependencies services/anthropic.ts, services/budget.ts, services/sourceRegistry.ts
 * @affects Финальный отчёт, метаданные, grade
 */

import config from '../../config';
import { getAnthropicService } from '../anthropic';
import { TokenBudgetManager, BudgetSnapshot } from '../budget';
import { SourceRegistry } from '../sourceRegistry';
import { logger } from '../../utils/logger';
import { round, average, extractNumbersFromText } from '../../utils/helpers';
import {
  ResearchOutput,
  ResearchOptions,
  PlanningResult,
  ResearchQuestionResult,
  ResearchMode,
  PartialCompletion,
  BudgetMetrics,
  Claim,
  Source,
  QualityMetrics,
  QualityGateSummary,
} from '../../types/research';
import { VerificationSummary } from './verification';

interface OutputWithUsage extends ResearchOutput {
  usage?: { input: number; output: number };
}

type ReportFormat = 'narrative' | 'bullet_list' | 'minimal';
type Grade = 'A' | 'B' | 'C' | 'F';

/**
 * Синтезирует финальный output с Source Masking
 *
 * @param query - Исходный запрос пользователя
 * @param planningResult - Результат фазы планирования
 * @param researchResults - Результаты research фазы (используются только для метаданных)
 * @param verificationSummary - Результат верификации
 * @param options - Опции исследования
 * @param mode - Режим (simple/standard/deep)
 * @param sourceRegistry - Реестр источников
 * @param requestId - ID запроса
 * @param partialCompletion - Информация о частичном выполнении (если есть)
 * @param budgetSnapshot - Снимок бюджета (если есть)
 */
export async function synthesizeOutput(
  query: string,
  planningResult: PlanningResult,
  researchResults: ResearchQuestionResult[],
  verificationSummary: VerificationSummary,
  options: ResearchOptions,
  mode: ResearchMode,
  sourceRegistry: SourceRegistry,
  requestId?: string,
  partialCompletion?: PartialCompletion,
  budgetSnapshot?: BudgetSnapshot
): Promise<OutputWithUsage> {
  const anthropic = getAnthropicService();

  // 1. Фильтруем claims по confidence threshold
  const threshold = options.confidenceThreshold;
  const allClaims: Claim[] = [];

  // Источники из SourceRegistry (единый реестр)
  const registrySources = sourceRegistry.getAllSources();
  const sources: Source[] = registrySources.map(rs => ({
    id: rs.id,
    url: rs.url,
    title: rs.title,
    domain: rs.domain,
    authority: rs.authorityScore,
    usedInClaims: [],
    date: rs.date,
    isAvailable: rs.status === 'available' || rs.status === 'unchecked',
  }));

  // Обрабатываем claims
  let omittedCount = 0;

  for (const verification of verificationSummary.allResults) {
    const originalClaim = verificationSummary.claims.find(c => c.id === verification.claimId);
    if (!originalClaim) continue;

    // sourceIds из AtomicClaim (привязаны в verification phase)
    const sourceIds = originalClaim.sourceIds || [];

    // Обновляем usedInClaims в sources
    for (const sid of sourceIds) {
      const source = sources.find(s => s.id === sid);
      if (source) {
        source.usedInClaims.push(verification.claimId);
      }
    }

    // URL-валидация: если ВСЕ источники claim-а недоступны — понижаем confidence
    let adjustedConfidence = verification.confidence;
    if (sourceIds.length > 0) {
      const claimSources = sourceIds.map(id => sources.find(s => s.id === id)).filter(Boolean);
      const allUnavailable = claimSources.length > 0 && claimSources.every(s => !s!.isAvailable);
      if (allUnavailable) {
        adjustedConfidence = Math.min(adjustedConfidence, 0.4);
        logger.debug('Claim confidence downgraded (all sources unavailable)', {
          request_id: requestId,
          claim_id: verification.claimId,
          original_confidence: verification.confidence,
          adjusted_confidence: adjustedConfidence,
        });
      }
    }

    const shouldInclude =
      adjustedConfidence >= threshold ||
      (options.includeUnverified && verification.status === 'unverifiable') ||
      originalClaim.type === 'speculative';

    if (shouldInclude) {
      allClaims.push({
        id: verification.claimId,
        text: verification.correction || originalClaim.text,
        type: originalClaim.type as Claim['type'],
        status: verification.status as Claim['status'],
        confidence: adjustedConfidence,
        correction: verification.correction,
        sourceIds,
        value: originalClaim.value,
        unit: originalClaim.unit,
      });
    } else {
      omittedCount++;

      if (options.includeUnverified) {
        allClaims.push({
          id: verification.claimId,
          text: originalClaim.text,
          type: originalClaim.type as Claim['type'],
          status: 'omitted',
          confidence: adjustedConfidence,
          sourceIds: [],
          omitReason: `Confidence ${(adjustedConfidence * 100).toFixed(0)}% below threshold ${(threshold * 100).toFixed(0)}%`,
        });
      }
    }
  }

  // 2. Вычисляем метрики качества
  const quality = calculateQualityMetrics(
    verificationSummary,
    allClaims,
    sources,
    omittedCount
  );

  // 3. Определяем grade и format
  const grade = determineGrade(quality.compositeScore);
  quality.grade = grade;

  const verifiedClaimsCount = allClaims.filter(
    c => c.status === 'verified' || c.status === 'partially_correct'
  ).length;
  const format = determineFormat(grade, verifiedClaimsCount, mode);

  // 4. Определяем модель (Haiku для simple, Sonnet для standard/deep)
  const modelForOutput = mode === 'simple'
    ? config.claudeModelSimple
    : config.claudeModel;

  // 5. Определяем maxTokens по режиму
  const maxTokensMap: Record<ResearchMode, number> = {
    simple: config.maxOutputTokensSimple,
    standard: config.maxOutputTokensStandard,
    deep: config.maxOutputTokensDeep,
  };
  const maxTokens = maxTokensMap[mode];

  // 6. SOURCE MASKING: Формируем данные для Claude — ТОЛЬКО claims + sources
  const claimsForReport = allClaims
    .filter(c => c.status === 'verified' || c.status === 'partially_correct')
    .map(c => ({
      text: c.text,
      type: c.type,
      confidence: c.confidence,
      status: c.status,
      sourceIds: c.sourceIds,
      value: c.value,
      unit: c.unit,
    }));

  const sourcesForReport = sources
    .filter(s => s.isAvailable !== false)
    .map(s => ({
      id: s.id,
      url: s.url,
      title: s.title,
      domain: s.domain,
      isAvailable: s.isAvailable !== false,
    }));

  const questionTexts = planningResult.questions.map(q => q.text);

  // Собираем topic-тэги для передачи в промпт Claude
  const questionsWithTopics = planningResult.questions.map(q => ({
    text: q.text,
    topic: q.topic || 'General',
  }));
  const uniqueTopics = [...new Set(questionsWithTopics.map(q => q.topic))];

  // 7. Генерируем отчёт через Anthropic (Source Masking)
  const reportResult = await anthropic.synthesizeReport(
    {
      query,
      questions: questionTexts,
      questionsWithTopics,
      uniqueTopicCount: uniqueTopics.length,
      verifiedClaims: claimsForReport,
      sources: sourcesForReport,
      language: options.language,
      format,
      maxTokens,
      model: modelForOutput,
    },
    requestId
  );

  // 8. Numerical validation: проверяем что числа в отчёте совпадают с claims
  validateNumericalConsistency(allClaims, reportResult.report, requestId);

  // 9. Генерируем disclaimer
  let disclaimer: string | undefined;

  // Disclaimer для высокого % omitted
  const omittedRate = verificationSummary.claims.length > 0
    ? omittedCount / verificationSummary.claims.length
    : 0;

  if (omittedRate > 0.3) {
    disclaimer = options.language === 'ru'
      ? `⚠️ **Примечание:** Часть найденной информации (${(omittedRate * 100).toFixed(0)}%) была исключена из отчёта, так как не удалось подтвердить её достоверность. Отчёт содержит только верифицированные факты.`
      : `⚠️ **Note:** Part of the found information (${(omittedRate * 100).toFixed(0)}%) was excluded from the report as it could not be verified. The report contains only verified facts.`;
  }

  // Disclaimer для упрощённой/пропущенной верификации
  if (verificationSummary.verificationLevel === 'simplified') {
    const simplifiedNote = options.language === 'ru'
      ? `ℹ️ **Верификация:** Применена упрощённая верификация (без deep check). Показатели confidence являются оценочными.`
      : `ℹ️ **Verification:** Simplified verification applied (no deep check). Confidence scores are estimates.`;
    disclaimer = disclaimer ? `${disclaimer}\n\n${simplifiedNote}` : simplifiedNote;
  } else if (verificationSummary.verificationLevel === 'skipped') {
    const skippedNote = options.language === 'ru'
      ? `⚠️ **Верификация:** Верификация фактов была пропущена из-за бюджетных ограничений. Данные основаны на результатах поиска без дополнительной проверки.`
      : `⚠️ **Verification:** Fact verification was skipped due to budget constraints. Data is based on search results without additional checks.`;
    disclaimer = disclaimer ? `${disclaimer}\n\n${skippedNote}` : skippedNote;
  }

  // Grade F disclaimer
  if (grade === 'F') {
    const gradeNote = options.language === 'ru'
      ? `⚠️ **Качество:** Качество данного исследования оценивается как низкое (Grade F). Рекомендуется критически относиться к результатам.`
      : `⚠️ **Quality:** This research quality is rated as low (Grade F). Results should be treated critically.`;
    disclaimer = disclaimer ? `${disclaimer}\n\n${gradeNote}` : gradeNote;
  }

  // 10. Собираем partial completion блок в начале отчёта
  let partialNotice = '';
  if (partialCompletion && partialCompletion.isPartial) {
    const lang = options.language;
    if (lang === 'ru') {
      partialNotice = `> ℹ️ **Частичный результат**\n` +
        `> Исследовано ${partialCompletion.coveredQuestions} из ${partialCompletion.plannedQuestions} запланированных вопросов.\n` +
        `> Уровень верификации: ${partialCompletion.verificationLevel}.\n` +
        (partialCompletion.circuitBreakerTriggered
          ? `> Бюджет ограничен (уровень: ${partialCompletion.circuitBreakerLevel}).\n`
          : '') +
        '\n';
    } else {
      partialNotice = `> ℹ️ **Partial Result**\n` +
        `> Researched ${partialCompletion.coveredQuestions} of ${partialCompletion.plannedQuestions} planned questions.\n` +
        `> Verification level: ${partialCompletion.verificationLevel}.\n` +
        (partialCompletion.circuitBreakerTriggered
          ? `> Budget constrained (level: ${partialCompletion.circuitBreakerLevel}).\n`
          : '') +
        '\n';
    }
  }

  // 11. Добавляем источники к отчёту (из SourceRegistry)
  const sourcesSection = formatSourcesSection(sources, options.language);
  const fullReport = `${partialNotice}${reportResult.report}\n\n${sourcesSection}`;

  // 12. Формируем budget metrics если есть snapshot
  let budgetMetrics: BudgetMetrics | undefined;
  if (budgetSnapshot) {
    const totalTokens = budgetSnapshot.consumed.totalTokens;
    const maxBudgetTokens = budgetSnapshot.limits.maxTokens;
    const usedPct = maxBudgetTokens > 0 ? (totalTokens / maxBudgetTokens) * 100 : 0;

    budgetMetrics = {
      mode,
      limits: { maxTokens: budgetSnapshot.limits.maxTokens, maxCostUsd: budgetSnapshot.limits.maxCostUsd },
      consumed: { totalTokens: budgetSnapshot.consumed.totalTokens, totalCostUsd: budgetSnapshot.consumed.totalCostUsd },
      byPhase: budgetSnapshot.byPhase,
      circuitBreaker: {
        triggered: budgetSnapshot.circuitBreaker.triggered,
        level: budgetSnapshot.circuitBreaker.level,
        triggeredAtPct: usedPct,
      },
      degradations: budgetSnapshot.degradations || [],
    };
  }

  logger.info('Output synthesized (Source Masking)', {
    request_id: requestId,
    claims_total: allClaims.length,
    claims_included: allClaims.filter(c => c.status !== 'omitted').length,
    claims_verified: claimsForReport.length,
    sources_total: sources.length,
    sources_available: sources.filter(s => s.isAvailable !== false).length,
    quality_score: quality.compositeScore,
    grade,
    format,
    model: modelForOutput,
    has_disclaimer: !!disclaimer,
    is_partial: partialCompletion?.isPartial || false,
    verification_level: verificationSummary.verificationLevel,
  });

  return {
    report: fullReport,
    summary: reportResult.summary,
    claims: allClaims,
    sources,
    quality,
    grade,
    metadata: {
      mode: mode,
      queryType: 'mixed',
      language: options.language,
      createdAt: new Date().toISOString(),
      pipeline_version: '2.2.0',
    },
    disclaimer,
    partialCompletion,
    budgetMetrics,
    warnings: [],            // Заполняется оркестратором после Quality Gate
    qualityGate: null,       // Заполняется оркестратором после Quality Gate
    usage: reportResult.usage,
  };
}

/**
 * Определяет grade по compositeScore
 * A ≥ 0.85, B ≥ 0.65, C ≥ 0.40, F < 0.40
 */
export function determineGrade(compositeScore: number): Grade {
  if (compositeScore >= config.gradeAThreshold) return 'A';
  if (compositeScore >= config.gradeBThreshold) return 'B';
  if (compositeScore >= config.gradeCThreshold) return 'C';
  return 'F';
}

/**
 * Определяет формат отчёта по grade, количеству фактов и режиму
 *
 * Логика narrative threshold: даже при высоком grade,
 * если фактов мало — понижаем формат.
 */
export function determineFormat(
  grade: Grade,
  verifiedFactsCount: number,
  mode: ResearchMode
): ReportFormat {
  // Narrative thresholds по режиму
  const thresholds: Record<ResearchMode, number> = {
    simple: config.narrativeThresholdSimple,
    standard: config.narrativeThresholdStandard,
    deep: config.narrativeThresholdDeep,
  };
  const narrativeThreshold = thresholds[mode];

  // Базовый формат по grade
  let baseFormat: ReportFormat;
  if (grade === 'A' || grade === 'B') {
    baseFormat = 'narrative';
  } else if (grade === 'C') {
    baseFormat = 'bullet_list';
  } else {
    baseFormat = 'minimal';
  }

  // Понижаем если фактов недостаточно для narrative
  if (baseFormat === 'narrative' && verifiedFactsCount < narrativeThreshold) {
    baseFormat = 'bullet_list';
  }

  return baseFormat;
}

/**
 * Вычисляет метрики качества (обновлённая формула)
 *
 * Формула compositeScore:
 *   verification * 0.45 + citation * 0.30 + authority * 0.15 + correction * 0.10
 *
 * verificationPassRate = (verified + partial*0.5) / totalExtracted
 */
function calculateQualityMetrics(
  verificationSummary: VerificationSummary,
  claims: Claim[],
  sources: Source[],
  omittedCount: number
): QualityMetrics {
  const totalClaims = verificationSummary.claims.length;
  const verifiedCount = verificationSummary.verified.length;
  const partiallyCorrectCount = verificationSummary.partiallyCorrect.length;
  const incorrectCount = verificationSummary.incorrect.length;
  const unverifiableCount = verificationSummary.unverifiable.length;

  // Verification pass rate: verified + partial*0.5 / total extracted
  const verificationPassRate = totalClaims > 0
    ? (verifiedCount + partiallyCorrectCount * 0.5) / totalClaims
    : 0;

  // Citation coverage (% claims with sources)
  const claimsWithSources = claims.filter(c => c.sourceIds.length > 0).length;
  const citationCoverage = claims.length > 0 ? claimsWithSources / claims.length : 0;

  // Average source authority
  const authorityScores = sources.map(s => s.authority).filter(a => a > 0);
  const sourceAuthorityScore = authorityScores.length > 0 ? average(authorityScores) : 0;

  // Correction rate (how many needed corrections)
  const correctedCount = verificationSummary.allResults.filter(r => r.correction).length;
  const correctionRate = totalClaims > 0 ? correctedCount / totalClaims : 0;

  // Omission rate
  const omissionRate = totalClaims > 0 ? omittedCount / totalClaims : 0;

  // Numerical claims count
  const numericalCount = verificationSummary.claims.filter(c => c.type === 'numerical').length;

  // Composite score (обновлённые веса)
  const compositeScore = round(
    verificationPassRate * 0.45 +
    citationCoverage * 0.30 +
    sourceAuthorityScore * 0.15 +
    (1 - correctionRate) * 0.10,
    2
  );

  return {
    compositeScore,
    verificationPassRate: round(verificationPassRate, 2),
    citationCoverage: round(citationCoverage, 2),
    sourceAuthorityScore: round(sourceAuthorityScore, 2),
    correctionRate: round(correctionRate, 2),
    omissionRate: round(omissionRate, 2),
    grade: 'F', // будет перезаписан в synthesizeOutput
    sourcesCount: sources.length,
    facts: {
      total: totalClaims,
      verified: verifiedCount,
      partiallyCorrect: partiallyCorrectCount,
      unverified: unverifiableCount,
      omitted: omittedCount,
      numerical: numericalCount,
    },
  };
}

/**
 * Проверяет числовую consistency между claims и финальным отчётом.
 * Логирует расхождения для мониторинга.
 */
function validateNumericalConsistency(
  claims: Claim[],
  report: string,
  requestId?: string
): void {
  const numericalClaims = claims.filter(c => c.value !== undefined && c.status !== 'omitted');
  if (numericalClaims.length === 0) return;

  const reportNumbers = extractNumbersFromText(report);
  const reportValues = new Set(reportNumbers.map(n => n.value));

  let mismatches = 0;
  for (const claim of numericalClaims) {
    if (claim.value !== undefined && !reportValues.has(claim.value)) {
      mismatches++;
      logger.warn('Numerical value from claim not found in report', {
        request_id: requestId,
        claim_id: claim.id,
        expected_value: claim.value,
        unit: claim.unit,
        claim_text: claim.text.substring(0, 100),
      });
    }
  }

  if (mismatches > 0) {
    logger.warn('Numerical consistency check completed with mismatches', {
      request_id: requestId,
      total_numerical_claims: numericalClaims.length,
      mismatches,
    });
  } else {
    logger.debug('Numerical consistency check passed', {
      request_id: requestId,
      total_numerical_claims: numericalClaims.length,
    });
  }
}

/**
 * Форматирует раздел источников из SourceRegistry
 */
function formatSourcesSection(sources: Source[], language: 'ru' | 'en'): string {
  const availableSources = sources.filter(s => s.isAvailable !== false);
  if (availableSources.length === 0) return '';

  const header = language === 'ru' ? '## Использованные источники' : '## Sources used';
  const sortedSources = [...availableSources].sort((a, b) => b.authority - a.authority);

  const sourceLines = sortedSources.map(s => {
    const pct = Math.round(s.authority * 100);
    let authorityLabel: string;
    if (language === 'ru') {
      if (s.authority >= 0.8) authorityLabel = 'Высокая надёжность';
      else if (s.authority >= 0.5) authorityLabel = 'Средняя надёжность';
      else authorityLabel = 'Требует проверки';
    } else {
      if (s.authority >= 0.8) authorityLabel = 'Highly reliable';
      else if (s.authority >= 0.5) authorityLabel = 'Moderately reliable';
      else authorityLabel = 'Needs review';
    }

    const title = (s.title && s.title !== 'Unknown source' && s.title !== 'unknown')
      ? s.title
      : s.domain || s.url;

    return `[src_${s.id}] [${title}](${s.url}) — ${s.domain} (${authorityLabel}, ${pct}%)`;
  });

  return `${header}\n\n${sourceLines.join('\n')}`;
}
