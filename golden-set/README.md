# Golden Set — m004 NeurA Research

## Что это

Golden Set — набор эталонных запросов для обнаружения деградации quality pipeline m004.
Каждый прогон отправляет реальные запросы через Internal API и проверяет ответы
программными assertions (grade, compositeScore, cost, key claims и т.д.).

**Без LLM-as-judge** — только программные проверки.

## Структура

```
golden-set/
├── promptfooconfig.yaml          # Основной конфиг promptfoo
├── providers/
│   └── m004-internal.js          # Custom provider для internal API
├── assertions/
│   └── research-quality.js       # Кастомные assertion-функции
├── datasets/
│   └── smoke.yaml                # 5 test cases для smoke
├── scripts/
│   └── run-smoke.sh              # Shell-скрипт запуска (CI)
└── README.md
```

## Как запустить вручную

### Предварительные условия

- Node.js 20+
- m004 запущен локально (порт 3004) или доступен по URL
- Установлен promptfoo: `npm install promptfoo` (в папке golden-set)

### Запуск

```bash
cd golden-set
npm install promptfoo

# Задаём переменные окружения
export M004_API_URL=http://localhost:3004
export M004_INTERNAL_API_KEY=<key из .env>

# Запускаем
npx promptfoo eval --config promptfooconfig.yaml --no-cache
```

Для Windows PowerShell:

```powershell
cd golden-set
npm install promptfoo

$env:M004_API_URL = "http://localhost:3004"
$env:M004_INTERNAL_API_KEY = "<key из .env>"

npx promptfoo eval --config promptfooconfig.yaml --no-cache
```

Результаты сохраняются в `output/smoke-results.json`.

## Как запустить из GitHub Actions

```bash
gh workflow run golden-set-smoke.yml
```

Workflow использует SSH-туннель к серверу для доступа к internal API.

## Assertions (8 типов)

| #   | Assertion       | Описание                             |
| --- | --------------- | ------------------------------------ |
| 1   | Grade           | Грейд ≥ порог (A > B > C > F)        |
| 2   | CompositeScore  | Composite quality score ≥ минимум    |
| 3   | Cost            | Стоимость в допустимом диапазоне USD |
| 4   | Report length   | Отчёт не пустой (≥ N символов)       |
| 5   | Sources         | Количество источников ≥ минимум      |
| 6   | Claims          | Не все claims имеют status "omitted" |
| 7   | Key claims      | Ключевые факты найдены в отчёте      |
| 8   | Negative claims | Запрещённые утверждения отсутствуют  |

## Как добавить test case

Открой `datasets/smoke.yaml`, добавь запись по шаблону:

```yaml
- vars:
    query: "Текст запроса"
    mode: "simple"
    language: "ru"
    expected_min_grade: "C"
    expected_min_composite: 0.35
    expected_max_cost: 0.20
    expected_min_cost: 0.005
    expected_min_report_length: 200
    expected_min_sources: 1
    key_claims:
      - "ключевой факт"
    negative_claims: []
  assert:
    # Скопируй блок assert из любого существующего test case
```

## Как интерпретировать результаты

### GitHub Actions

- **Summary** — таблица passed/failed в GitHub summary workflow run
- **Artifacts** — полный JSON с результатами (хранится 30 дней)

### Локально

- `output/smoke-results.json` — полный JSON с результатами каждого теста
- Каждый test содержит `success: true/false` и `gradingResult` с деталями assertions

## Стоимость прогона

- **5 simple запросов**: ~$0.40 за прогон
- **Время**: ~2–3 минуты (5 × ~30 сек)

## Baseline (калибровка порогов)

> Заполнить после первых 3–5 прогонов.

| Test                | Median Grade | Median Composite | Median Cost |
| ------------------- | ------------ | ---------------- | ----------- |
| 1. Telegram Bot API | —            | —                | —           |
| 2. HTTP Protocol    | —            | —                | —           |
| 3. WebAssembly      | —            | —                | —           |
| 4. Claude/GPT-4.1   | —            | —                | —           |
| 5. REST vs GraphQL  | —            | —                | —           |

Пороги установлены с запасом ±15% от медианы. Скорректировать после набора данных.

## Важно

- **Не идемпотентен** — каждый вызов тратит реальные деньги
- **Стохастичность** — LLM дают разные ответы, key claims должны быть устойчивыми
- **Timeout** — provider использует 15 мин timeout (deep mode может быть долгим)
- **Golden Set requests** помечаются в stats флагом `goldenSet: true` (по prefix `gs-` в requestId)
