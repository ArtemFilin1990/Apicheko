# Codex Playbook

Этот файл заменяет старые Claude-ориентированные инструкции.

## Приоритет

1. Исправления в production Worker (`worker/worker.js`) важнее вторичных runtime.
2. Для интеграции Checko всегда проверять `meta.status`/`meta.message`, HTTP-код и JSON-формат.
3. Ошибки Checko не должны маскироваться под пустые данные.

## Автопроверки

Запускать из корня репозитория:

```bash
node --check worker/worker.js
node --test tests/worker_smoke.test.mjs
python -m unittest discover -s tests -p "test_*.py"
```

Если конкретная проверка неприменима (например, отсутствует Python-зависимость), явно указать это в отчёте.
