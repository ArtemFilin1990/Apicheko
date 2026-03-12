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


def _nested(d: dict, *keys: str) -> Any:
    """Traverse nested dicts by key chain, return None if any key missing."""
    current = d
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
        if current is None:
            return None
    return current if current != "" else None


def format_company(data: dict) -> str:
    """Format company (ЮЛ) info for Telegram message using Checko Russian field names."""
    d = data.get("data", data)

    name = _pick(d, "НаимПолн", "НаимСокр")
    inn = d.get("ИНН")
    ogrn = d.get("ОГРН")
    status = _nested(d, "Статус", "Наим")
    date_reg = d.get("ДатаРег")
    address = _nested(d, "ЮрАдрес", "АдресРФ")

    okved_obj = d.get("ОКВЭД") or {}
    okved_code = okved_obj.get("Код")
    okved_name = okved_obj.get("Наим")
    okved = f"{okved_code} — {okved_name}" if okved_code else okved_name

    directors = d.get("Руковод") or []
    director = directors[0].get("ФИО") if directors and isinstance(directors[0], dict) else None

    capital = _nested(d, "УстКап", "Сумма")
    sme_cat = _nested(d, "РМСП", "Кат")
    tax_debt = _nested(d, "Налоги", "СумНедоим")

    contacts = d.get("Контакты") or {}
    phone_raw = contacts.get("Тел")
    email_raw = contacts.get("Емэйл")
    phone = ", ".join(phone_raw) if isinstance(phone_raw, list) else phone_raw
    email = ", ".join(email_raw) if isinstance(email_raw, list) else email_raw
    website = contacts.get("ВебСайт")

    lines = [
        "🏢 <b>Компания</b>",
        "",
        f"📛 <b>Название:</b> {_fmt(name)}",
        f"🔢 <b>ИНН:</b> {_fmt(inn)}",
        f"📌 <b>ОГРН:</b> {_fmt(ogrn)}",
        f"🏷️ <b>Статус:</b> {_fmt(status)}",
        f"📅 <b>Дата регистрации:</b> {_fmt(date_reg)}",
        f"📍 <b>Адрес:</b> {_fmt(address)}",
        f"👤 <b>Руководитель:</b> {_fmt(director)}",
        f"💼 <b>Основной ОКВЭД:</b> {_fmt(okved)}",
    ]
    if capital:
        lines.append(f"💰 <b>Уставной капитал:</b> {_fmt(capital)} руб.")
    if sme_cat:
        lines.append(f"🏭 <b>Категория МСП:</b> {_fmt(sme_cat)}")
    if tax_debt:
        lines.append(f"⚠️ <b>Недоимка по налогам:</b> {_fmt(tax_debt)} руб.")
    if phone:
        lines.append(f"📞 <b>Телефон:</b> {_fmt(phone)}")
    if email:
        lines.append(f"✉️ <b>Email:</b> {_fmt(email)}")
    if website:
        lines.append(f"🌐 <b>Сайт:</b> {_fmt(website)}")

    return "\n".join(lines)


def format_entrepreneur(data: dict) -> str:
    """Format individual entrepreneur (ИП) info using Checko Russian field names."""
    d = data.get("data", data)

    fio = _pick(d, "ФИО", "НаимПолн", "НаимСокр")
    inn = d.get("ИНН")
    ogrnip = d.get("ОГРНИП")
    status = _nested(d, "Статус", "Наим")
    date_reg = d.get("ДатаРег")
    address = _nested(d, "АдрМЖ", "АдресРФ") or _nested(d, "ЮрАдрес", "АдресРФ")

    okved_obj = d.get("ОКВЭД") or {}
    okved_code = okved_obj.get("Код")
    okved_name = okved_obj.get("Наим")
    okved = f"{okved_code} — {okved_name}" if okved_code else okved_name

    lines = [
        "👔 <b>Индивидуальный предприниматель</b>",
        "",
        f"👤 <b>ФИО:</b> {_fmt(fio)}",
        f"🔢 <b>ИНН:</b> {_fmt(inn)}",
        f"📌 <b>ОГРНИП:</b> {_fmt(ogrnip)}",
        f"🏷️ <b>Статус:</b> {_fmt(status)}",
        f"📅 <b>Дата регистрации:</b> {_fmt(date_reg)}",
        f"📍 <b>Адрес:</b> {_fmt(address)}",
        f"💼 <b>Основной ОКВЭД:</b> {_fmt(okved)}",
    ]
    return "\n".join(lines)


