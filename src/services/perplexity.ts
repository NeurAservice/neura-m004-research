/**
 * @file src/services/perplexity.ts
 * @description Клиент для Perplexity API
 * @context Используется для поиска и верификации информации
 */

import config from '../config';
import { AIProviderError } from '../types/errors';
import { logger, logAiCall } from '../utils/logger';
import { retry, extractJsonFromText, safeJsonParse } from '../utils/helpers';
import { Citation } from '../types/research';
import { getAuthorityScore, getAuthorityLabel } from '../config/authority';
import { getVerificationPrompt } from '../config/prompts';
import { getVerificationAllowlist } from '../config/domains';

interface PerplexityMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface PerplexityRequest {
  model: string;
  messages: PerplexityMessage[];
  temperature?: number;
  max_tokens?: number;
  return_citations?: boolean;
  search_recency_filter?: 'month' | 'week' | 'day' | 'hour' | 'year';
  // Новые параметры для улучшения качества
  search_domain_filter?: string[];
  search_mode?: 'default' | 'academic';
  web_search_options?: {
    search_context_size: 'low' | 'medium' | 'high';
  };
}

interface PerplexityCitation {
  url: string;
  title?: string;
  snippet?: string;
  published_date?: string;
}

interface PerplexityCost {
  input_tokens_cost?: number;
  output_tokens_cost?: number;
  request_cost?: number;
  total_cost?: number;
}

interface PerplexityUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  search_context_size?: 'low' | 'medium' | 'high';
  cost?: PerplexityCost;
}

interface PerplexityResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  citations?: Array<PerplexityCitation | string>;
  search_results?: Array<{
    title: string;
    url: string;
    date?: string;
  }>;
  usage: PerplexityUsage;
}

export class PerplexityService {
  private apiKey: string;
  private model: string;
  private baseUrl = 'https://api.perplexity.ai';

  constructor() {
    this.apiKey = config.perplexityApiKey;
    this.model = config.perplexityModel;
  }

  /**
   * Выполняет поисковый запрос
   * @param query - Текст запроса
   * @param options - Опции запроса
   * @param options.systemPrompt - System prompt для модели
   * @param options.temperature - Температура генерации (default: 0.1)
   * @param options.maxTokens - Максимальное количество токенов (default: 4000)
   * @param options.recencyFilter - Фильтр по свежести данных
   * @param options.requestId - ID запроса для логирования
   * @param options.domainFilter - Фильтр доменов (denylist с '-', allowlist без)
   * @param options.searchMode - Режим поиска ('default' | 'academic')
   * @param options.contextSize - Размер контекста поиска ('low' | 'medium' | 'high')
   */
  async search(
    query: string,
    options: {
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
      recencyFilter?: 'month' | 'week' | 'day' | 'hour' | 'year';
      requestId?: string;
      domainFilter?: string[];
      searchMode?: 'default' | 'academic';
      contextSize?: 'low' | 'medium' | 'high';
    } = {}
  ): Promise<{
    content: string;
    citations: Citation[];
    searchResults: Array<{ title: string; url: string; date?: string }>;
    usage: {
      input: number;
      output: number;
      searchContextTokens: number;
      totalCost: number;
    };
  }> {
    const {
      systemPrompt,
      temperature = 0.1,
      maxTokens = 4000,
      recencyFilter,
      requestId,
      domainFilter,
      searchMode,
      contextSize = 'high',
    } = options;

    // Используем дефолтный промпт если не передан
    const effectiveSystemPrompt = systemPrompt ||
      'You are a helpful research assistant. Provide accurate, well-sourced information.';

    const messages: PerplexityMessage[] = [
      { role: 'system', content: effectiveSystemPrompt },
      { role: 'user', content: query },
    ];

    const requestBody: PerplexityRequest = {
      model: this.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      return_citations: true,
    };

    // Применяем фильтр по свежести если указан
    if (recencyFilter) {
      requestBody.search_recency_filter = recencyFilter;
    }

    // Применяем фильтр доменов если указан
    if (domainFilter && domainFilter.length > 0) {
      requestBody.search_domain_filter = domainFilter;
    }

    // Применяем режим поиска если указан
    if (searchMode) {
      requestBody.search_mode = searchMode;
    }

    // Устанавливаем размер контекста поиска (по умолчанию 'high' для исследований)
    requestBody.web_search_options = {
      search_context_size: contextSize,
    };

    const startTime = Date.now();

    try {
      const response = await retry(
        async () => {
          const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          });

          if (!res.ok) {
            const errorText = await res.text();
            throw new AIProviderError('perplexity', `HTTP ${res.status}: ${errorText}`);
          }

          return res.json() as Promise<PerplexityResponse>;
        },
        {
          maxRetries: 2,
          baseDelay: 2000,
          shouldRetry: (error) => {
            if (error instanceof AIProviderError) {
              // Retry on 429 (rate limit) or 5xx errors
              return error.providerError.includes('429') || error.providerError.includes('5');
            }
            return true;
          },
        }
      );

      const duration = Date.now() - startTime;
      const content = response.choices[0]?.message?.content || '';

