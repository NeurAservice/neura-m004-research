# NeurA Research (m004)

> Модуль глубоких верифицированных исследований

## Описание

NeurA Research — модуль глубоких исследований, который:

1. **Самостоятельный продукт** — пользователи проводят исследования через UI
2. **Сервис для других модулей** — m003 и другие модули вызывают m004 через HTTP API

### Ключевой принцип

> **"Лучше не писать факт, чем написать непроверенный"**

Модуль включает в финальный отчёт **только верифицированные факты** с confidence ≥ 0.80.

## Технологии

- **Runtime:** Node.js 20+
- **Backend:** Express 4.x, TypeScript 5.x
- **AI Models:** Perplexity sonar-pro, Claude Sonnet 4
- **Storage:** SQLite
- **Frontend:** Vanilla JS, HTML5, CSS3

## Запуск

### Локальная разработка

```bash
npm install
npm run dev
```

### Docker

```bash
docker-compose up --build
```

### Production

```bash
docker-compose -f docker-compose.yml up -d --build
```

## API

### UI API (с биллингом)

- `POST /api/research` — создать исследование
- `POST /api/research/:id/clarify` — ответить на уточняющие вопросы
- `GET /api/research/:id` — получить результат
- `GET /api/research/:id/status` — статус исследования
- `GET /api/research/history` — история исследований
- `GET /api/research/:id/export` — экспорт (markdown/pdf/json)

### Internal API (без биллинга)

- `POST /api/internal/research` — исследование для других модулей

## Структура

```
src/
├── index.ts              # Entry point
├── app.ts                # Express app
├── config/               # Конфигурация
├── routes/               # API endpoints
├── services/             # Сервисы
│   ├── core.ts          # CORE integration
│   ├── perplexity.ts    # Perplexity client
│   ├── anthropic.ts     # Claude client
│   └── pipeline/        # Research pipeline
├── storage/              # SQLite
├── middleware/           # Middleware
├── utils/                # Утилиты
└── types/                # TypeScript типы
```

## Документация

См. [M004_TECHNICAL_SPECIFICATION.md](../../docs/modules/m004/M004_TECHNICAL_SPECIFICATION.md)
