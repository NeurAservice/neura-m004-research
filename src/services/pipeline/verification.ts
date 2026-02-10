/**
 * @file src/services/pipeline/verification.ts
 * @description Phase 4: Verification — верификация фактов с бюджетным контролем
 * @context Claim Decomposition через GPT-4.1-mini, Deep Check через GPT-4.1-nano (NLI)
 *          Три уровня деградации по бюджету. Поддержка numerical claims с source_ids.
 * @dependencies services/openai.ts, services/budget.ts, services/sourceRegistry.ts
 * @affects Качество верификации, стоимость
 */

import config from '../../config';
import { getOpenAIService } from '../openai';
import { TokenBudgetManager, BudgetAction } from '../budget';
import { SourceRegistry } from '../sourceRegistry';
import {
  CLAIM_DECOMPOSITION_INSTRUCTIONS,
  DEEP_CHECK_NLI_INSTRUCTIONS,
  getClaimDecompositionPrompt,
  getDeepCheckPrompt,
} from '../../config/prompts';
import { logger } from '../../utils/logger';
import {
  ResearchQuestionResult,
  AtomicClaim,
  VerificationResult,
  ResearchOptions,
  ResearchMode,
  ClaimType,
} from '../../types/research';

type VerificationLevel = 'full' | 'simplified' | 'skipped';

interface ExtendedVerificationResult extends VerificationResult {
  usage?: { input: number; output: number; searchContextTokens: number; totalCost: number };
}

export interface VerificationSummary {
  allResults: ExtendedVerificationResult[];
  claims: AtomicClaim[];
  verified: ExtendedVerificationResult[];
  partiallyCorrect: ExtendedVerificationResult[];
  incorrect: ExtendedVerificationResult[];
  unverifiable: ExtendedVerificationResult[];
  verificationLevel: 'full' | 'simplified' | 'skipped';
  /** Агрегированный OpenAI usage по моделям для биллинга */
  openaiUsage: Record<string, { input: number; output: number }>;
}

/**
 * Верифицирует все факты из результатов исследования
 * Цепочка: Claims → [Claim Decomposition] → [Deep Check] → Results
 *
 * @param researchResults - Результаты research фазы
 * @param options - Опции исследования
 * @param mode - Режим (simple/standard/deep)
 * @param requestId - ID запроса
 * @param budget - Менеджер бюджета (опционально)
 * @param sourceRegistry - Реестр источников для привязки sourceIds
 * @param onProgress - Callback прогресса
 */
