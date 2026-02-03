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
  search_recency_filter?: 'month' | 'week' | 'day' | 'hour';
}

interface PerplexityCitation {
  url: string;
  title?: string;
  snippet?: string;
  published_date?: string;
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
  citations?: PerplexityCitation[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
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
   */
  async search(
    query: string,
    options: {
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
      recencyFilter?: 'month' | 'week' | 'day' | 'hour';
      requestId?: string;
    } = {}
  ): Promise<{
    content: string;
    citations: Citation[];
    usage: { input: number; output: number };
  }> {
    const {
      systemPrompt = 'You are a helpful research assistant. Provide accurate, well-sourced information.',
      temperature = 0.1,
      maxTokens = 4000,
      recencyFilter,
      requestId,
    } = options;

    const messages: PerplexityMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query },
    ];

    const requestBody: PerplexityRequest = {
      model: this.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      return_citations: true,
    };

    if (recencyFilter) {
      requestBody.search_recency_filter = recencyFilter;
    }

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

      // Преобразуем citations
      const citations: Citation[] = (response.citations || []).map((c, index) => {
        const domain = this.extractDomain(c.url);
        const authorityScore = getAuthorityScore(c.url);

        return {
          url: c.url,
          title: c.title || `Source ${index + 1}`,
          snippet: c.snippet || '',
          domain,
          authorityScore,
          date: c.published_date,
        };
      });

      logAiCall(requestId || 'unknown', 'perplexity', this.model, 'search', {
        query_length: query.length,
        response_length: content.length,
        citations_count: citations.length,
        duration_ms: duration,
        tokens: response.usage,
      });

      return {
        content,
        citations,
        usage: {
          input: response.usage.prompt_tokens,
          output: response.usage.completion_tokens,
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
   * Верифицирует факт
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
    usage: { input: number; output: number };
  }> {
    const { context, requestId } = options;

    const systemPrompt = `You are a fact-checking assistant. Your task is to verify claims by searching for reliable sources.

For each claim, you must:
1. Search for authoritative sources
2. Determine if the claim is accurate
3. Provide a confidence score (0.0 to 1.0)
4. If incorrect or partially correct, provide the correct information

IMPORTANT: Respond ONLY with a JSON object in this exact format:
{
  "status": "verified" | "partially_correct" | "incorrect" | "unverifiable",
  "confidence": 0.0-1.0,
  "correction": "corrected information if needed",
  "explanation": "brief explanation of your verification"
}`;

    let query = `Verify this claim: "${claim}"`;
    if (context) {
      query += `\n\nContext: ${context}`;
    }

    const result = await this.search(query, {
      systemPrompt,
      temperature: 0.1,
      requestId,
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
