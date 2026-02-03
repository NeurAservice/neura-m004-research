# NeurA Research (m004)

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
  - Claude claude-sonnet-4-20250514 (planning, synthesis)
- **Storage:** SQLite (bind mount вне контейнера)
- **Frontend:** Vanilla JS, HTML5, CSS3

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
1. SSH подключение к серверу
2. `git pull`
3. `docker compose down`
4. `docker compose up --build -d`
5. Health check

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

### Internal API (без биллинга)

- `POST /api/internal/research` — исследование для других модулей

## Структура

```
m004/
├── src/
│   ├── index.ts              # Entry point
│   ├── app.ts                # Express app
│   ├── config/               # Конфигурация
│   ├── routes/               # API endpoints
│   ├── services/             # Сервисы
│   │   ├── core.ts          # CORE integration
│   │   ├── perplexity.ts    # Perplexity client
│   │   ├── anthropic.ts     # Claude client
│   │   └── pipeline/        # Research pipeline
│   ├── storage/              # SQLite
│   ├── middleware/           # Middleware
│   ├── utils/                # Утилиты
│   └── types/                # TypeScript типы
├── public/                   # Frontend UI
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

PERPLEXITY_API_KEY=...
ANTHROPIC_API_KEY=...

CORE_API_URL=http://neura-core:8000
CORE_API_KEY=...
```

## Документация

См. [M004_TECHNICAL_SPECIFICATION.md](../../docs/modules/m004/M004_TECHNICAL_SPECIFICATION.md)