def format_person(data: dict) -> str:
    """Format individual (физическое лицо) info using Checko Russian field names."""
    d = data.get("data", data)

    fio = _pick(d, "ФИО", "НаимПолн")
    inn = d.get("ИНН")
    birth_date = _pick(d, "ДатаРожд", "ДатаРождения")
    region = _pick(d, "Регион", "Region")

    lines = [
        "👤 <b>Физическое лицо</b>",
        "",
        f"👤 <b>ФИО:</b> {_fmt(fio)}",
        f"🔢 <b>ИНН:</b> {_fmt(inn)}",
        f"📅 <b>Дата рождения:</b> {_fmt(birth_date)}",
        f"📍 <b>Регион:</b> {_fmt(region)}",
    ]
    return "\n".join(lines)


def format_financial(data: dict) -> str:
    """Format financial report summary from Checko finances endpoint."""
    d = data.get("data", data)
    reports = d if isinstance(d, list) else (d.get("Отчеты") or d.get("reports") or [])
    if not reports:
        return "📊 <b>Финансовая отчётность</b>\n\nДанные недоступны."

    latest = reports[0] if isinstance(reports, list) else reports

    # Checko uses accounting form codes (2110=revenue, 2400=net profit, 1600=assets, 1300=capital)
    year = _pick(latest, "Год", "year")
    revenue = _pick(latest, "2110", "Выручка", "revenue")
    net_profit = _pick(latest, "2400", "ЧистПриб", "netProfit")
    assets = _pick(latest, "1600", "Активы", "assets")
    capital = _pick(latest, "1300", "Капитал", "capital")

    lines = [
        "📊 <b>Финансовая отчётность</b>",
        "",
        f"📅 <b>Год:</b> {_fmt(year)}",
        f"💰 <b>Выручка:</b> {_fmt(revenue)} руб.",
        f"📈 <b>Чистая прибыль:</b> {_fmt(net_profit)} руб.",
        f"💼 <b>Активы:</b> {_fmt(assets)} руб.",
        f"🏦 <b>Капитал:</b> {_fmt(capital)} руб.",
    ]
    if isinstance(reports, list) and len(reports) > 1:
        lines.append(f"\n<i>Показан последний отчёт из {len(reports)} доступных</i>")
    return "\n".join(lines)


def format_arbitration(data: dict) -> str:
    """Format arbitration cases summary using Checko Russian field names."""
    d = data.get("data", data)
    cases = d if isinstance(d, list) else (d.get("Дела") or d.get("cases") or [])
    total = len(cases) if isinstance(cases, list) else _fmt(d.get("Всего") or d.get("total"))
    lines = [
        "⚖️ <b>Арбитражные дела</b>",
        "",
        f"📋 <b>Всего дел:</b> {total}",
    ]
    if isinstance(cases, list) and cases:
        lines.append("")
        for case in cases[:5]:
            num = _pick(case, "Номер", "НомерДела", "number")
            status = _pick(case, "СтатусДело", "Статус", "status")
            date = _pick(case, "ДатаРег", "Дата", "date")
            amount = _pick(case, "СуммаТреб", "amount")
            line = f"• {_fmt(num)}"
            if status:
                line += f" — {_fmt(status)}"
            if date:
                line += f" ({_fmt(date)})"
            if amount:
                line += f", {_fmt(amount)} руб."
            lines.append(line)
        if len(cases) > 5:
            lines.append(f"… и ещё {len(cases) - 5}")
    return "\n".join(lines)


