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

export type UsageItem = TextTokensUsageItem;

export interface BillingUsage {
  items: UsageItem[];
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

export interface TokenAccumulator {
  [model: string]: TokenUsage;
}

export class UsageTracker {
  private usage: TokenAccumulator = {};

  addUsage(model: string, input: number, output: number): void {
    if (!this.usage[model]) {
      this.usage[model] = { inputTokens: 0, outputTokens: 0 };
    }
    this.usage[model].inputTokens += input;
    this.usage[model].outputTokens += output;
  }

  getUsage(): TokenAccumulator {
    return { ...this.usage };
  }

  getTotalTokens(): { input: number; output: number } {
    let input = 0;
    let output = 0;
    for (const model of Object.values(this.usage)) {
      input += model.inputTokens;
      output += model.outputTokens;
    }
    return { input, output };
  }

  toBillingUsage(): BillingUsage {
    const items: UsageItem[] = [];
    for (const [model, usage] of Object.entries(this.usage)) {
      items.push({
        type: 'text_tokens',
        model,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
      });
    }
    return { items };
  }

  reset(): void {
    this.usage = {};
  }
}
