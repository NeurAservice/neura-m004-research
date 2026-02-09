/**
 * @file src/types/billing.ts
 * @description Типы для биллинга и интеграции с CORE
 * @context Используется для расчёта стоимости и отправки в CORE
 */

// ============================================
// Usage items для CORE
// ============================================

export interface TextTokensUsageItem {
  type: 'text_tokens';
  model: string;
  input_tokens: number;
  output_tokens: number;
}

/**
 * Для Perplexity API: дополнительные search context tokens (citations)
 * Эти токены оцениваются отдельно от input/output tokens
 */
export interface PerplexitySearchUsageItem {
  type: 'perplexity_search';
  model: string;
  input_tokens: number;
  output_tokens: number;
  search_context_tokens: number;
  total_cost: number;
  request_count: number;
}

export type UsageItem = TextTokensUsageItem | PerplexitySearchUsageItem;

export interface OpenAIUsageItem {
  type: 'openai_tokens';
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export type ExtendedUsageItem = UsageItem | OpenAIUsageItem;

export interface BillingUsage {
  items: ExtendedUsageItem[];
}

// ============================================
// CORE API типы
// ============================================

export interface BillingStartRequest {
  user_id: string;
  module_id: string;
  request_id: string;
  session_id?: string;
  estimated_usage?: BillingUsage;
}

export interface BillingStartResponse {
  allowed: boolean;
  reason?: string;
  balance?: number;
  topup_url?: string;
  transaction_id?: string;
}

export interface BillingFinishRequest {
  action: 'commit' | 'rollback';
  user_id: string;
  module_id: string;
  request_id: string;
  usage?: BillingUsage;
  shell_id?: string;
  origin_url?: string;
}

export interface BillingFinishResponse {
  success: boolean;
  charged_amount?: number;
  new_balance?: number;
}

export interface WalletBalanceResponse {
  user_id?: string;
  balance: number;
  currency: string;
  topup_url?: string;
}

// ============================================
// Token Accumulator
// ============================================

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface PerplexityUsage {
  inputTokens: number;
  outputTokens: number;
  searchContextTokens: number;
  totalCost: number;
  requestCount: number;
}

export interface TokenAccumulator {
  [model: string]: TokenUsage;
}

export interface PerplexityAccumulator {
  [model: string]: PerplexityUsage;
}

export class UsageTracker {
  private usage: TokenAccumulator = {};
  private perplexityUsage: PerplexityAccumulator = {};
  private openaiUsage: TokenAccumulator = {};

  addUsage(model: string, input: number, output: number): void {
    if (!this.usage[model]) {
      this.usage[model] = { inputTokens: 0, outputTokens: 0 };
    }
    this.usage[model].inputTokens += input;
    this.usage[model].outputTokens += output;
  }

  /**
   * Добавляет usage для OpenAI API
   */
  addOpenAIUsage(model: string, input: number, output: number): void {
    if (!this.openaiUsage[model]) {
      this.openaiUsage[model] = { inputTokens: 0, outputTokens: 0 };
    }
    this.openaiUsage[model].inputTokens += input;
    this.openaiUsage[model].outputTokens += output;
  }

  /**
   * Добавляет usage для Perplexity API с учётом search context tokens
   */
  addPerplexityUsage(
    model: string,
    input: number,
    output: number,
    searchContextTokens: number,
    totalCost: number
  ): void {
    if (!this.perplexityUsage[model]) {
      this.perplexityUsage[model] = {
        inputTokens: 0,
        outputTokens: 0,
        searchContextTokens: 0,
        totalCost: 0,
        requestCount: 0,
      };
    }
    this.perplexityUsage[model].inputTokens += input;
    this.perplexityUsage[model].outputTokens += output;
    this.perplexityUsage[model].searchContextTokens += searchContextTokens;
    this.perplexityUsage[model].totalCost += totalCost;
    this.perplexityUsage[model].requestCount += 1;
  }

  getUsage(): TokenAccumulator {
    return { ...this.usage };
  }

  getPerplexityUsage(): PerplexityAccumulator {
    return { ...this.perplexityUsage };
  }

  getOpenAIUsage(): TokenAccumulator {
    return { ...this.openaiUsage };
  }

  getTotalTokens(): { input: number; output: number } {
    let input = 0;
    let output = 0;
    for (const model of Object.values(this.usage)) {
      input += model.inputTokens;
      output += model.outputTokens;
    }
    // Добавляем Perplexity tokens
    for (const model of Object.values(this.perplexityUsage)) {
      input += model.inputTokens;
      output += model.outputTokens;
    }
    // Добавляем OpenAI tokens
    for (const model of Object.values(this.openaiUsage)) {
      input += model.inputTokens;
      output += model.outputTokens;
    }
    return { input, output };
  }

  /**
   * Возвращает суммарную статистику включая Perplexity search context и OpenAI
   */
  getTotalStats(): {
    input: number;
    output: number;
    searchContextTokens: number;
    perplexityCost: number;
    perplexityRequests: number;
    openaiCost: number;
  } {
    const tokens = this.getTotalTokens();
    let searchContextTokens = 0;
    let perplexityCost = 0;
    let perplexityRequests = 0;

    for (const model of Object.values(this.perplexityUsage)) {
      searchContextTokens += model.searchContextTokens;
      perplexityCost += model.totalCost;
      perplexityRequests += model.requestCount;
    }

    // Расчёт стоимости OpenAI
    const openaiPrices: Record<string, { input: number; output: number }> = {
      'gpt-4.1-nano': { input: 0.1 / 1_000_000, output: 0.4 / 1_000_000 },
      'gpt-4.1-mini': { input: 0.4 / 1_000_000, output: 1.6 / 1_000_000 },
    };
    let openaiCost = 0;
    for (const [model, usage] of Object.entries(this.openaiUsage)) {
      const prices = openaiPrices[model] || openaiPrices['gpt-4.1-nano'];
      openaiCost += usage.inputTokens * prices.input + usage.outputTokens * prices.output;
    }

    return {
      ...tokens,
      searchContextTokens,
      perplexityCost,
      perplexityRequests,
      openaiCost,
    };
  }

  toBillingUsage(): BillingUsage {
    const items: ExtendedUsageItem[] = [];

    // Обычные text_tokens (Claude и др.)
    for (const [model, usage] of Object.entries(this.usage)) {
      items.push({
        type: 'text_tokens',
        model,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
      });
    }

    // OpenAI tokens
    for (const [model, usage] of Object.entries(this.openaiUsage)) {
      items.push({
        type: 'openai_tokens',
        model,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
      });
    }

    // Perplexity с search context
    for (const [model, usage] of Object.entries(this.perplexityUsage)) {
      items.push({
        type: 'perplexity_search',
        model,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        search_context_tokens: usage.searchContextTokens,
        total_cost: usage.totalCost,
        request_count: usage.requestCount,
      });
    }

    return { items };
  }

  reset(): void {
    this.usage = {};
    this.perplexityUsage = {};
    this.openaiUsage = {};
  }
}
