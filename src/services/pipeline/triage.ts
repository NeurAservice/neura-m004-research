/**
 * @file src/services/pipeline/triage.ts
 * @description Phase 0: Triage - классификация и анализ запроса
 * @context Определяет тип запроса и режим исследования
 */

import config from '../../config';
import { getAnthropicService } from '../anthropic';
import { logger } from '../../utils/logger';
import {
  TriageResult,
  ResearchOptions,
  QueryType,
  ResearchMode,
} from '../../types/research';

interface TriageWithUsage extends TriageResult {
  usage?: { input: number; output: number };
}

/**
 * Выполняет triage запроса
 */
export async function triage(
  query: string,
  options: ResearchOptions,
  requestId?: string
): Promise<TriageWithUsage> {
  const anthropic = getAnthropicService();

  // Если пользователь явно указал режим, используем его
  const userMode = options.mode !== 'auto' ? options.mode : undefined;

  const prompt = `Analyze this research query and classify it.

Query: "${query}"

Classify the query:

1. Query Type (what kind of information is needed):
- factual: specific facts, dates, numbers, events
- analytical: comparisons, trends, analysis
- speculative: predictions, opinions, future scenarios
- mixed: combination of above

2. Complexity (1-5):
1 = Very simple (single fact)
2 = Simple (few related facts)
3 = Moderate (requires some analysis)
4 = Complex (multiple aspects)
5 = Very complex (deep research needed)

3. Estimated research questions needed (1-10)

Respond in JSON:
{
  "queryType": "factual" | "analytical" | "speculative" | "mixed",
  "complexity": 1-5,
  "estimatedQuestions": 1-10,
  "reasoning": "brief explanation"
}`;

  const result = await anthropic.completeJson<{
    queryType: string;
    complexity: number;
    estimatedQuestions: number;
    reasoning: string;
  }>(prompt, {
    temperature: 0.1,
    requestId,
    defaultValue: {
      queryType: 'mixed',
      complexity: 3,
      estimatedQuestions: 5,
      reasoning: 'Default classification',
    },
  });

  // Определяем режим
  let mode: ResearchMode;
  let modeSource: 'auto' | 'user';

  if (userMode) {
    mode = userMode;
    modeSource = 'user';
  } else {
    // Auto-определение по complexity
    mode = result.data.complexity <= 2 ? 'simple' : 'standard';
    modeSource = 'auto';
  }

  // Ограничиваем questions по режиму
  const maxQuestions = mode === 'simple' ? config.maxQuestionsSimple : config.maxQuestionsStandard;
  const estimatedQuestions = Math.min(result.data.estimatedQuestions, maxQuestions);

  // Валидируем queryType
  const validQueryTypes: QueryType[] = ['factual', 'analytical', 'speculative', 'mixed'];
  const queryType = validQueryTypes.includes(result.data.queryType as QueryType)
    ? (result.data.queryType as QueryType)
    : 'mixed';

  // Оценки стоимости и времени
  const costPerQuestion = mode === 'simple' ? 0.03 : 0.05;
  const timePerQuestion = mode === 'simple' ? 8 : 15; // секунды

  logger.info('Triage completed', {
    request_id: requestId,
    queryType,
    mode,
    modeSource,
    estimatedQuestions,
    complexity: result.data.complexity,
  });

  return {
    queryType,
    mode,
    modeSource,
    estimatedQuestions,
    estimatedCost: {
      min: estimatedQuestions * costPerQuestion * 0.7,
      max: estimatedQuestions * costPerQuestion * 1.5,
    },
    estimatedDuration: {
      min: estimatedQuestions * timePerQuestion * 0.7,
      max: estimatedQuestions * timePerQuestion * 1.5,
    },
    usage: result.usage,
  };
}
