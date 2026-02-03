/**
 * @file src/types/errors.ts
 * @description Кастомные ошибки модуля
 * @context Используется для структурированной обработки ошибок
 */

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    errorCode: string = 'INTERNAL_ERROR',
    isOperational: boolean = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = isOperational;

    Object.setPrototypeOf(this, AppError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class InsufficientBalanceError extends AppError {
  public readonly balance: number;

  constructor(balance: number = 0) {
    super('Insufficient balance', 402, 'INSUFFICIENT_BALANCE');
    this.balance = balance;
  }
}

export class CoreApiError extends AppError {
  public readonly endpoint: string;
  public readonly coreStatus: number;
  public readonly coreError: string;

  constructor(endpoint: string, status: number, error: string) {
    super(`CORE API error: ${error}`, 502, 'CORE_API_ERROR');
    this.endpoint = endpoint;
    this.coreStatus = status;
    this.coreError = error;
  }
}

export class AIProviderError extends AppError {
  public readonly provider: string;
  public readonly providerError: string;

  constructor(provider: string, error: string) {
    super(`AI Provider error (${provider}): ${error}`, 502, 'AI_PROVIDER_ERROR');
    this.provider = provider;
    this.providerError = error;
  }
}

export class ResearchCancelledError extends AppError {
  constructor() {
    super('Research was cancelled', 400, 'RESEARCH_CANCELLED');
  }
}

export class ResearchTimeoutError extends AppError {
  constructor() {
    super('Research timeout exceeded', 408, 'RESEARCH_TIMEOUT');
  }
}
