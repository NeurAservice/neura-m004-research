/**
 * @file src/services/pipeline/research.ts
 * @description Phase 3: Research — сбор информации с адаптивным поведением
 * @context search_context_size по режиму, budget check перед каждым вопросом, адаптивная concurrency
 * @dependencies services/perplexity.ts, services/budget.ts
 * @affects Качество и стоимость собранной информации
 */

import config from '../../config';
import { getPerplexityService } from '../perplexity';
import { TokenBudgetManager, BudgetAction } from '../budget';
import { logger } from '../../utils/logger';
import { containsCurrentIndicators } from '../../utils/helpers';
import { getResearchPrompt } from '../../config/prompts';
import { getResearchDenylist } from '../../config/domains';
import {
  ResearchQuestion,
  ResearchQuestionResult,
  ResearchOptions,
  ResearchMode,
} from '../../types/research';

/** Размер контекста поиска по режиму */
const CONTEXT_SIZE_BY_MODE: Record<ResearchMode, 'low' | 'medium' | 'high'> = {
  simple: 'low',
  standard: 'medium',
  deep: 'high',
};

/** Понижение контекста на один уровень */
function reduceContextSize(current: 'low' | 'medium' | 'high'): 'low' | 'medium' | 'high' {
  if (current === 'high') return 'medium';
  if (current === 'medium') return 'low';
  return 'low';
}

/**
 * Выполняет исследование по всем вопросам с бюджетным контролем
 * @param questions - Research-вопросы из planning
 * @param options - Опции исследования
 * @param mode - Режим (simple/standard/deep)
 * @param requestId - ID запроса
 * @param budget - Менеджер бюджета (опционально)
 * @param onProgress - Callback прогресса
 * @returns Результаты исследования (могут быть неполными при budget pressure)
 */
export async function executeResearch(
  questions: ResearchQuestion[],
  options: ResearchOptions,
  mode: ResearchMode,
  requestId?: string,
  budget?: TokenBudgetManager,
  onProgress?: (questionId: number, total: number, status: string) => void
): Promise<ResearchQuestionResult[]> {
  const perplexity = getPerplexityService();
  const results: ResearchQuestionResult[] = [];

  // Определяем фильтр по свежести
  const recencyFilter = determineRecencyFilter(
    questions.map(q => q.text).join(' ')
  );

  // Anti-hallucination промпт
  const systemPrompt = getResearchPrompt(options.language);

  // Denylist для исключения низкокачественных источников
  const domainDenylist = getResearchDenylist();

  // Размер контекста по режиму
  let contextSize = CONTEXT_SIZE_BY_MODE[mode];

  // Начальная concurrency
  let concurrency = mode === 'simple' ? 2 : 3;

  let completedCount = 0;
  let budgetStopped = false;

  // Если есть бюджет — выполняем по одному (или мелкими чанками) с проверками
  if (budget) {
    for (const question of questions) {
      if (budgetStopped) break;

      // Проверяем бюджет перед каждым вопросом
      const action: BudgetAction = budget.canContinue('research');

      if (action === 'stop') {
        logger.warn('Research stopped by budget', {
          request_id: requestId,
          completed: completedCount,
          total: questions.length,
          question_id: question.id,
        });
        budget.addDegradation('questions_truncated');
        budgetStopped = true;
        break;
      }

      if (action === 'reduce') {
        // Понижаем контекст и concurrency
        contextSize = reduceContextSize(contextSize);
        concurrency = 1;
        budget.addDegradation('search_context_reduced');
      }

      const maxTokens = budget.getMaxTokensForCall('research');

      try {
        onProgress?.(
          question.id,
          questions.length,
          `Исследуем: ${question.text.substring(0, 50)}...`
        );

        const result = await perplexity.search(question.text, {
          systemPrompt,
          recencyFilter,
          requestId,
          domainFilter: domainDenylist,
          contextSize,
          maxTokens,
        });

        // Записываем расход в бюджет
        budget.recordUsage(
          'research',
          config.perplexityModel,
          result.usage.input,
          result.usage.output,
          result.usage.totalCost
        );

        completedCount++;

        results.push({
          questionId: question.id,
          response: result.content,
          citations: result.citations,
          tokensUsed: result.usage,
        });
      } catch (error) {
        logger.error('Research question failed', {
          request_id: requestId,
          question_id: question.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        completedCount++;
        results.push({
          questionId: question.id,
          response: '',
          citations: [],
          tokensUsed: { input: 0, output: 0, searchContextTokens: 0, totalCost: 0 },
        });
      }
    }
  } else {
    // Без бюджета — стандартная параллельная обработка
    const chunks: ResearchQuestion[][] = [];
    for (let i = 0; i < questions.length; i += concurrency) {
      chunks.push(questions.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map(async (question) => {
          try {
            onProgress?.(
              question.id,
              questions.length,
              `Исследуем: ${question.text.substring(0, 50)}...`
            );

            const result = await perplexity.search(question.text, {
              systemPrompt,
              recencyFilter,
              requestId,
              domainFilter: domainDenylist,
              contextSize,
            });

            completedCount++;
            return {
              questionId: question.id,
              response: result.content,
              citations: result.citations,
              tokensUsed: result.usage,
            };
          } catch (error) {
            logger.error('Research question failed', {
              request_id: requestId,
              question_id: question.id,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
            completedCount++;
            return {
              questionId: question.id,
              response: '',
              citations: [],
              tokensUsed: { input: 0, output: 0, searchContextTokens: 0, totalCost: 0 },
            };
          }
        })
      );
      results.push(...chunkResults);
    }
  }

  logger.info('Research phase completed', {
    request_id: requestId,
    questions_total: questions.length,
    questions_completed: completedCount,
    successful: results.filter(r => r.response).length,
    total_citations: results.reduce((sum, r) => sum + r.citations.length, 0),
    domain_filter_applied: domainDenylist.length,
    context_size: contextSize,
    budget_stopped: budgetStopped,
    mode,
  });

  return results;
}

/**
 * Определяет фильтр по свежести данных
 */
function determineRecencyFilter(
  queryText: string
): 'month' | 'week' | 'day' | 'hour' | undefined {
  const text = queryText.toLowerCase();

  if (
    text.includes('сегодня') ||
    text.includes('today') ||
    text.includes('вчера') ||
    text.includes('yesterday')
  ) {
    return 'day';
  }

  if (
    text.includes('на этой неделе') ||
    text.includes('this week') ||
    text.includes('последние дни') ||
    text.includes('recent days')
  ) {
    return 'week';
  }

  if (containsCurrentIndicators(queryText)) {
    return 'month';
  }

  return undefined;
}
