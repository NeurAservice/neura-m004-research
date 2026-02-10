/**
 * @file src/services/anthropic.ts
 * @description Клиент для Anthropic Claude API
 * @context Используется для планирования (Phase 2), синтеза (Phase 5) и анализа.
 *          Поддерживает Source Masking: Phase 5 получает только verified claims + sources.
 * @dependencies config, types/errors, utils/logger, utils/helpers
 * @affects Стоимость Claude API, качество финального отчёта
 */

import config from '../config';
import { AIProviderError } from '../types/errors';
import { logger, logAiCall } from '../utils/logger';
import { retry, extractJsonFromText, safeJsonParse } from '../utils/helpers';

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: ClaudeMessage[];
  temperature?: number;
}

interface ClaudeResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{
    type: string;
    text: string;
  }>;
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class AnthropicService {
  private apiKey: string;
  private model: string;
  private baseUrl = 'https://api.anthropic.com/v1';
  private apiVersion = '2023-06-01';

  constructor() {
    this.apiKey = config.anthropicApiKey;
    this.model = config.claudeModel;
  }

  /**
   * Отправляет запрос к Claude
   * @param prompt - Текст запроса
   * @param options.model - Модель (по умолчанию из config)
   */
  async complete(
    prompt: string,
    options: {
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
      requestId?: string;
      model?: string;
    } = {}
  ): Promise<{
    content: string;
    usage: { input: number; output: number };
  }> {
    const {
      systemPrompt,
      temperature = 0.3,
      maxTokens = 4000,
      requestId,
      model,
    } = options;

    const modelToUse = model || this.model;

    const requestBody: ClaudeRequest = {
      model: modelToUse,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      temperature,
    };

    if (systemPrompt) {
      requestBody.system = systemPrompt;
    }

    const startTime = Date.now();

    try {
      const response = await retry(
        async () => {
          const res = await fetch(`${this.baseUrl}/messages`, {
            method: 'POST',
            headers: {
              'x-api-key': this.apiKey,
              'anthropic-version': this.apiVersion,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          });

          if (!res.ok) {
            const errorText = await res.text();
            throw new AIProviderError('anthropic', `HTTP ${res.status}: ${errorText}`);
          }

          return res.json() as Promise<ClaudeResponse>;
        },
        {
          maxRetries: 2,
          baseDelay: 2000,
          shouldRetry: (error) => {
            if (error instanceof AIProviderError) {
              return error.providerError.includes('429') || error.providerError.includes('5');
            }
            return true;
          },
        }
      );

      const duration = Date.now() - startTime;
      const content = response.content[0]?.text || '';

      logAiCall(requestId || 'unknown', 'anthropic', modelToUse, 'complete', {
        prompt_length: prompt.length,
        response_length: content.length,
        duration_ms: duration,
        tokens: response.usage,
      });

      return {
        content,
        usage: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        },
      };
    } catch (error) {
      logger.error('Anthropic complete failed', {
        request_id: requestId,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration_ms: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Получает JSON ответ от Claude
   */
  async completeJson<T>(
    prompt: string,
    options: {
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
      requestId?: string;
      defaultValue: T;
      model?: string;
    }
  ): Promise<{
    data: T;
    usage: { input: number; output: number };
  }> {
    const result = await this.complete(prompt, {
      systemPrompt: options.systemPrompt
        ? `${options.systemPrompt}\n\nIMPORTANT: Respond ONLY with valid JSON. No explanations, no markdown.`
        : 'Respond ONLY with valid JSON. No explanations, no markdown.',
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      requestId: options.requestId,
      model: options.model,
    });

    const jsonText = extractJsonFromText(result.content);
    const data = safeJsonParse<T>(jsonText, options.defaultValue);

    return {
      data,
      usage: result.usage,
    };
  }

  /**
   * Классификация сложности запроса
   */
  async classifyComplexity(
    query: string,
    requestId?: string
  ): Promise<{
    score: number; // 1-5
    reasoning: string;
    usage: { input: number; output: number };
  }> {
    const prompt = `Analyze the complexity of this research query:

"${query}"

Rate the complexity from 1 to 5:
1 = Simple factual question (single fact lookup)
2 = Moderately simple (few related facts)
3 = Moderate (requires comparison or analysis)
4 = Complex (multiple aspects, trends, or relationships)
5 = Very complex (deep research, multiple sources needed)

Respond in JSON format:
{
  "score": 1-5,
  "reasoning": "brief explanation"
}`;

    const result = await this.completeJson<{ score: number; reasoning: string }>(prompt, {
      temperature: 0.1,
      requestId,
      defaultValue: { score: 3, reasoning: 'Default complexity' },
    });

    return {
      score: Math.max(1, Math.min(5, result.data.score)),
      reasoning: result.data.reasoning,
      usage: result.usage,
    };
  }

  /**
   * Декомпозиция текста на атомарные факты
   */
  async decomposeToClaims(
    text: string,
    requestId?: string
  ): Promise<{
    claims: Array<{
      text: string;
      type: 'factual' | 'analytical' | 'speculative';
    }>;
    usage: { input: number; output: number };
  }> {
    const prompt = `Decompose the following text into atomic claims. Each claim should be a single verifiable statement.

Text:
"""
${text}
"""

For each claim, classify its type:
- factual: concrete fact (date, number, event, name)
- analytical: conclusion, comparison, trend analysis
- speculative: prediction, opinion, hypothesis

Respond in JSON format:
{
  "claims": [
    {
      "text": "claim text",
      "type": "factual" | "analytical" | "speculative"
    }
  ]
}`;

    const result = await this.completeJson<{
      claims: Array<{ text: string; type: 'factual' | 'analytical' | 'speculative' }>;
    }>(prompt, {
      temperature: 0.2,
      requestId,
      defaultValue: { claims: [] },
    });

    return {
      claims: result.data.claims || [],
      usage: result.usage,
    };
  }

  /**
   * Синтез финального отчёта (Phase 5)
   *
   * Source Masking: Claude получает ТОЛЬКО верифицированные факты и источники.
   * Сырой текст из Phase 3 (Perplexity) НЕ передаётся — это предотвращает
   * распространение непроверенной информации.
   *
   * @param data.query - Исходный запрос пользователя
   * @param data.questions - Список исследовательских вопросов (только текст)
   * @param data.verifiedClaims - Верифицированные факты с confidence и sourceIds
   * @param data.sources - Массив источников из SourceRegistry
   * @param data.language - Язык отчёта
   * @param data.format - Формат: narrative | bullet_list | minimal
   * @param data.maxTokens - Лимит токенов (зависит от режима)
   * @param data.model - Модель Claude (Haiku для simple, Sonnet для standard/deep)
   * @param data.questionsWithTopics - Вопросы с topic-тэгами (для секционной структуры)
   * @param data.uniqueTopicCount - Количество уникальных тем
   * @param requestId - ID запроса для трассировки
   */
  async synthesizeReport(
    data: {
      query: string;
      questions: string[];
      questionsWithTopics?: Array<{ text: string; topic: string }>;
      uniqueTopicCount?: number;
      verifiedClaims: Array<{
        text: string;
        type: string;
        confidence: number;
        status: string;
        sourceIds: number[];
        value?: number;
        unit?: string;
      }>;
      sources: Array<{
        id: number;
        url: string;
        title: string;
        domain: string;
        isAvailable: boolean;
      }>;
      language: 'ru' | 'en';
      format: 'narrative' | 'bullet_list' | 'minimal';
      maxTokens: number;
      model?: string;
    },
    requestId?: string
  ): Promise<{
    report: string;
    summary: string;
    usage: { input: number; output: number };
  }> {
    const modelToUse = data.model || this.model;

    const langInstructions = data.language === 'ru'
      ? 'Пиши на русском языке.'
      : 'Write in English.';

    // Формируем блок sources
    const sourcesBlock = data.sources
      .filter(s => s.isAvailable)
      .map(s => `[src_${s.id}] ${s.title} — ${s.url}`)
      .join('\n');

    // Формируем блок verified claims
    const claimsBlock = data.verifiedClaims
      .map(c => {
        const refs = c.sourceIds.map(id => `[src_${id}]`).join(' ');
        const conf = `${(c.confidence * 100).toFixed(0)}%`;
        const numInfo = c.value !== undefined ? ` (value: ${c.value}${c.unit ? ' ' + c.unit : ''})` : '';
        return `- [${c.status}|${conf}] ${c.text}${numInfo} ${refs}`;
      })
      .join('\n');

    // Определяем инструкции по формату
    let formatInstructions = '';
    if (data.format === 'narrative') {
      formatInstructions = data.language === 'ru'
        ? 'Пиши развёрнутый аналитический текст с абзацами, подзаголовками и логичной структурой. Каждый факт должен иметь ссылку на источник [src_N].'
        : 'Write a detailed analytical text with paragraphs, subheadings and logical structure. Every fact must cite its source [src_N].';
    } else if (data.format === 'bullet_list') {
      formatInstructions = data.language === 'ru'
        ? 'Структурируй ответ в виде списка ключевых фактов с пояснениями. Каждый пункт — один верифицированный факт со ссылкой [src_N].'
        : 'Structure the response as a list of key facts with explanations. Each point — one verified fact with source reference [src_N].';
    } else {
      formatInstructions = data.language === 'ru'
        ? 'Дай краткий сжатый ответ, только ключевые факты со ссылками [src_N]. Без лишних вступлений.'
        : 'Give a brief, concise answer with only key facts and source references [src_N]. No unnecessary introductions.';
    }

    // Topic-секции
    const topicCount = data.uniqueTopicCount || 0;
    let topicInstructions = '';
    if (topicCount >= 3 && data.format === 'narrative') {
      topicInstructions = data.language === 'ru'
        ? `\n\nСТРУКТУРА ПО ТЕМАМ:\nВопросы сгруппированы по ${topicCount} темам. Организуй отчёт по секциям с заголовками по темам.\nОбъединяй похожие темы, если это улучшает читаемость.`
        : `\n\nTOPIC STRUCTURE:\nQuestions are grouped into ${topicCount} topics. Organize the report with section headings by topic.\nMerge similar topics if it improves readability.`;
    } else if (topicCount >= 3 && data.format === 'bullet_list') {
      topicInstructions = data.language === 'ru'
        ? '\n\nГруппируй факты по темам, если их больше 5.'
        : '\n\nGroup facts by topic if there are more than 5.';
    }

    // Структурные инструкции по формату
    let reportStructureGuide = '';
    if (data.format === 'narrative') {
      reportStructureGuide = data.language === 'ru'
        ? `\n\nРУКОВОДСТВО ПО СТРУКТУРЕ:\n- Начни с краткого вводного абзаца (2-3 предложения)\n- Каждая секция должна иметь чёткий заголовок\n- Заверши ключевыми выводами`
        : `\n\nREPORT STRUCTURE GUIDELINES:\n- Start with a brief summary paragraph (2-3 sentences)\n- Each section should have a clear heading\n- End with key takeaways or conclusions`;
    } else if (data.format === 'bullet_list') {
      reportStructureGuide = data.language === 'ru'
        ? `\n\nРУКОВОДСТВО ПО СТРУКТУРЕ:\n- Пронумеруй каждый верифицированный факт\n- После каждого факта укажи ссылку [src_N]`
        : `\n\nREPORT STRUCTURE GUIDELINES:\n- Number each verified fact\n- Include [src_N] reference after each fact`;
    } else {
      reportStructureGuide = data.language === 'ru'
        ? `\n\nРУКОВОДСТВО ПО СТРУКТУРЕ:\n- Перечисли только верифицированные факты\n- Укажи, что информация ограничена\n- Предложи использовать более глубокий режим исследования`
        : `\n\nREPORT STRUCTURE GUIDELINES:\n- List only the facts that were verified\n- Be explicit that information is limited\n- Suggest using a deeper research mode`;
    }

    const systemPrompt = `You are a research report synthesizer. You MUST follow these critical constraints:

CRITICAL CONSTRAINTS:
1. Use ONLY the verified claims provided below. Do NOT add any facts, numbers, or statements not present in the claims list.
2. Reference sources ONLY using [src_N] notation matching the provided source IDs.
3. Do NOT invent, hallucinate, or extrapolate beyond the provided claims.
4. If a claim has status "unverifiable" or "incorrect", do NOT include it in the report.
5. Numerical values MUST be copied exactly as provided — do not round, convert, or approximate.
6. If there are few verified claims, write a shorter report rather than padding with speculation.

${langInstructions}
${formatInstructions}${topicInstructions}${reportStructureGuide}`;

    // Формируем questions с topic-аннотациями
    const questionsBlock = data.questionsWithTopics && data.questionsWithTopics.length > 0
      ? data.questionsWithTopics.map((q, i) => `${i + 1}. [${q.topic}] ${q.text}`).join('\n')
      : data.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');

    const prompt = `Create a research report based on ONLY the following verified data.

Original query: "${data.query}"

Research questions investigated:
${questionsBlock}

VERIFIED CLAIMS (use ONLY these):
${claimsBlock}

AVAILABLE SOURCES:
${sourcesBlock}

Requirements:
- Include ONLY claims with status "verified" or "partially_correct"
- Every factual statement must have at least one [src_N] reference
- Use Markdown formatting (headers, lists, bold for key terms)
- Write a "summary" (1-2 paragraphs) and a full "report"

Respond in JSON format:
{
  "report": "full markdown report with [src_N] references",
  "summary": "brief summary (1-2 paragraphs)"
}`;

    const result = await this.completeJson<{ report: string; summary: string }>(prompt, {
      systemPrompt,
      temperature: 0.3,
      maxTokens: data.maxTokens,
      requestId,
      defaultValue: { report: '', summary: '' },
      model: modelToUse,
    });

    logger.info('Report synthesized (Source Masking)', {
      request_id: requestId,
      model: modelToUse,
      format: data.format,
      claims_provided: data.verifiedClaims.length,
      sources_provided: data.sources.filter(s => s.isAvailable).length,
      report_length: (result.data.report || '').length,
      topic_count: data.uniqueTopicCount || 0,
    });

    return {
      report: result.data.report || '',
      summary: result.data.summary || '',
      usage: result.usage,
    };
  }
}

// Синглтон
let anthropicServiceInstance: AnthropicService | null = null;

export function getAnthropicService(): AnthropicService {
  if (!anthropicServiceInstance) {
    anthropicServiceInstance = new AnthropicService();
  }
  return anthropicServiceInstance;
}

export default AnthropicService;
