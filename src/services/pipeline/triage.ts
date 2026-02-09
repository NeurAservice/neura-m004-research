/**
 * @file src/services/pipeline/triage.ts
 * @description Phase 0: Triage — классификация запроса через GPT-4.1-nano
 * @context Определяет тип запроса, режим (simple/standard/deep) и сложность
 * @dependencies services/openai.ts, config/prompts.ts
 * @affects Выбор режима pipeline, создание TokenBudgetManager
 */

import config from '../../config';
import { getOpenAIService } from '../openai';
import { TRIAGE_INSTRUCTIONS } from '../../config/prompts';
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
 * Выполняет triage запроса через GPT-4.1-nano
 * @param query - Исследовательский запрос пользователя
 * @param options - Опции исследования
 * @param requestId - ID запроса для логирования
 * @returns Результат классификации с режимом и оценками
 */
export async function triage(
  query: string,
  options: ResearchOptions,
  requestId?: string
): Promise<TriageWithUsage> {
  const openai = getOpenAIService();

  // Если пользователь явно указал режим, используем его (с валидацией)
  const validModes: ResearchMode[] = ['simple', 'standard', 'deep'];
  const userMode = options.mode !== 'auto' && validModes.includes(options.mode as ResearchMode)
    ? (options.mode as ResearchMode)
    : undefined;

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

  const result = await openai.completeJson<{
    queryType: string;
    complexity: number;
    estimatedQuestions: number;
    reasoning: string;
  }>(prompt, {
    model: config.openaiModelTriage,
    instructions: TRIAGE_INSTRUCTIONS,
    temperature: 0.1,
    maxTokens: 500,
    requestId,
    defaultValue: {
      queryType: 'mixed',
      complexity: 3,
      estimatedQuestions: 5,
      reasoning: 'Default classification',
    },
  });

  // Определяем режим: simple / standard / deep
  let mode: ResearchMode;
  let modeSource: 'auto' | 'user';

  if (userMode) {
    mode = userMode;
    modeSource = 'user';
  } else {
    // Auto-определение по complexity
    const complexity = result.data.complexity;
    if (complexity <= 2) {
      mode = 'simple';
    } else if (complexity <= 4) {
      mode = 'standard';
    } else {
      mode = 'deep';
    }
    modeSource = 'auto';
  }

  // Ограничиваем questions по режиму
  const maxQuestions = mode === 'simple'
    ? config.maxQuestionsSimple
    : mode === 'standard'
      ? config.maxQuestionsStandard
      : config.maxQuestionsDeep;

  const estimatedQuestions = Math.min(result.data.estimatedQuestions, maxQuestions);

  // Валидируем queryType
  const validQueryTypes: QueryType[] = ['factual', 'analytical', 'speculative', 'mixed'];
  const queryType = validQueryTypes.includes(result.data.queryType as QueryType)
    ? (result.data.queryType as QueryType)
    : 'mixed';

  // Оценки стоимости и времени
  const costPerQuestion: Record<ResearchMode, number> = { simple: 0.02, standard: 0.04, deep: 0.06 };
  const timePerQuestion: Record<ResearchMode, number> = { simple: 6, standard: 12, deep: 18 };

  const cost = costPerQuestion[mode];
  const time = timePerQuestion[mode];

  logger.info('Triage completed', {
    request_id: requestId,
    queryType,
    mode,
    modeSource,
    estimatedQuestions,
    complexity: result.data.complexity,
    model: config.openaiModelTriage,
  });

  return {
    queryType,
    mode,
    modeSource,
    estimatedQuestions,
    estimatedCost: {
      min: estimatedQuestions * cost * 0.7,
      max: estimatedQuestions * cost * 1.5,
    },
    estimatedDuration: {
      min: estimatedQuestions * time * 0.7,
      max: estimatedQuestions * time * 1.5,
    },
    usage: result.usage,
  };
}
