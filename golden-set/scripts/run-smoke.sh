#!/bin/bash
# @file golden-set/scripts/run-smoke.sh
# @description Shell-скрипт запуска smoke тестов (используется в CI)
# @context Запускается из директории golden-set/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GS_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Golden Set Smoke Tests ==="
echo "Working directory: $GS_DIR"
echo "API URL: ${M004_API_URL:-not set}"
echo "API Key: ${M004_INTERNAL_API_KEY:+***set***}"
echo ""

# Проверяем обязательные переменные
if [ -z "${M004_API_URL:-}" ]; then
  echo "❌ ERROR: M004_API_URL is not set"
  exit 1
fi

if [ -z "${M004_INTERNAL_API_KEY:-}" ]; then
  echo "❌ ERROR: M004_INTERNAL_API_KEY is not set"
  exit 1
fi

cd "$GS_DIR"

# Создаём директорию output
mkdir -p output

# Запускаем promptfoo eval
echo "Running promptfoo eval..."
npx promptfoo eval \
  --config promptfooconfig.yaml \
  --output output/smoke-results.json \
  --no-cache \
  2>&1 | tee output/smoke-log.txt

EXIT_CODE=${PIPESTATUS[0]}

echo ""
echo "=== Smoke Tests Complete (exit code: $EXIT_CODE) ==="

# Парсим результаты для summary
if [ -f output/smoke-results.json ]; then
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('output/smoke-results.json', 'utf-8'));
    const results = data.results || [];
    const total = results.length;
    const passed = results.filter(r => r.success).length;
    const failed = total - passed;

    console.log('');
    console.log('Summary:');
    console.log('  Total:  ' + total);
    console.log('  Passed: ' + passed);
    console.log('  Failed: ' + failed);

    if (failed > 0) {
      console.log('');
      console.log('Failed tests:');
      for (const r of results) {
        if (!r.success) {
          const failedAsserts = (r.gradingResult?.componentResults || [])
            .filter(a => !a.pass)
            .map(a => '    - ' + a.reason)
            .join('\n');
          console.log('  ❌ ' + (r.vars?.query?.substring(0, 60) || 'unknown'));
          if (failedAsserts) console.log(failedAsserts);
        }
      }
    }
  "
fi

exit $EXIT_CODE
