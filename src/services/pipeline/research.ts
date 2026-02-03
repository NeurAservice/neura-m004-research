/**
 * @file src/services/pipeline/research.ts
 * @description Phase 3: Research - сбор информации
 * @context Выполняет поиск по каждому research question
 */

import { getPerplexityService } from '../perplexity';
import { logger } from '../../utils/logger';
import { containsCurrentIndicators } from '../../utils/helpers';
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

  // Системный промпт для исследования
  const systemPrompt = options.language === 'ru'
    ? `Ты — исследовательский ассистент. Предоставляй точную, хорошо подкреплённую источниками информацию.
Всегда указывай источники своих утверждений. Если информация неопределённа, скажи об этом.
Отвечай на русском языке.`
    : `You are a research assistant. Provide accurate, well-sourced information.
Always cite your sources. If information is uncertain, say so.
Respond in English.`;

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
            tokensUsed: { input: 0, output: 0 },
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
