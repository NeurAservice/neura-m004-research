# NeurA Research (m004) v2.5.0

> Модуль глубоких верифицированных исследований

## Описание

NeurA Research — модуль глубоких исследований, который:

1. **Самостоятельный продукт** — пользователи проводят исследования через UI
2. **Сервис для других модулей** — m003 и другие модули вызывают m004 через HTTP API

### Ключевой принцип

> **"Лучше не писать факт, чем написать непроверенный"**

Модуль включает в финальный отчёт **только верифицированные факты** с confidence ≥ 0.80.

## URLs

- **Production:** https://neuraservicecore.neuradeck.com/m004/
- **GitHub:** https://github.com/NeurAservice/neura-m004-research
- **iframe для shell s003:** `https://neuraservicecore.neuradeck.com/m004/?shell=s003&user_id=<USER_ID>`

## Технологии

- **Runtime:** Node.js 20+
- **Backend:** Express 4.x, TypeScript 5.x
- **AI Models:**
  - Perplexity sonar-pro (research + verification)
  - Claude claude-sonnet-4 (planning, synthesis, output)
  - OpenAI GPT-4.1-nano (triage, NLI verification)
  - OpenAI GPT-4.1-mini (claim decomposition, quality gate)
- **Storage:** SQLite (bind mount вне контейнера)
- **Frontend:** Vanilla JS, HTML5, CSS3

## Ключевые фичи

- **Multi-model Pipeline** — 6-фазный пайплайн (Triage → Planning → Research → Verification → Output → Quality Gate)
- **Token Budget Control** — бюджетный менеджер с circuit breaker
- **Source Authority Scoring + SourceRegistry** — оценка авторитетности и дедупликация источников
- **Pre-Triage эвристики** — быстрая классификация запросов до AI-вызова
- **Quality Gate (A/B/C/F grading)** — оценка качества исследования
- **Adaptive Verification** — адаптивная верификация в зависимости от режима
- **Stats Collector** — сбор статистики по запросам
- **Warnings система** — рекомендации пользователю (SUGGEST_DEEPER_MODE и др.)
- **Golden Set** — smoke тестирование через promptfoo
- **3+1 режима**: simple / standard / deep + auto
- **Экспорт** в Markdown/PDF/JSON
- **Internal API** для других модулей (без биллинга)

## Запуск

### Локальная разработка

```bash
npm install
npm run dev
```

### Docker (development)

```bash
docker-compose -f docker-compose.dev.yml up --build
```

### Production

```bash
docker-compose up -d --build
```

## Деплой

### Автоматический (GitHub Actions)

При push в `main` запускается workflow `.github/workflows/deploy.yml`:

1. SSH подключение к серверу (с retry-логикой)
2. `git fetch && git reset --hard origin/main`
3. `docker compose build` (с retry)
4. `docker compose up -d`
5. Health check (до 120 сек)

### Ручной

```bash
# 1. Отправить .env на сервер
scp -i <SSH_KEY> -P 2222 .env neuraservice@217.60.63.86:/opt/neura/m004/.env

# 2. На сервере
cd /opt/neura/m004
git pull
docker compose up --build -d
```

## API

### UI API (с биллингом)

- `POST /api/research` — создать исследование (SSE stream)
- `POST /api/research/:id/clarify` — ответить на уточняющие вопросы (SSE stream)
- `GET /api/research/:id` — получить результат
- `GET /api/research/:id/status` — статус исследования
- `GET /api/research/history` — история исследований
- `GET /api/research/:id/export` — экспорт (markdown/pdf/json)
- `GET /api/balance` — баланс пользователя

### Internal API (без биллинга)

- `POST /api/internal/research` — исследование для других модулей

### Health

- `GET /health` — health check

## Структура

```
m004/
├── src/
│   ├── index.ts              # Entry point
│   ├── app.ts                # Express app
│   ├── config/               # Конфигурация (prompts, domains, authority)
│   ├── routes/               # API endpoints
│   │   ├── research.ts       # UI API (SSE)
│   │   ├── internal.ts       # Internal API
│   │   ├── balance.ts        # Balance endpoint
│   │   ├── health.ts         # Health check
│   │   └── identity.ts       # Identity resolution
│   ├── services/             # Сервисы
│   │   ├── core.ts           # CORE integration
│   │   ├── perplexity.ts     # Perplexity client
│   │   ├── anthropic.ts      # Claude client
│   │   ├── openai.ts         # OpenAI client
│   │   ├── budget.ts         # Token Budget Manager
│   │   ├── sourceRegistry.ts # Source dedup & URL validation
│   │   └── pipeline/         # Research pipeline
│   │       ├── orchestrator.ts
│   │       ├── triage.ts
│   │       ├── clarification.ts
│   │       ├── planning.ts
│   │       ├── research.ts
│   │       ├── verification.ts
│   │       ├── output.ts
│   │       └── qualityGate.ts
│   ├── storage/              # SQLite
│   ├── middleware/            # Middleware (auth, error, logging)
│   ├── utils/                # Утилиты
│   │   ├── logger.ts         # Winston logger
│   │   ├── preTriage.ts      # Pre-Triage эвристики
│   │   ├── statsCollector.ts # Stats Collector
│   │   └── helpers.ts        # Хелперы
│   └── types/                # TypeScript типы
├── public/                   # Frontend UI
├── golden-set/               # Golden Set (promptfoo smoke tests)
├── data/                     # SQLite database (bind mount)
├── logs/                     # Логи (bind mount)
├── Dockerfile
├── docker-compose.yml
└── .env                      # Переменные окружения (не в git!)
```

## Переменные окружения

```env
NODE_ENV=production
PORT=3004

# AI Models
PERPLEXITY_API_KEY=...
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...

# CORE Integration
CORE_API_URL=...
CORE_API_KEY=...

# Internal API
INTERNAL_API_KEY=...

# Budget Limits
BUDGET_SIMPLE_MAX_TOKENS=...
BUDGET_SIMPLE_MAX_COST_USD=...
BUDGET_STANDARD_MAX_TOKENS=...
BUDGET_STANDARD_MAX_COST_USD=...
BUDGET_DEEP_MAX_TOKENS=...
BUDGET_DEEP_MAX_COST_USD=...

# Circuit Breaker Thresholds
CIRCUIT_BREAKER_WARNING=...
CIRCUIT_BREAKER_CRITICAL=...
CIRCUIT_BREAKER_STOP=...
```

## Документация

См. [M004_SPECIFICATION.md](../../docs/modules/m004/M004_SPECIFICATION.md)