export async function verifyAllClaims(
  researchResults: ResearchQuestionResult[],
  options: ResearchOptions,
  mode: ResearchMode,
  requestId?: string,
  budget?: TokenBudgetManager,
  sourceRegistry?: SourceRegistry,
  onProgress?: (current: number, total: number, status: string) => void
): Promise<VerificationSummary> {
  const openai = getOpenAIService();

  // Аккумулятор OpenAI usage по моделям (для передачи в UsageTracker биллинга)
  const openaiUsageAcc: Record<string, { input: number; output: number }> = {};

  // Определяем уровень верификации по режиму и бюджету (без claim count ещё)
  let verificationLevel: VerificationLevel = determineVerificationLevel(mode, budget, 0, requestId);

  // Шаг 1: Claim Decomposition (GPT-4.1-mini)
  const allClaims: AtomicClaim[] = [];
  let claimId = 1;

  if (verificationLevel === 'skipped') {
    // Верификация полностью пропущена — все claims берём как есть
    logger.warn('Verification skipped due to budget', { request_id: requestId });
    if (budget) budget.addDegradation('verification_skipped');
    return createSkippedSummary(researchResults);
  }

  // Выполняем Claim Decomposition
  for (const result of researchResults) {
    if (!result.response) continue;

    // Проверяем бюджет перед decomposition
    if (budget) {
      const action = budget.canContinue('verification');
      if (action === 'stop') {
        logger.warn('Claim decomposition stopped by budget', { request_id: requestId });
        budget.addDegradation('decomposition_truncated');
        break;
      }
    }

    const maxTokens = budget ? budget.getMaxTokensForCall('claimDecomposition') : 3000;

    const prompt = getClaimDecompositionPrompt(result.response);
    const decomposed = await openai.completeJson<{
      claims: Array<{
        text: string;
        type: 'factual' | 'numerical' | 'analytical' | 'speculative';
        value?: number;
        unit?: string;
        source_index?: number | null;
      }>;
    }>(prompt, {
      model: config.openaiModelClaimDecomposition,
      instructions: CLAIM_DECOMPOSITION_INSTRUCTIONS,
      temperature: 0.2,
      maxTokens,
      requestId,
      defaultValue: { claims: [] },
    });

    // Записываем расход
    if (budget && decomposed.usage) {
      budget.recordUsage(
        'verification',
        config.openaiModelClaimDecomposition,
        decomposed.usage.input,
        decomposed.usage.output
      );
    }
    // Накапливаем для UsageTracker (биллинг)
    if (decomposed.usage) {
      const model = config.openaiModelClaimDecomposition;
      if (!openaiUsageAcc[model]) openaiUsageAcc[model] = { input: 0, output: 0 };
      openaiUsageAcc[model].input += decomposed.usage.input;
      openaiUsageAcc[model].output += decomposed.usage.output;
    }

    for (const claim of (decomposed.data.claims || [])) {
      // Валидируем тип
      const validTypes: ClaimType[] = ['factual', 'numerical', 'analytical', 'speculative'];
      const claimType: ClaimType = validTypes.includes(claim.type as ClaimType)
        ? claim.type as ClaimType
        : 'factual';

      // Привязываем sourceIds через citationMapping
      const sourceIds: number[] = [];

      if (claimType === 'numerical' && claim.source_index != null && sourceRegistry) {
        // Для numerical claims: source_index → citationMapping → sourceRegistryId
        const citMapping = result.citationMapping;
        if (citMapping) {
          const registryId = citMapping.get(claim.source_index - 1); // [N] → citations[N-1]
          if (registryId !== undefined) {
            sourceIds.push(registryId);
          }
        }
      }

      // Для всех claims: извлекаем [src_N] из текста (если маппинг уже применён)
      const srcRefPattern = /\[src_(\d+)\]/g;
      let srcMatch: RegExpExecArray | null;
      while ((srcMatch = srcRefPattern.exec(claim.text)) !== null) {
        const srcId = parseInt(srcMatch[1], 10);
        if (!sourceIds.includes(srcId)) {
          sourceIds.push(srcId);
        }
      }

      // Также для не-numerical: пробуем парсить [N] из текста и маппить
      if (claimType !== 'numerical' && sourceRegistry) {
        const citRefPattern = /\[(\d+)\]/g;
        let citMatch: RegExpExecArray | null;
        while ((citMatch = citRefPattern.exec(claim.text)) !== null) {
          const citIndex = parseInt(citMatch[1], 10) - 1; // [N] → citations[N-1]
          const citMapping = result.citationMapping;
          if (citMapping) {
            const registryId = citMapping.get(citIndex);
            if (registryId !== undefined && !sourceIds.includes(registryId)) {
              sourceIds.push(registryId);
            }
          }
        }
      }

      allClaims.push({
        id: claimId++,
        text: claim.text,
        type: claimType,
        sourceQuestionId: result.questionId,
        originalContext: result.response.substring(0, 500),
        value: claimType === 'numerical' ? claim.value : undefined,
        unit: claimType === 'numerical' ? claim.unit : undefined,
        sourceIndex: claimType === 'numerical' ? (claim.source_index ?? null) : undefined,
        sourceIds,
      });
    }
  }

  logger.info('Claims decomposed', {
    request_id: requestId,
    total_claims: allClaims.length,
    by_type: {
      factual: allClaims.filter(c => c.type === 'factual').length,
      numerical: allClaims.filter(c => c.type === 'numerical').length,
      analytical: allClaims.filter(c => c.type === 'analytical').length,
      speculative: allClaims.filter(c => c.type === 'speculative').length,
    },
    model: config.openaiModelClaimDecomposition,
  });

  // Шаг 2: Deep Check (GPT-4.1-nano NLI) или simplified verification
  const results: ExtendedVerificationResult[] = [];

  // Автоматические результаты для analytical и speculative
  for (const claim of allClaims.filter(c => c.type === 'analytical' || c.type === 'speculative')) {
    results.push({
      claimId: claim.id,
      status: claim.type === 'speculative' ? 'unverifiable' : 'verified',
      confidence: claim.type === 'speculative' ? 0.5 : 0.7,
      verificationSources: [],
      explanation: claim.type === 'speculative'
        ? 'Marked as speculation/opinion'
        : 'Analytical claim - underlying facts should be verified',
    });
  }

  // Numerical claims без sourceIds → автоматически unverifiable
  const numericalWithoutSources = allClaims.filter(c => c.type === 'numerical' && c.sourceIds.length === 0);
  for (const claim of numericalWithoutSources) {
    results.push({
      claimId: claim.id,
      status: 'unverifiable',
      confidence: 0.0,
      verificationSources: [],
      explanation: 'Numerical claim without source reference',
    });
    logger.warn('Numerical claim without source rejected', {
      request_id: requestId,
      claim_text: claim.text.substring(0, 100),
      value: claim.value,
      unit: claim.unit,
    });
  }

  // Claims, подлежащие Deep Check: factual + numerical (с sourceIds)
  const claimsForDeepCheck = allClaims.filter(c =>
    c.type === 'factual' || (c.type === 'numerical' && c.sourceIds.length > 0)
  );

  // Перепроверяем уровень верификации после decomposition (бюджет мог измениться + теперь знаем claim count)
  if (budget) {
    verificationLevel = determineVerificationLevel(mode, budget, claimsForDeepCheck.length, requestId);
  }

  if (verificationLevel === 'full' && claimsForDeepCheck.length > 0) {
    // Полная верификация: Deep Check через GPT-4.1-nano NLI
    let verified = 0;

    for (const claim of claimsForDeepCheck) {
      // Проверяем бюджет перед каждым deep check
      if (budget) {
        const action = budget.canContinue('verification');
        if (action === 'stop') {
          logger.warn('Deep check stopped by budget', {
            request_id: requestId,
            verified_so_far: verified,
            remaining: claimsForDeepCheck.length - verified,
          });
          budget.addDegradation('deep_check_truncated');

          // Помечаем оставшиеся как simplified
          for (const remaining of claimsForDeepCheck.slice(verified)) {
            results.push({
              claimId: remaining.id,
              status: 'verified',
              confidence: 0.70,
              verificationSources: [],
              explanation: 'Verification budget exceeded, simplified check',
            });
          }
          break;
        }
      }

      try {
        onProgress?.(
          verified + 1,
          claimsForDeepCheck.length,
          options.language === 'en'
            ? `Verifying fact (${verified + 1}/${claimsForDeepCheck.length}): ${claim.text.substring(0, 70)}${claim.text.length > 70 ? '...' : ''}`
            : `Проверяем факт (${verified + 1}/${claimsForDeepCheck.length}): ${claim.text.substring(0, 70)}${claim.text.length > 70 ? '...' : ''}`
        );

        const maxTokens = budget ? budget.getMaxTokensForCall('deepCheck') : 500;
        const prompt = getDeepCheckPrompt(claim.text, claim.originalContext);

        const checkResult = await openai.completeJson<{
          status: string;
          confidence: number;
          explanation: string;
        }>(prompt, {
          model: config.openaiModelDeepCheck,
          instructions: DEEP_CHECK_NLI_INSTRUCTIONS,
          temperature: 0.1,
          maxTokens,
          requestId,
          defaultValue: {
            status: 'unverifiable',
            confidence: 0.5,
            explanation: 'Failed to parse verification result',
          },
        });

        // Записываем расход
        if (budget && checkResult.usage) {
          budget.recordUsage(
            'verification',
            config.openaiModelDeepCheck,
            checkResult.usage.input,
            checkResult.usage.output
          );
        }
        // Накапливаем для UsageTracker (биллинг)
        if (checkResult.usage) {
          const model = config.openaiModelDeepCheck;
          if (!openaiUsageAcc[model]) openaiUsageAcc[model] = { input: 0, output: 0 };
          openaiUsageAcc[model].input += checkResult.usage.input;
          openaiUsageAcc[model].output += checkResult.usage.output;
        }

        const validStatuses = ['verified', 'partially_correct', 'unverifiable'];
        const status = validStatuses.includes(checkResult.data.status)
          ? checkResult.data.status as 'verified' | 'partially_correct' | 'unverifiable'
          : 'unverifiable';

        const confidence = Math.max(0, Math.min(1, checkResult.data.confidence || 0.5));

        results.push({
          claimId: claim.id,
          status,
          confidence,
          verificationSources: [],
          explanation: checkResult.data.explanation || '',
        });

        verified++;
      } catch (error) {
        logger.error('Deep check failed', {
          request_id: requestId,
          claim_id: claim.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        results.push({
          claimId: claim.id,
          status: 'unverifiable',
          confidence: 0.3,
          verificationSources: [],
          explanation: 'Deep check failed due to error',
        });

        verified++;
      }
    }
  } else if (verificationLevel === 'simplified') {
    // Simplified: только Claim Decomposition, без Deep Check
    if (budget) budget.addDegradation('deep_check_skipped');

    for (const claim of claimsForDeepCheck) {
      results.push({
        claimId: claim.id,
        status: 'verified',
        confidence: 0.70,
        verificationSources: [],
        explanation: 'Simplified verification (no deep check)',
      });
    }
  }

  // Сортируем по claimId
  results.sort((a, b) => a.claimId - b.claimId);

  // Группируем результаты
  const summary: VerificationSummary = {
    allResults: results,
    claims: allClaims,
    verified: results.filter(r => r.status === 'verified'),
    partiallyCorrect: results.filter(r => r.status === 'partially_correct'),
    incorrect: results.filter(r => r.status === 'incorrect'),
    unverifiable: results.filter(r => r.status === 'unverifiable'),
    verificationLevel,
    openaiUsage: openaiUsageAcc,
  };

  logger.info('Verification completed', {
    request_id: requestId,
    total: results.length,
    verified: summary.verified.length,
    partially_correct: summary.partiallyCorrect.length,
    incorrect: summary.incorrect.length,
    unverifiable: summary.unverifiable.length,
    numerical_claims: allClaims.filter(c => c.type === 'numerical').length,
    numerical_without_source: numericalWithoutSources.length,
    verification_level: verificationLevel,
    model_decomposition: config.openaiModelClaimDecomposition,
    model_deep_check: config.openaiModelDeepCheck,
  });

  return summary;
}

/**
 * Определяет уровень верификации по режиму, бюджету и количеству claims (адаптивный)
 *
 * Базовые уровни:
 *   simple → simplified, standard → full (если бюджет), deep → full
 *
 * Адаптивное повышение:
 *   Если после research фазы осталось достаточно бюджета — повышаем уровень.
 *   simple: skipped → simplified (НО НЕ до full)
 *   standard: simplified → full
 *
 * @param mode - Режим исследования
 * @param budget - Менеджер бюджета
 * @param claimCount - Количество claims (для оценки стоимости, 0 если ещё неизвестно)
 * @param requestId - ID запроса для логирования
 */
function determineVerificationLevel(
  mode: ResearchMode,
  budget?: TokenBudgetManager,
  claimCount: number = 0,
  requestId?: string
): VerificationLevel {
  // Базовый уровень по режиму
  const baseLevel: Record<ResearchMode, VerificationLevel> = {
    simple: 'simplified',
    standard: 'full',
    deep: 'full',
  };

  let level = baseLevel[mode];

  // Проверяем бюджет — может понизить уровень
  if (budget) {
    const action = budget.canContinue('verification');

    if (action === 'stop') {
      level = 'skipped';
    } else if (action === 'reduce' && level === 'full') {
      level = 'simplified';
    }
  }

  // Адаптивное повышение (только если включено и бюджет позволяет)
  if (config.adaptiveVerificationEnabled && budget && claimCount > 0) {
    const snapshot = budget.getSnapshot();
    const remaining = snapshot.limits.maxCostUsd - snapshot.consumed.totalCostUsd;
    const remainingRatio = snapshot.limits.maxCostUsd > 0
      ? remaining / snapshot.limits.maxCostUsd
      : 0;

    // Оценка стоимости верификации
    const estimatedSimplifiedCost = claimCount * 0.0001;
    const estimatedDeepCheckCost = claimCount * 0.0003;

    if (level === 'skipped' && mode === 'simple') {
      // simple: skipped → simplified (только если бюджета достаточно)
      if (remainingRatio > config.adaptiveVerificationMinRemainingRatio &&
          remaining > estimatedSimplifiedCost * 2) {
        level = 'simplified';
        logger.info('Adaptive verification: elevated skipped → simplified', {
          request_id: requestId,
          mode,
          remaining_ratio: remainingRatio.toFixed(2),
          remaining_budget: remaining.toFixed(4),
          claim_count: claimCount,
        });
      }
    }

    if (level === 'simplified' && mode !== 'simple') {
      // standard/deep: simplified → full (если бюджета хватает)
      if (remainingRatio > 0.45 && remaining > estimatedDeepCheckCost * 2) {
        level = 'full';
        logger.info('Adaptive verification: elevated simplified → full', {
          request_id: requestId,
          mode,
          remaining_ratio: remainingRatio.toFixed(2),
          remaining_budget: remaining.toFixed(4),
          claim_count: claimCount,
        });
      }
    }
  }

  logger.info('Verification level determined', {
    request_id: requestId,
    mode,
    base_level: baseLevel[mode],
    final_level: level,
    was_elevated: level !== baseLevel[mode],
    claim_count: claimCount,
    adaptive_enabled: config.adaptiveVerificationEnabled,
  });

  return level;
}

/**
 * Создаёт результат при полностью пропущенной верификации
 */
function createSkippedSummary(researchResults: ResearchQuestionResult[]): VerificationSummary {
  const claims: AtomicClaim[] = [];
  const results: ExtendedVerificationResult[] = [];

  // При skipped — все ответы идут как один "claim" на вопрос
  let claimId = 1;
  for (const result of researchResults) {
    if (!result.response) continue;

    claims.push({
      id: claimId,
      text: result.response.substring(0, 200),
      type: 'factual',
      sourceQuestionId: result.questionId,
      originalContext: result.response.substring(0, 500),
      sourceIds: [],
    });

    results.push({
      claimId,
      status: 'unverifiable',
      confidence: 0.5,
      verificationSources: [],
      explanation: 'Verification skipped due to budget constraints',
    });

    claimId++;
  }

  return {
    allResults: results,
    claims,
    verified: [],
    partiallyCorrect: [],
    incorrect: [],
    unverifiable: results,
    verificationLevel: 'skipped',
    openaiUsage: {},
  };
}
