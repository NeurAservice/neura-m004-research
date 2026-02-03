/**
 * @file src/storage/index.ts
 * @description Экспорт storage модулей
 */

export { initDatabase, getDatabase, closeDatabase, cleanupOldData } from './database';
export * from './researches';
