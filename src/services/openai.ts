/**
 * @file src/services/openai.ts
 * @description Клиент для OpenAI Responses API
 * @context Используется для triage (GPT-4.1-nano), claim decomposition (GPT-4.1-mini), deep check (GPT-4.1-nano)
 * @dependencies config/index.ts, utils/helpers.ts, utils/logger.ts
 * @affects pipeline/triage.ts, pipeline/verification.ts
 */

import config from '../config';
import { AIProviderError } from '../types/errors';
import { logger, logAiCall } from '../utils/logger';
import { retry, extractJsonFromText, safeJsonParse } from '../utils/helpers';

// ============================================
// Интерфейсы OpenAI Responses API
// ============================================

interface OpenAIResponsesRequest {
  model: string;
  instructions?: string;
  input: string;
  max_output_tokens?: number;
  temperature?: number;
  text?: {
    format: OpenAITextFormat;
  };
}

type OpenAITextFormat =
  | { type: 'text' }
  | {
      type: 'json_schema';
      name: string;
      schema: Record<string, unknown>;
      strict: boolean;
    };

interface OpenAIResponsesResponse {
  id: string;
  output: Array<{
    type: string;
    role: string;
    content: Array<{
      type: string;
      text: string;
    }>;
  }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

// ============================================
// OpenAIService
// ============================================

export class OpenAIService {
  private apiKey: string;
  private baseUrl = 'https://api.openai.com/v1';

  constructor() {
    this.apiKey = config.openaiApiKey;
  }

  /**
   * Отправляет запрос к OpenAI Responses API и получает текстовый ответ
   * @param prompt - Входной текст (input)
   * @param options - Опции запроса
   * @returns Текстовый ответ и usage
   */
  async complete(
    prompt: string,
    options: {
      model?: string;
      instructions?: string;
      temperature?: number;
      maxTokens?: number;
      requestId?: string;
    } = {}
  ): Promise<{
    content: string;
    usage: { input: number; output: number };
  }> {
    const {
      model = config.openaiModelTriage,
      instructions,
      temperature = 0.1,
      maxTokens = 1000,
      requestId,
    } = options;

    const requestBody: OpenAIResponsesRequest = {
      model,
      input: prompt,
      temperature,
      max_output_tokens: maxTokens,
    };

    if (instructions) {
      requestBody.instructions = instructions;
    }

    const startTime = Date.now();

    try {
      const response = await retry(
        async () => {
          const res = await fetch(`${this.baseUrl}/responses`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          });

          if (!res.ok) {
            const errorText = await res.text();
            throw new AIProviderError('openai', `HTTP ${res.status}: ${errorText}`);
          }

          return res.json() as Promise<OpenAIResponsesResponse>;
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
      const content = this.extractOutputText(response);

      logAiCall(requestId || 'unknown', 'openai', model, 'complete', {
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
      logger.error('OpenAI complete failed', {
        request_id: requestId,
        model,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration_ms: Date.now() - startTime,
      });
      throw error;
    }
  }

  /**
   * Получает structured JSON ответ от OpenAI через text.format
   * @param prompt - Входной текст (input)
   * @param options - Опции запроса
   * @returns Парсированный JSON и usage
   */
  async completeJson<T>(
    prompt: string,
    options: {
      model?: string;
      instructions?: string;
      temperature?: number;
      maxTokens?: number;
      requestId?: string;
      defaultValue: T;
      jsonSchema?: {
        name: string;
        schema: Record<string, unknown>;
      };
    }
  ): Promise<{
    data: T;
    usage: { input: number; output: number };
  }> {
    const {
      model = config.openaiModelTriage,
      instructions,
      temperature = 0.1,
      maxTokens = 1000,
      requestId,
      defaultValue,
      jsonSchema,
    } = options;

    const effectiveInstructions = instructions
      ? `${instructions}\n\nIMPORTANT: Respond ONLY with valid JSON. No explanations, no markdown.`
      : 'Respond ONLY with valid JSON. No explanations, no markdown.';

    const requestBody: OpenAIResponsesRequest = {
      model,
      input: prompt,
      instructions: effectiveInstructions,
      temperature,
      max_output_tokens: maxTokens,
    };

    // Если передана JSON schema — используем structured output
    if (jsonSchema) {
      requestBody.text = {
        format: {
          type: 'json_schema',
          name: jsonSchema.name,
          schema: jsonSchema.schema,
          strict: true,
        },
      };
    }

    const startTime = Date.now();

    try {
      const response = await retry(
        async () => {
          const res = await fetch(`${this.baseUrl}/responses`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          });

          if (!res.ok) {
            const errorText = await res.text();
            throw new AIProviderError('openai', `HTTP ${res.status}: ${errorText}`);
          }

          return res.json() as Promise<OpenAIResponsesResponse>;
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
      const content = this.extractOutputText(response);

      logAiCall(requestId || 'unknown', 'openai', model, 'completeJson', {
        prompt_length: prompt.length,
        response_length: content.length,
        duration_ms: duration,
        tokens: response.usage,
      });

      const jsonText = extractJsonFromText(content);
      const data = safeJsonParse<T>(jsonText, defaultValue);

      return {
        data,
        usage: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        },
      };
    } catch (error) {
      logger.error('OpenAI completeJson failed', {
        request_id: requestId,
        model,
        error: error instanceof Error ? error.message : 'Unknown error',
        duration_ms: Date.now() - startTime,
      });

      // Возвращаем defaultValue при ошибке
      return {
        data: defaultValue,
        usage: { input: 0, output: 0 },
      };
    }
  }

  /**
   * Извлекает текст из Responses API response
   */
  private extractOutputText(response: OpenAIResponsesResponse): string {
    if (!response.output || response.output.length === 0) return '';

    for (const output of response.output) {
      if (output.type === 'message' && output.content) {
        for (const block of output.content) {
          if (block.type === 'output_text' && block.text) {
            return block.text;
          }
        }
      }
    }

    return '';
  }
}

// ============================================
// Синглтон
// ============================================

let openaiServiceInstance: OpenAIService | null = null;

export function getOpenAIService(): OpenAIService {
  if (!openaiServiceInstance) {
    openaiServiceInstance = new OpenAIService();
  }
  return openaiServiceInstance;
}

export default OpenAIService;
