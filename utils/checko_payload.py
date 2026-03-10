from __future__ import annotations

from typing import Any

DEFAULT_ITEM_KEYS = (
    "Р—Р°РїРёСЃРё",
    "Р РµР·СѓР»СЊС‚Р°С‚С‹",
    "РЎРѕРѕР±С‰РµРЅРёСЏ",
    "Р”РµР»Р°",
    "РљРѕРЅС‚СЂР°РєС‚С‹",
    "РџСЂРѕРІРµСЂРєРё",
    "РРџ",
    "РЎРѕР±С‹С‚РёСЏ",
    "РћС‚С‡РµС‚С‹",
    "items",
    "results",
    "messages",
    "cases",
    "events",
    "reports",
)


def extract_data(payload: Any) -> Any:
    if isinstance(payload, dict):
        return payload.get("data", payload)
    return payload


def extract_items(payload: Any, *keys: str) -> list[dict[str, Any]]:
    data = extract_data(payload)
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if not isinstance(data, dict):
        return []

    for key in (*keys, *DEFAULT_ITEM_KEYS):
        value = data.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]

    return []


def extract_search_results(payload: Any) -> list[dict[str, Any]]:
    return extract_items(payload, "Р—Р°РїРёСЃРё", "Р РµР·СѓР»СЊС‚Р°С‚С‹", "items", "results")
