/**
 * @file src/services/anthropic.ts
 * @description Клиент для Anthropic Claude API
 * @context Используется для планирования, синтеза и анализа
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
   */
  async complete(
    prompt: string,
    options: {
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
      requestId?: string;
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
    } = options;

    const requestBody: ClaudeRequest = {
      model: this.model,
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

      logAiCall(requestId || 'unknown', 'anthropic', this.model, 'complete', {
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
   * Синтез финального отчёта
   */
  async synthesizeReport(
    data: {
      query: string;
      questions: Array<{ text: string; response: string }>;
      verifiedClaims: Array<{ text: string; confidence: number; sources: string[] }>;
      language: 'ru' | 'en';
      maxLength: 'short' | 'medium' | 'long';
    },
    requestId?: string
  ): Promise<{
    report: string;
    summary: string;
    usage: { input: number; output: number };
  }> {
    const lengthGuide = {
      short: '300-500 words',
      medium: '800-1500 words',
      long: '2000-3000 words',
    };

    const langInstructions = data.language === 'ru'
      ? 'Пиши на русском языке.'
      : 'Write in English.';

    const prompt = `Create a research report based on the following data.

Original query: "${data.query}"

Research questions and findings:
${data.questions.map((q, i) => `${i + 1}. ${q.text}\n   Finding: ${q.response}`).join('\n\n')}

Verified facts (include citations [N] referring to their sources):
${data.verifiedClaims.map((c, i) => `- ${c.text} (confidence: ${(c.confidence * 100).toFixed(0)}%) [${c.sources.join(', ')}]`).join('\n')}

${langInstructions}

Target length: ${lengthGuide[data.maxLength]}

Create:
1. A comprehensive report in Markdown format with proper structure (headers, lists, etc.)
2. A brief summary (1-3 paragraphs)

Respond in JSON format:
{
  "report": "full markdown report",
  "summary": "brief summary"
}`;

    const result = await this.completeJson<{ report: string; summary: string }>(prompt, {
      temperature: 0.4,
      maxTokens: 8000,
      requestId,
      defaultValue: { report: '', summary: '' },
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
