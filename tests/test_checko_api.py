import unittest

from bot.checko_api import CheckoAPI
from bot.formatters import format_history


class _FakeCheckoAPI(CheckoAPI):
    def __init__(self) -> None:
        super().__init__(base_url="https://api.checko.ru/v2", key="test")
        self.calls: list[tuple[str, dict]] = []

    async def _get(self, endpoint: str, **params):  # type: ignore[override]
        self.calls.append((endpoint, params))

        if endpoint == "contracts":
            law = params.get("law")
            return {"data": {"items": [{"number": f"contract-{law}"}]}}

        return {"ok": True}


class CheckoAPIContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_uses_documented_endpoint_names(self) -> None:
        api = _FakeCheckoAPI()

        await api.get_company(inn="7707083893")
        await api.get_company_short(inn="7707083893")
        await api.get_entrepreneur(inn="7707083893")
        await api.get_person(inn="7707083893")
        await api.get_arbitration(inn="7707083893")
        await api.get_bankruptcy(inn="7707083893")
        await api.get_enforcements(inn="7707083893")
        await api.get_financial(inn="7707083893")
        await api.get_history(inn="7707083893")
        await api.get_inspections(inn="7707083893")
        await api.search("Сбер")
        await api.get_bank("044525225")

        self.assertEqual(
            [call[0] for call in api.calls],
            [
                "company",
                "company/short",
                "entrepreneur",
                "person",
                "legal-cases",
                "bankruptcy-messages",
                "enforcements",
                "finances",
                "timeline",
                "inspections",
                "search",
                "bank",
            ],
        )

    async def test_contracts_requests_all_supported_laws(self) -> None:
        api = _FakeCheckoAPI()

        response = await api.get_contracts(inn="7707083893")

        self.assertEqual(
            api.calls,
            [
                ("contracts", {"inn": "7707083893", "law": "44"}),
                ("contracts", {"inn": "7707083893", "law": "94"}),
                ("contracts", {"inn": "7707083893", "law": "223"}),
            ],
        )
        self.assertEqual(
            response,
            {
                "data": {
                    "items": [
                        {"number": "contract-44"},
                        {"number": "contract-94"},
                        {"number": "contract-223"},
                    ]
                }
            },
        )

    async def test_call_method_rejects_unknown_name(self) -> None:
        api = _FakeCheckoAPI()

        with self.assertRaises(ValueError) as exc:
            await api.call_method("unknown", inn="7707083893")

        self.assertIn("Unknown Checko method", str(exc.exception))


class KeyboardTests(unittest.TestCase):
    def test_company_detail_keyboard_has_no_bank_button(self) -> None:
        from bot.keyboards import company_detail_keyboard

        markup = company_detail_keyboard("7707083893")
        labels = [btn.text for row in markup.inline_keyboard for btn in row]
        self.assertNotIn("🏦 Банки", labels)


class HistoryFormatterTests(unittest.TestCase):
    def test_format_history_supports_documented_russian_keys(self) -> None:
        payload = {
            "data": [
                {"Дата": "2024-01-01", "Событие": "Смена руководителя"},
            ]
        }

        text = format_history(payload)

        self.assertIn("Смена руководителя", text)
        self.assertIn("2024-01-01", text)


if __name__ == "__main__":
    unittest.main()