      // Преобразуем citations (Perplexity может вернуть строки ИЛИ объекты)
      const rawCitations = response.citations || [];
      const citations: Citation[] = [];
      for (let index = 0; index < rawCitations.length; index++) {
        const c = rawCitations[index] as any;
        // Если citation — строка (URL), конвертируем в объект
        const url = typeof c === 'string' ? c : c?.url;
        if (!url) {
          logger.debug('Citation without URL', {
            request_id: requestId,
            index,
            citation_type: typeof c,
          });
          continue;
        }

        const domain = this.extractDomain(url);
        const authorityScore = getAuthorityScore(url);

        citations.push({
          url,
          title: typeof c === 'string' ? `Source ${index + 1}` : (c.title || `Source ${index + 1}`),
          snippet: typeof c === 'string' ? '' : (c.snippet || ''),
          domain,
          authorityScore,
          date: typeof c === 'string' ? undefined : c.published_date,
        });
      }

      // Извлекаем search_results
      const searchResults: Array<{ title: string; url: string; date?: string }> =
        (response.search_results || []).map(sr => ({
          title: sr.title,
          url: sr.url,
          date: sr.date,
        }));

      // Предупреждение если контент есть, а citations нет
      if (content && citations.length === 0) {
        logger.warn('Perplexity returned content without citations', {
          request_id: requestId,
          content_length: content.length,
          query_length: query.length,
        });
      }

      // Оценка search context tokens на основе search_context_size
      // Low: ~2500 tokens, Medium: ~5000 tokens, High: ~10000 tokens per request
      const searchContextSizeMap: Record<string, number> = {
        low: 2500,
        medium: 5000,
        high: 10000,
      };
      const searchContextSize = response.usage.search_context_size || 'low';
      const estimatedSearchContextTokens = searchContextSizeMap[searchContextSize] || 2500;
      const totalCost = response.usage.cost?.total_cost || 0;

      logAiCall(requestId || 'unknown', 'perplexity', this.model, 'search', {
        query_length: query.length,
        response_length: content.length,
        citations_count: citations.length,
        duration_ms: duration,
        tokens: response.usage,
        search_context_size: searchContextSize,
        estimated_search_context_tokens: estimatedSearchContextTokens,
        total_cost: totalCost,
        // Новые поля для отладки
        domain_filter: domainFilter ? domainFilter.length : 'none',
        search_mode: searchMode || 'default',
        context_size_requested: contextSize,
      });

      return {
        content,
        citations,
        searchResults,
        usage: {
          input: response.usage.prompt_tokens,
          output: response.usage.completion_tokens,
          searchContextTokens: estimatedSearchContextTokens,
          totalCost,
        },
      };
    } catch (error) {
      logger.error('Perplexity search failed', {
        request_id: requestId,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration_ms: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Верифицирует факт с использованием авторитетных источников
   * @param claim - Утверждение для проверки
   * @param options.context - Дополнительный контекст
   * @param options.requestId - ID запроса для логирования
   */
  async verifyFact(
    claim: string,
    options: {
      context?: string;
      requestId?: string;
    } = {}
  ): Promise<{
    status: 'verified' | 'partially_correct' | 'incorrect' | 'unverifiable';
    confidence: number;
    correction?: string;
    explanation: string;
    sources: Citation[];
    usage: { input: number; output: number; searchContextTokens: number; totalCost: number };
  }> {
    const { context, requestId } = options;

    // Используем специализированный промпт для верификации
    const systemPrompt = getVerificationPrompt();

    // Allowlist авторитетных источников
    const verificationDomains = getVerificationAllowlist();

    let query = `Verify this claim: "${claim}"`;
    if (context) {
      query += `\n\nContext: ${context}`;
    }

    const result = await this.search(query, {
      systemPrompt,
      temperature: 0.1,
      requestId,
      domainFilter: verificationDomains,  // Только авторитетные источники
      searchMode: 'academic',              // Приоритет академических источников
      contextSize: 'medium',               // Средний контекст для верификации
    });

    // Парсим JSON ответ
    const jsonText = extractJsonFromText(result.content);
    const parsed = safeJsonParse<{
      status: string;
      confidence: number;
      correction?: string;
      explanation: string;
    }>(jsonText, {
      status: 'unverifiable',
      confidence: 0.5,
      explanation: 'Failed to parse verification result',
    });

    // Валидируем status
    const validStatuses = ['verified', 'partially_correct', 'incorrect', 'unverifiable'];
    const status = validStatuses.includes(parsed.status)
      ? parsed.status as 'verified' | 'partially_correct' | 'incorrect' | 'unverifiable'
      : 'unverifiable';

    // Валидируем confidence
    const confidence = Math.max(0, Math.min(1, parsed.confidence || 0.5));

    return {
      status,
      confidence,
      correction: parsed.correction,
      explanation: parsed.explanation || '',
      sources: result.citations,
      usage: result.usage,
    };
  }

  private extractDomain(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }
}

// Синглтон
let perplexityServiceInstance: PerplexityService | null = null;

export function getPerplexityService(): PerplexityService {
  if (!perplexityServiceInstance) {
    perplexityServiceInstance = new PerplexityService();
  }
  return perplexityServiceInstance;
}

export default PerplexityService;