def format_enforcements(data: dict) -> str:
    """Format enforcement proceedings summary using Checko Russian field names."""
    d = data.get("data", data)
    items = d if isinstance(d, list) else (d.get("ИП") or d.get("items") or [])
    total = len(items) if isinstance(items, list) else _fmt(d.get("Всего") or d.get("total"))
    lines = [
        "🏛️ <b>Исполнительные производства</b>",
        "",
        f"📋 <b>Всего:</b> {total}",
        "⚠️ Данные ФССП могут содержать неточные совпадения.",
    ]
    if isinstance(items, list) and items:
        lines.append("")
        for item in items[:5]:
            num = _pick(item, "НомерИП", "Номер", "number")
            amount = _pick(item, "СуммаДолга", "Сумма", "amount")
            date = _pick(item, "ДатаВозб", "Дата", "date")
            subject = _pick(item, "Предмет", "subject")
            line = f"• {_fmt(num)}"
            if amount:
                line += f" — {_fmt(amount)} руб."
            if date:
                line += f" ({_fmt(date)})"
            if subject:
                line += f"\n  {_fmt(subject)}"
            lines.append(line)
        if len(items) > 5:
            lines.append(f"… и ещё {len(items) - 5}")
    return "\n".join(lines)


def format_contracts(data: dict) -> str:
    """Format government contracts summary using Checko Russian field names."""
    d = data.get("data", data)
    items = d if isinstance(d, list) else (d.get("Контракты") or d.get("items") or [])
    total = len(items) if isinstance(items, list) else _fmt(d.get("Всего") or d.get("total"))
    lines = [
        "📑 <b>Государственные контракты</b>",
        "",
        f"📋 <b>Всего контрактов:</b> {total}",
    ]
    if isinstance(items, list) and items:
        lines.append("")
        for item in items[:5]:
            num = _pick(item, "НомерКонтракта", "Номер", "number")
            amount = _pick(item, "СуммаКонтракта", "Цена", "amount")
            date = _pick(item, "ДатаЗакл", "Дата", "date")
            customer = _pick(item, "Заказчик", "customer")
            line = f"• {_fmt(num)}"
            if amount:
                line += f" — {_fmt(amount)} руб."
            if date:
                line += f" ({_fmt(date)})"
            if customer:
                line += f"\n  {_fmt(customer)}"
            lines.append(line)
        if len(items) > 5:
            lines.append(f"… и ещё {len(items) - 5}")
    return "\n".join(lines)


def format_inspections(data: dict) -> str:
    """Format inspections summary using Checko Russian field names."""
    d = data.get("data", data)
    items = d if isinstance(d, list) else (d.get("Проверки") or d.get("items") or [])
    total = len(items) if isinstance(items, list) else _fmt(d.get("Всего") or d.get("total"))
    lines = [
        "🔍 <b>Проверки</b>",
        "",
        f"📋 <b>Всего проверок:</b> {total}",
    ]
    if isinstance(items, list) and items:
        lines.append("")
        for item in items[:5]:
            organ = _pick(item, "Орган", "organ", "type")
            date_start = _pick(item, "ДатаНач", "Дата", "date")
            date_end = _pick(item, "ДатаОкон", "dateEnd")
            kind = _pick(item, "ВидПроверки", "Вид", "kind")
            line = f"• {_fmt(organ)}"
            if kind:
                line += f" ({_fmt(kind)})"
            if date_start:
                line += f" — {_fmt(date_start)}"
                if date_end:
                    line += f"–{_fmt(date_end)}"
            lines.append(line)
        if len(items) > 5:
            lines.append(f"… и ещё {len(items) - 5}")
    return "\n".join(lines)


