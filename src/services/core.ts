/**
 * @file src/services/core.ts
 * @description Интеграция с CORE API (биллинг, баланс)
 * @context Используется для авторизации и оплаты
 */

import config from '../config';
import {
  BillingStartRequest,
  BillingStartResponse,
  BillingFinishRequest,
  BillingFinishResponse,
  BillingUsage,
  WalletBalanceResponse,
} from '../types/billing';
import { CoreApiError, InsufficientBalanceError } from '../types/errors';
import { logger } from '../utils/logger';

export class CoreService {
  private apiUrl: string;
  private apiKey: string;

  constructor() {
    this.apiUrl = config.coreApiUrl;
    this.apiKey = config.coreApiKey;
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: object,
    requestId?: string
  ): Promise<T> {
    const url = `${this.apiUrl}${endpoint}`;
    const startTime = Date.now();

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Module-Api-Key': this.apiKey,
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const duration = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('CORE API error', {
          request_id: requestId,
          endpoint,
          status: response.status,
          error: errorText,
          duration_ms: duration,
        });
        throw new CoreApiError(endpoint, response.status, errorText);
      }

      const data = await response.json() as T;

      logger.info('CORE API call completed', {
        request_id: requestId,
        endpoint,
        status: response.status,
        duration_ms: duration,
      });

      return data;
    } catch (error) {
      if (error instanceof CoreApiError) {
        throw error;
      }
      logger.error('CORE API network error', {
        request_id: requestId,
        endpoint,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw new CoreApiError(endpoint, 0, error instanceof Error ? error.message : 'Network error');
    }
  }

  /**
   * Начинает биллинг-операцию (холд)
   */
  async startBilling(params: {
    userId: string;
    sessionId?: string;
    requestId: string;
  }): Promise<BillingStartResponse> {
    const body: BillingStartRequest = {
      user_id: params.userId,
      module_id: config.moduleId,
      request_id: params.requestId,
      session_id: params.sessionId,
    };

    const response = await this.request<BillingStartResponse>('POST', '/billing/start', body, params.requestId);

    if (!response.allowed) {
      throw new InsufficientBalanceError(response.balance || 0);
    }

    return response;
  }

  /**
   * Завершает биллинг-операцию (commit или rollback)
   */
  async finishBilling(params: {
    action: 'commit' | 'rollback';
    userId: string;
    usage?: BillingUsage;
    shellId?: string;
    originUrl?: string;
    requestId: string;
  }): Promise<BillingFinishResponse> {
    const body: BillingFinishRequest = {
      action: params.action,
      user_id: params.userId,
      module_id: config.moduleId,
      request_id: params.requestId,
      usage: params.usage,
      shell_id: params.shellId,
      origin_url: params.originUrl,
    };

    return this.request<BillingFinishResponse>('POST', '/billing/finish', body, params.requestId);
  }

  /**
   * Получает баланс пользователя
   */
  async getBalance(userId: string, requestId?: string): Promise<WalletBalanceResponse> {
    return this.request<WalletBalanceResponse>(
      'GET',
      `/wallet/balance?user_id=${encodeURIComponent(userId)}`,
      undefined,
      requestId
    );
  }

  /**
   * POST /identity/resolve
   * Преобразует внешний ID из оболочки во внутренний user_id
   */
  async resolveIdentity(
    provider: string,
    tenant: string,
    externalUserId: string,
    requestId: string
  ): Promise<{ user_id: string; is_new: boolean }> {
    logger.info('Resolving identity', {
      request_id: requestId,
      provider,
      tenant,
      external_user_id: externalUserId,
    });

    const response = await this.request<{ user_id: string; is_new: boolean }>(
      'POST',
      '/identity/resolve',
      {
        request_id: requestId,
        provider,
        tenant,
        external_user_id: externalUserId,
      },
      requestId
    );

    logger.info('Identity resolved', {
      request_id: requestId,
      user_id: response.user_id,
      is_new: response.is_new,
    });

    return response;
  }
}

// Синглтон
let coreServiceInstance: CoreService | null = null;

export function getCoreService(): CoreService {
  if (!coreServiceInstance) {
    coreServiceInstance = new CoreService();
  }
  return coreServiceInstance;
}

export default CoreService;
