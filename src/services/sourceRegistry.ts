/**
 * @file src/services/sourceRegistry.ts
 * @description Реестр источников — централизованное хранилище всех sources с дедупликацией и валидацией URL
 * @context Создаётся оркестратором, заполняется на Phase 3, валидируется перед Phase 5
 * @dependencies config/authority.ts, utils/logger.ts
 * @affects Качество метрик, Source Masking, отображение источников
 */

import { getAuthorityScore } from '../config/authority';
import { logger } from '../utils/logger';

// ============================================
// Типы
// ============================================

export interface RegisteredSource {
  id: number;
  url: string;
  title: string;
  domain: string;
  date?: string;
  authorityScore: number;
  perplexityQueryId: number;
  status: 'available' | 'unavailable' | 'unchecked';
  addedAt: string;
}

export interface PerplexityCitationInput {
  url: string;
  title?: string;
  snippet?: string;
  published_date?: string;
  date?: string;
}

export interface PerplexitySearchResultInput {
  title: string;
  url: string;
  date?: string;
}

// ============================================
// SourceRegistry
// ============================================

export class SourceRegistry {
  private sources: Map<number, RegisteredSource> = new Map();
  private urlIndex: Map<string, number> = new Map(); // normalizedUrl → id
  private nextId: number = 1;
  private requestId: string;

  constructor(requestId: string) {
    this.requestId = requestId;
  }