def format_bankruptcy(data: dict) -> str:
    """Format bankruptcy (ЕФРСБ) records using Checko Russian field names."""
    d = data.get("data", data)
    items = d if isinstance(d, list) else (d.get("Сообщения") or d.get("messages") or [])
    lines = [
        "📰 <b>Записи ЕФРСБ (Банкротство)</b>",
        "",
        f"📋 <b>Всего записей:</b> {len(items) if isinstance(items, list) else '—'}",
    ]
    if isinstance(items, list) and items:
        lines.append("")
        for item in items[:5]:
            msg_type = _pick(item, "ТипСообщ", "Тип", "type")
            date = _pick(item, "Дата", "ДатаПубл", "date")
            lines.append(f"• {_fmt(msg_type)} ({_fmt(date)})")
        if len(items) > 5:
            lines.append(f"… и ещё {len(items) - 5}")
    return "\n".join(lines)


def format_history(data: dict) -> str:
    """Format change history using Checko Russian field names."""
    d = data.get("data", data)
    events = d if isinstance(d, list) else (d.get("События") or d.get("events") or [])
    lines = [
        "📜 <b>История изменений</b>",
        "",
        f"📋 <b>Всего событий:</b> {len(events) if isinstance(events, list) else '—'}",
    ]
    if isinstance(events, list) and events:
        lines.append("")
        for ev in events[:5]:
            event_name = _pick(ev, "Событие", "ВидИзм", "type", "event", "name")
            event_date = _pick(ev, "Дата", "ДатаИзм", "date", "eventDate")
            lines.append(f"• {_fmt(event_name)} ({_fmt(event_date)})")
        if len(events) > 5:
            lines.append(f"… и ещё {len(events) - 5}")
    return "\n".join(lines)


def format_fedresurs(data: dict) -> str:
    """Format Fedresurs messages using Checko Russian field names."""
    d = data.get("data", data)
    items = d if isinstance(d, list) else (d.get("Сообщения") or d.get("messages") or [])
    lines = [
        "📄 <b>Сообщения Федресурса</b>",
        "",
        f"📋 <b>Всего сообщений:</b> {len(items) if isinstance(items, list) else '—'}",
    ]
    if isinstance(items, list) and items:
        lines.append("")
        for item in items[:5]:
            msg_type = _pick(item, "ТипСообщ", "Тип", "type")
            date = _pick(item, "Дата", "ДатаПубл", "date")
            lines.append(f"• {_fmt(msg_type)} ({_fmt(date)})")
        if len(items) > 5:
            lines.append(f"… и ещё {len(items) - 5}")
    return "\n".join(lines)


def format_bank(data: dict) -> str:
    """Format bank / credit organization info."""
    d = data.get("data", data)
    cor = d.get("КорСчет") or {}
    lines = [
        "🏦 <b>Банк / Кредитная организация</b>",
        "",
        f"📛 <b>Название:</b> {_fmt(d.get('Наим'))}",
        f"🔑 <b>БИК:</b> {_fmt(d.get('БИК'))}",
        f"📍 <b>Адрес:</b> {_fmt(d.get('Адрес'))}",
        f"🏷️ <b>Тип:</b> {_fmt(d.get('Тип'))}",
        f"💳 <b>Корр. счёт:</b> {_fmt(cor.get('Номер'))}",
    ]
    return "\n".join(lines)


def format_search_results(results: list[dict]) -> str:
    """Format a list of search results."""
    if not results:
        return "🔎 По вашему запросу ничего не найдено."
    lines = [f"🔎 <b>Найдено результатов: {len(results)}</b>", ""]
    for i, item in enumerate(results[:10], 1):
        name = _fmt(_pick(item, "НаимПолн", "НаимСокр", "name", "shortName"))
        inn = _fmt(_pick(item, "ИНН", "inn"))
        lines.append(f"{i}. {name} (ИНН: {inn})")
    if len(results) > 10:
        lines.append(f"\n… и ещё {len(results) - 10}. Выберите из списка выше.")
    else:
        lines.append("\nВыберите запись из списка ниже:")
    return "\n".join(lines)
