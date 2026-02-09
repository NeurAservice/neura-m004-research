/**
 * @file src/services/pipeline/verification.ts
 * @description Phase 4: Verification — верификация фактов с бюджетным контролем
 * @context Claim Decomposition через GPT-4.1-mini, Deep Check через GPT-4.1-nano (NLI)
 *          Три уровня деградации по бюджету. Место для будущего HHEM.
 * @dependencies services/openai.ts, services/budget.ts
 * @affects Качество верификации, стоимость
 */

import config from '../../config';
import { getOpenAIService } from '../openai';
import { TokenBudgetManager, BudgetAction } from '../budget';
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
} from '../../types/research';

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
 * Цепочка: Claims → [Claim Decomposition] → [HHEM Fast Check (FUTURE)] → [Deep Check] → Results
 *
 * @param researchResults - Результаты research фазы
 * @param options - Опции исследования
 * @param mode - Режим (simple/standard/deep)
 * @param requestId - ID запроса
 * @param budget - Менеджер бюджета (опционально)
 * @param onProgress - Callback прогресса
 */
export async function verifyAllClaims(
  researchResults: ResearchQuestionResult[],
  options: ResearchOptions,
  mode: ResearchMode,
  requestId?: string,
  budget?: TokenBudgetManager,
  onProgress?: (current: number, total: number, status: string) => void
): Promise<VerificationSummary> {
  const openai = getOpenAIService();

  // Аккумулятор OpenAI usage по моделям (для передачи в UsageTracker биллинга)
  const openaiUsageAcc: Record<string, { input: number; output: number }> = {};

  // Определяем уровень верификации по режиму и бюджету
  let verificationLevel: 'full' | 'simplified' | 'skipped' = determineVerificationLevel(mode, budget);

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
      claims: Array<{ text: string; type: 'factual' | 'analytical' | 'speculative' }>;
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
      allClaims.push({
        id: claimId++,
        text: claim.text,
        type: claim.type || 'factual',
        sourceQuestionId: result.questionId,
        originalContext: result.response.substring(0, 500),
      });
    }
  }

  logger.info('Claims decomposed', {
    request_id: requestId,
    total_claims: allClaims.length,
    by_type: {
      factual: allClaims.filter(c => c.type === 'factual').length,
      analytical: allClaims.filter(c => c.type === 'analytical').length,
      speculative: allClaims.filter(c => c.type === 'speculative').length,
    },
    model: config.openaiModelClaimDecomposition,
  });

  // Шаг 2: [HHEM Fast Check — FUTURE, пока no-op]
  // Когда HHEM будет добавлен:
  // - score >0.90 → verified, пропускают Deep Check
  // - score <0.60 → omitted
  // - score 0.60-0.90 → идут на Deep Check
  const claimsForDeepCheck = allClaims; // Пока все идут дальше

  // Шаг 3: Deep Check (GPT-4.1-nano NLI) или simplified verification
  const results: ExtendedVerificationResult[] = [];

  // Автоматические результаты для analytical и speculative
  for (const claim of allClaims.filter(c => c.type !== 'factual')) {
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

  const factualClaims = claimsForDeepCheck.filter(c => c.type === 'factual');

  // Перепроверяем уровень верификации после decomposition (бюджет мог измениться)
  if (budget) {
    verificationLevel = determineVerificationLevel(mode, budget);
  }

  if (verificationLevel === 'full' && factualClaims.length > 0) {
    // Полная верификация: Deep Check через GPT-4.1-nano NLI
    let verified = 0;

    for (const claim of factualClaims) {
      // Проверяем бюджет перед каждым deep check
      if (budget) {
        const action = budget.canContinue('verification');
        if (action === 'stop') {
          // Остальные factual claims помечаем simplified
          logger.warn('Deep check stopped by budget', {
            request_id: requestId,
            verified_so_far: verified,
            remaining: factualClaims.length - verified,
          });
          budget.addDegradation('deep_check_truncated');

          // Помечаем оставшиеся как simplified
          for (const remaining of factualClaims.slice(verified)) {
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
          factualClaims.length,
          `Проверяем: ${claim.text.substring(0, 40)}...`
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
    // Factual claims получают confidence 0.70 по умолчанию
    if (budget) budget.addDegradation('deep_check_skipped');

    for (const claim of factualClaims) {
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
    verification_level: verificationLevel,
    model_decomposition: config.openaiModelClaimDecomposition,
    model_deep_check: config.openaiModelDeepCheck,
  });

  return summary;
}

/**
 * Определяет уровень верификации по режиму и бюджету
 */
function determineVerificationLevel(
  mode: ResearchMode,
  budget?: TokenBudgetManager
): 'full' | 'simplified' | 'skipped' {
  // simple → всегда simplified (без Deep Check)
  if (mode === 'simple') return 'simplified';

  // Проверяем бюджет для standard/deep
  if (budget) {
    const action = budget.canContinue('verification');

    if (action === 'stop') return 'skipped';
    if (action === 'reduce') return 'simplified';
  }

  return 'full';
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
