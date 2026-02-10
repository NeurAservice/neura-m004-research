/**
 * @file src/services/pipeline/qualityGate.ts
 * @description Phase 5.5: Quality Gate — проверка faithfulness отчёта к верифицированным claims
 * @context Работает для standard/deep режимов. Пропускается для simple (экономия).
 *          Модель: GPT-4.1-mini. Действие при провале: downgrade грейда, добавление предупреждения.
 * @dependencies services/openai.ts, services/budget.ts, config/prompts.ts
 * @affects Грейд отчёта, warnings, compositeScore
 */

import config from '../../config';
import { getOpenAIService } from '../openai';
import { TokenBudgetManager } from '../budget';
import { getFaithfulnessCheckPrompt } from '../../config/prompts';
import { logger } from '../../utils/logger';
import { extractJsonFromText, safeJsonParse } from '../../utils/helpers';
import { ResearchMode, QualityGateResult } from '../../types/research';

/**
 * Запускает Quality Gate (faithfulness check) для отчёта
 * @param report - Текст отчёта (без секции источников)
 * @param verifiedClaims - Верифицированные claims с confidence и sourceIds
 * @param options - Режим, requestId, budgetManager
 * @returns QualityGateResult | null (null если пропущен)
 */
export async function runQualityGate(
  report: string,
  verifiedClaims: Array<{
    text: string;
    confidence: number;
    sourceIds: number[];
  }>,
  options: {
    mode: ResearchMode;
    requestId: string;
    budgetManager: TokenBudgetManager;
  }
): Promise<QualityGateResult | null> {
  const { mode, requestId, budgetManager } = options;

  // Пропуск для simple
  if (mode === 'simple') {
    logger.info('Quality Gate skipped for simple mode', {
      request_id: requestId,
    });
    return null;
  }

  // Проверка: QG отключён через конфиг
  if (!config.qualityGateEnabled) {
    logger.info('Quality Gate disabled via config', {
      request_id: requestId,
    });
    return null;
  }

  // Проверка: нет claims для проверки
  if (verifiedClaims.length === 0) {
    logger.info('Quality Gate skipped: no verified claims to check against', {
      request_id: requestId,
    });
    return null;
  }

  // Проверка бюджета
  const budgetSnapshot = budgetManager.getSnapshot();
  const remainingCostUsd = budgetSnapshot.limits.maxCostUsd - budgetSnapshot.consumed.totalCostUsd;
  const estimatedCost = 0.005; // ~5K tokens input + 1K output for GPT-4.1-mini

  if (remainingCostUsd < estimatedCost * 1.5) {
    logger.warn('Quality Gate skipped: insufficient budget', {
      request_id: requestId,
      remaining_usd: remainingCostUsd.toFixed(4),
      estimated_cost: estimatedCost,
    });
    return null;
  }

  const openai = getOpenAIService();

  try {
    // Начинаем фазу qualityGate в бюджете
    budgetManager.startPhase('qualityGate');

    // Строим промпт
    const prompt = getFaithfulnessCheckPrompt(
      report,
      verifiedClaims.map(c => ({ text: c.text, confidence: c.confidence }))
    );

    // Вызов GPT-4.1-mini
    const result = await openai.faithfulnessCheck(prompt, requestId);

    // Парсинг ответа
    const jsonText = extractJsonFromText(result.content);
    const parsed = safeJsonParse<{
      faithfulness_score: number;
      unfaithful_statements: Array<{ text: string; reason: string }>;
    }>(jsonText, {
      faithfulness_score: 1.0,
      unfaithful_statements: [],
    });

    const faithfulnessScore = typeof parsed.faithfulness_score === 'number'
      ? Math.max(0, Math.min(1, parsed.faithfulness_score))
      : 1.0;

    const qgResult: QualityGateResult = {
      passed: faithfulnessScore >= config.qualityGatePassThreshold,
      faithfulnessScore,
      unfaithfulStatements: Array.isArray(parsed.unfaithful_statements)
        ? parsed.unfaithful_statements.slice(0, 20) // Ограничиваем количество
        : [],
      usage: result.usage,
    };

    // Записываем usage в бюджет
    budgetManager.recordUsage(
      'qualityGate',
      config.qualityGateModel,
      result.usage.input,
      result.usage.output
    );

    // Логирование
    logger.info('Quality Gate result', {
      request_id: requestId,
      passed: qgResult.passed,
      faithfulness_score: qgResult.faithfulnessScore,
      threshold: config.qualityGatePassThreshold,
      unfaithful_count: qgResult.unfaithfulStatements.length,
      usage_input: qgResult.usage.input,
      usage_output: qgResult.usage.output,
    });

    return qgResult;
  } catch (error) {
    // Quality Gate не должен ломать pipeline
    logger.error('Quality Gate failed with error, skipping', {
      request_id: requestId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}

/**
 * Понижает грейд на одну ступень
 */
export function downgradeGrade(grade: 'A' | 'B' | 'C' | 'F'): 'A' | 'B' | 'C' | 'F' {
  const downgradeMap: Record<string, 'A' | 'B' | 'C' | 'F'> = {
    A: 'B',
    B: 'C',
    C: 'F',
    F: 'F',
  };
  return downgradeMap[grade] || 'F';
}
