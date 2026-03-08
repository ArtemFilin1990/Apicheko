from __future__ import annotations

import html
from typing import Any


def _fmt(value: Any, default: str = "—") -> str:
    """Return HTML-escaped string value or dash for empty/None."""
    if value is None or value == "":
        return default
    return html.escape(str(value))


def _pick(source: dict[str, Any], *keys: str) -> Any:
    """Return the first present non-empty value from source by key candidates."""
    for key in keys:
        value = source.get(key)
        if value not in (None, ""):
            return value
    return None


def format_company(data: dict) -> str:
    """Format company (ЮЛ) info for Telegram message."""
    d = data.get("data", data)
    lines = [
        "🏢 <b>Компания</b>",
        "",
        f"📛 <b>Название:</b> {_fmt(d.get('fullName') or d.get('shortName'))}",
        f"🔢 <b>ИНН:</b> {_fmt(d.get('inn'))}",
        f"📌 <b>ОГРН:</b> {_fmt(d.get('ogrn'))}",
        f"📍 <b>Адрес:</b> {_fmt(d.get('address'))}",
        f"📅 <b>Дата регистрации:</b> {_fmt(d.get('registrationDate'))}",
        f"🏷️ <b>Статус:</b> {_fmt(d.get('status'))}",
        f"👤 <b>Руководитель:</b> {_fmt(d.get('director'))}",
        f"👥 <b>Сотрудников:</b> {_fmt(d.get('employeesCount'))}",
        f"💼 <b>Основной ОКВЭД:</b> {_fmt(d.get('okved'))}",
    ]
    return "\n".join(lines)


def format_entrepreneur(data: dict) -> str:
    """Format individual entrepreneur (ИП) info."""
    d = data.get("data", data)
    lines = [
        "👔 <b>Индивидуальный предприниматель</b>",
        "",
        f"👤 <b>ФИО:</b> {_fmt(d.get('fio') or d.get('name'))}",
        f"🔢 <b>ИНН:</b> {_fmt(d.get('inn'))}",
        f"📌 <b>ОГРНИП:</b> {_fmt(d.get('ogrnip'))}",
        f"📅 <b>Дата регистрации:</b> {_fmt(d.get('registrationDate'))}",
        f"🏷️ <b>Статус:</b> {_fmt(d.get('status'))}",
        f"📍 <b>Регион:</b> {_fmt(d.get('region'))}",
        f"💼 <b>Основной ОКВЭД:</b> {_fmt(d.get('okved'))}",
    ]
    return "\n".join(lines)


def format_person(data: dict) -> str:
    """Format individual (физическое лицо) info."""
    d = data.get("data", data)
    lines = [
        "👤 <b>Физическое лицо</b>",
        "",
        f"👤 <b>ФИО:</b> {_fmt(d.get('fio') or d.get('name'))}",
        f"🔢 <b>ИНН:</b> {_fmt(d.get('inn'))}",
        f"📅 <b>Дата рождения:</b> {_fmt(d.get('birthDate'))}",
        f"📍 <b>Регион:</b> {_fmt(d.get('region'))}",
    ]
    return "\n".join(lines)


def format_financial(data: dict) -> str:
    """Format financial report summary."""
    d = data.get("data", data)
    reports = d if isinstance(d, list) else d.get("reports", [])
    if not reports:
        return "📊 <b>Финансовая отчётность</b>\n\nДанные недоступны."
    latest = reports[0] if isinstance(reports, list) else reports
    lines = [
        "📊 <b>Финансовая отчётность</b>",
        "",
        f"📅 <b>Год:</b> {_fmt(latest.get('year'))}",
        f"💰 <b>Выручка:</b> {_fmt(latest.get('revenue'))} руб.",
        f"📈 <b>Чистая прибыль:</b> {_fmt(latest.get('netProfit'))} руб.",
        f"💼 <b>Активы:</b> {_fmt(latest.get('assets'))} руб.",
        f"🏦 <b>Капитал:</b> {_fmt(latest.get('capital'))} руб.",
    ]
    return "\n".join(lines)


def format_arbitration(data: dict) -> str:
    """Format arbitration cases summary."""
    d = data.get("data", data)
    cases = d if isinstance(d, list) else d.get("cases", [])
    total = len(cases) if isinstance(cases, list) else _fmt(d.get("total"))
    lines = [
        "⚖️ <b>Арбитражные дела</b>",
        "",
        f"📋 <b>Всего дел:</b> {total}",
    ]
    if isinstance(cases, list):
        for case in cases[:5]:
            lines.append(
                f"• {_fmt(case.get('number'))} — {_fmt(case.get('status'))} "
                f"({_fmt(case.get('date'))})"
            )
        if len(cases) > 5:
            lines.append(f"… и ещё {len(cases) - 5}")
    return "\n".join(lines)