  /**
   * Нормализует URL для дедупликации
   * Убирает trailing slash, utm_* параметры, www.
   */
  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      // Убираем www.
      parsed.hostname = parsed.hostname.replace(/^www\./, '');
      // Убираем utm_* параметры
      const params = new URLSearchParams(parsed.search);
      const keysToDelete: string[] = [];
      for (const key of params.keys()) {
        if (key.startsWith('utm_')) {
          keysToDelete.push(key);
        }
      }
      for (const key of keysToDelete) {
        params.delete(key);
      }
      parsed.search = params.toString();
      // Убираем trailing slash
      let normalized = parsed.toString();
      if (normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
      }
      return normalized;
    } catch {
      return url;
    }
  }

  /**
   * Извлекает домен из URL
   */
  private extractDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  /**
   * Добавляет источники из ответа Perplexity
   * @returns Маппинг perplexityCitationIndex → sourceRegistryId
   */
  addFromPerplexityResponse(
    citations: PerplexityCitationInput[],
    searchResults: PerplexitySearchResultInput[],
    queryId: number
  ): Map<number, number> {
    const mapping = new Map<number, number>();

    // Создаём индекс searchResults по URL для получения доп. данных (дата, title)
    const searchResultsByUrl = new Map<string, PerplexitySearchResultInput>();
    for (const sr of searchResults) {
      const normalized = this.normalizeUrl(sr.url);
      searchResultsByUrl.set(normalized, sr);
    }

    for (let i = 0; i < citations.length; i++) {
      const citation = citations[i];
      if (!citation.url) continue;

      const normalizedUrl = this.normalizeUrl(citation.url);
      const existingId = this.urlIndex.get(normalizedUrl);

      if (existingId !== undefined) {
        // Дедупликация — уже есть
        mapping.set(i, existingId);
        logger.info('Source deduplicated', {
          request_id: this.requestId,
          url: citation.url,
          existing_id: existingId,
        });
        continue;
      }

      // Ищем дополнительные данные из search_results
      const searchResult = searchResultsByUrl.get(normalizedUrl);

      const domain = this.extractDomain(citation.url);
      const authorityScore = getAuthorityScore(citation.url);
      const title = citation.title || searchResult?.title || `Source ${this.nextId}`;
      const date = citation.published_date || citation.date || searchResult?.date;

      const source: RegisteredSource = {
        id: this.nextId,
        url: citation.url,
        title,
        domain,
        date,
        authorityScore,
        perplexityQueryId: queryId,
        status: 'unchecked',
        addedAt: new Date().toISOString(),
      };

      this.sources.set(this.nextId, source);
      this.urlIndex.set(normalizedUrl, this.nextId);
      mapping.set(i, this.nextId);

      logger.info('Source registered', {
        request_id: this.requestId,
        source_id: this.nextId,
        url: citation.url,
        domain,
        authority: authorityScore,
      });

      this.nextId++;
    }

    return mapping;
  }

  /**
   * Получение source по ID
   */
  getSource(id: number): RegisteredSource | undefined {
    return this.sources.get(id);
  }

  /**
   * Получение всех sources
   */
  getAllSources(): RegisteredSource[] {
    return Array.from(this.sources.values());
  }

  /**
   * Получение source ID по URL (для дедупликации)
   */
  getIdByUrl(url: string): number | undefined {
    const normalized = this.normalizeUrl(url);
    return this.urlIndex.get(normalized);
  }

  /**
   * Валидация URL (HTTP HEAD, параллельная с ограничением concurrency)
   */
  async validateUrls(options: {
    maxConcurrency?: number;
    timeoutMs?: number;
  } = {}): Promise<{ total: number; available: number; unavailable: number }> {
    const { maxConcurrency = 10, timeoutMs = 3000 } = options;
    const allSources = this.getAllSources();
    const startTime = Date.now();

    if (allSources.length === 0) {
      return { total: 0, available: 0, unavailable: 0 };
    }

    let available = 0;
    let unavailable = 0;

    // Простой семафор для ограничения concurrency
    const semaphore = { current: 0 };
    const queue: Array<() => Promise<void>> = [];

    const processSource = async (source: RegisteredSource): Promise<void> => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(source.url, {
          method: 'HEAD',
          signal: controller.signal,
          redirect: 'follow',
        });

        clearTimeout(timeout);
        source.status = response.ok ? 'available' : 'unavailable';
      } catch {
        source.status = 'unavailable';
      }

      if (source.status === 'available') {
        available++;
      } else {
        unavailable++;
        logger.warn('Source URL unavailable', {
          request_id: this.requestId,
          source_id: source.id,
          url: source.url,
        });
      }
    };

    // Выполняем с ограничением concurrency
    const runWithConcurrency = async (tasks: Array<() => Promise<void>>, limit: number): Promise<void> => {
      const executing: Set<Promise<void>> = new Set();

      for (const task of tasks) {
        const p = task().then(() => { executing.delete(p); });
        executing.add(p);
        if (executing.size >= limit) {
          await Promise.race(executing);
        }
      }

      await Promise.all(executing);
    };

    const tasks = allSources.map(source => () => processSource(source));
    await runWithConcurrency(tasks, maxConcurrency);

    const duration = Date.now() - startTime;

    logger.info('URL validation completed', {
      request_id: this.requestId,
      total: allSources.length,
      available,
      unavailable,
      duration_ms: duration,
    });

    return { total: allSources.length, available, unavailable };
  }

  /**
   * Пометка source как unavailable
   */
  markUnavailable(id: number): void {
    const source = this.sources.get(id);
    if (source) {
      source.status = 'unavailable';
    }
  }

  /**
   * Получение sources для claim по массиву IDs
   */
  getSourcesForClaim(sourceIds: number[]): RegisteredSource[] {
    return sourceIds
      .map(id => this.sources.get(id))
      .filter((s): s is RegisteredSource => s !== undefined);
  }

  /**
   * Snapshot для сериализации в ответ
   */
  toSnapshot(): RegisteredSource[] {
    return this.getAllSources();
  }

  /**
   * Получение только available sources
   */
  getAvailableSources(): RegisteredSource[] {
    return this.getAllSources().filter(s => s.status === 'available');
  }

  /**
   * Получение количества зарегистрированных источников
   */
  getCount(): number {
    return this.sources.size;
  }
}

export default SourceRegistry;
