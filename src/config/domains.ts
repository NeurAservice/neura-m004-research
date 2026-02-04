/**
 * @file src/config/domains.ts
 * @description Конфигурация фильтрации доменов для Perplexity API
 * @context Используется для повышения качества источников в research и verification
 */

/**
 * Домены, исключаемые из поиска на этапе Research.
 *
 * Почему эти домены:
 * - reddit.com, quora.com — UGC контент, мнения без проверки
 * - medium.com — блоги, часто без источников
 * - pinterest.com — изображения, не информационный контент
 * - answers.com, wikihow.com — низкое качество информации
 */
export const RESEARCH_DOMAIN_DENYLIST = [
  '-reddit.com',
  '-quora.com',
  '-medium.com',
  '-pinterest.com',
  '-answers.com',
  '-wikihow.com',
  '-yahoo.com', // Yahoo Answers
];

/**
 * Домены, разрешённые для верификации фактов.
 *
 * Почему именно эти:
 * - .gov, .edu — официальные государственные и образовательные
 * - nature.com, science.org — ведущие научные журналы
 * - arxiv.org — препринты (с оговоркой о непроверенности)
 * - reuters.com, bbc.com — авторитетные новостные агентства
 * - wikipedia.org — энциклопедия с цитированием источников
 */
export const VERIFICATION_DOMAIN_ALLOWLIST = [
  '.gov',
  '.edu',
  'nature.com',
  'science.org',
  'arxiv.org',
  'pubmed.ncbi.nlm.nih.gov',
  'reuters.com',
  'bbc.com',
  'wikipedia.org',
  'britannica.com',
];

/**
 * Получить denylist для research фазы
 */
export function getResearchDenylist(): string[] {
  return [...RESEARCH_DOMAIN_DENYLIST];
}

/**
 * Получить allowlist для verification фазы
 */
export function getVerificationAllowlist(): string[] {
  return [...VERIFICATION_DOMAIN_ALLOWLIST];
}