def format_enforcements(data: dict) -> str:
    """Format enforcement proceedings summary."""
    d = data.get("data", data)
    items = d if isinstance(d, list) else d.get("items", [])
    total = len(items) if isinstance(items, list) else _fmt(d.get("total"))
    lines = [
        "🏛️ <b>Исполнительные производства</b>",
        "",
        f"📋 <b>Всего:</b> {total}",
    ]
    if isinstance(items, list):
        for item in items[:5]:
            lines.append(
                f"• {_fmt(item.get('number'))} — {_fmt(item.get('amount'))} руб. "
                f"({_fmt(item.get('date'))})"
            )
        if len(items) > 5:
            lines.append(f"… и ещё {len(items) - 5}")
    return "\n".join(lines)


def format_contracts(data: dict) -> str:
    """Format government contracts summary."""
    d = data.get("data", data)
    items = d if isinstance(d, list) else d.get("items", [])
    total = len(items) if isinstance(items, list) else _fmt(d.get("total"))
    lines = [
        "📑 <b>Государственные контракты</b>",
        "",
        f"📋 <b>Всего контрактов:</b> {total}",
    ]
    if isinstance(items, list):
        for item in items[:5]:
            lines.append(
                f"• {_fmt(item.get('number'))} — {_fmt(item.get('amount'))} руб. "
                f"({_fmt(item.get('date'))})"
            )
        if len(items) > 5:
            lines.append(f"… и ещё {len(items) - 5}")
    return "\n".join(lines)


def format_inspections(data: dict) -> str:
    """Format inspections summary."""
    d = data.get("data", data)
    items = d if isinstance(d, list) else d.get("items", [])
    total = len(items) if isinstance(items, list) else _fmt(d.get("total"))
    lines = [
        "🔍 <b>Проверки</b>",
        "",
        f"📋 <b>Всего проверок:</b> {total}",
    ]
    if isinstance(items, list):
        for item in items[:5]:
            lines.append(
                f"• {_fmt(item.get('type'))} — {_fmt(item.get('organ'))} "
                f"({_fmt(item.get('date'))})"
            )
        if len(items) > 5:
            lines.append(f"… и ещё {len(items) - 5}")
    return "\n".join(lines)


def format_bankruptcy(data: dict) -> str:
    """Format bankruptcy (ЕФРСБ) records."""
    d = data.get("data", data)
    items = d if isinstance(d, list) else d.get("messages", [])
    lines = [
        "📰 <b>Записи ЕФРСБ (Банкротство)</b>",
        "",
        f"📋 <b>Всего записей:</b> {len(items) if isinstance(items, list) else '—'}",
    ]
    if isinstance(items, list):
        for item in items[:5]:
            lines.append(
                f"• {_fmt(item.get('type'))} ({_fmt(item.get('date'))})"
            )
        if len(items) > 5:
            lines.append(f"… и ещё {len(items) - 5}")
    return "\n".join(lines)


def format_history(data: dict) -> str:
    """Format change history."""
    d = data.get("data", data)
    events = d if isinstance(d, list) else d.get("events", [])
    lines = [
        "📜 <b>История изменений</b>",
        "",
        f"📋 <b>Всего событий:</b> {len(events) if isinstance(events, list) else '—'}",
    ]
    if isinstance(events, list):
        for ev in events[:5]:
            event_name = _pick(ev, "type", "event", "name", "Событие")
            event_date = _pick(ev, "date", "eventDate", "Дата")
            lines.append(f"• {_fmt(event_name)} ({_fmt(event_date)})")
        if len(events) > 5:
            lines.append(f"… и ещё {len(events) - 5}")
    return "\n".join(lines)


def format_search_results(results: list[dict]) -> str:
    """Format a list of search results."""
    if not results:
        return "🔎 По вашему запросу ничего не найдено."
    lines = [f"🔎 <b>Найдено результатов: {len(results)}</b>", ""]
    for i, item in enumerate(results[:10], 1):
        name = _fmt(item.get("name") or item.get("shortName"))
        inn = _fmt(item.get("inn"))
        lines.append(f"{i}. {name} (ИНН: {inn})")
    if len(results) > 10:
        lines.append(f"\n… и ещё {len(results) - 10}. Выберите из списка выше.")
    else:
        lines.append("\nВыберите запись из списка ниже:")
    return "\n".join(lines)
