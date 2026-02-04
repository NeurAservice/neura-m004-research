/**
 * @file src/services/pipeline/research.ts
 * @description Phase 3: Research - сбор информации
 * @context Выполняет поиск по каждому research question
 */

import { getPerplexityService } from '../perplexity';
import { logger } from '../../utils/logger';
import { containsCurrentIndicators } from '../../utils/helpers';
import { getResearchPrompt } from '../../config/prompts';
import { getResearchDenylist } from '../../config/domains';
import {
  ResearchQuestion,
  ResearchQuestionResult,
  ResearchOptions,
} from '../../types/research';

/**
 * Выполняет исследование по всем вопросам
 */
export async function executeResearch(
  questions: ResearchQuestion[],
  options: ResearchOptions,
  requestId?: string,
  onProgress?: (questionId: number, total: number, status: string) => void
): Promise<ResearchQuestionResult[]> {
  const perplexity = getPerplexityService();
  const results: ResearchQuestionResult[] = [];

  // Определяем фильтр по свежести
  const recencyFilter = determineRecencyFilter(
    questions.map(q => q.text).join(' ')
  );

  // Используем anti-hallucination промпт из конфига
  const systemPrompt = getResearchPrompt(options.language);

  // Получаем denylist для исключения низкокачественных источников
  const domainDenylist = getResearchDenylist();

  // Выполняем запросы параллельно (с ограничением concurrency)
  const concurrency = 3;
  const chunks: ResearchQuestion[][] = [];

  for (let i = 0; i < questions.length; i += concurrency) {
    chunks.push(questions.slice(i, i + concurrency));
  }

  let completedCount = 0;

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
            domainFilter: domainDenylist,  // Исключаем Reddit, Quora и т.д.
            contextSize: 'high',            // Максимум контекста для исследований
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

          // Возвращаем пустой результат при ошибке
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

  logger.info('Research phase completed', {
    request_id: requestId,
    questions_total: questions.length,
    successful: results.filter(r => r.response).length,
    total_citations: results.reduce((sum, r) => sum + r.citations.length, 0),
    domain_filter_applied: domainDenylist.length,
    context_size: 'high',
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

  // Текущие события — строгий фильтр
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

  // Для остальных случаев — без фильтра
  return undefined;
}
