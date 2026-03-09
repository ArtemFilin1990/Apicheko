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

        await api.get_arbitration("7707083893")
        await api.get_bankruptcy("7707083893")
        await api.get_financial("7707083893")
        await api.get_history("7707083893")
        await api.get_fedresurs("7707083893")
        await api.get_bank("044525225")

        self.assertEqual(api.calls[0][0], "legal-cases")
        self.assertEqual(api.calls[1][0], "bankruptcy-messages")
        self.assertEqual(api.calls[2][0], "finances")
        self.assertEqual(api.calls[3][0], "timeline")
        self.assertEqual(api.calls[4][0], "fedresurs")
        self.assertEqual(api.calls[5][0], "bank")
        self.assertEqual(api.calls[5][1], {"bic": "044525225"})

    async def test_contracts_requests_all_supported_laws(self) -> None:
        api = _FakeCheckoAPI()

        response = await api.get_contracts("7707083893")

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


class KeyboardTests(unittest.TestCase):
    def test_company_detail_keyboard_no_bank_button(self) -> None:
        from bot.keyboards import company_detail_keyboard

        markup = company_detail_keyboard("7707083893")
        labels = [btn.text for row in markup.inline_keyboard for btn in row]
        self.assertNotIn("🏦 Банки", labels)

    def test_company_detail_keyboard_has_fedresurs_button(self) -> None:
        from bot.keyboards import company_detail_keyboard

        markup = company_detail_keyboard("7707083893")
        labels = [btn.text for row in markup.inline_keyboard for btn in row]
        self.assertIn("📄 Федресурс", labels)


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


class FedresursFormatterTests(unittest.TestCase):
    def test_format_fedresurs_shows_messages(self) -> None:
        from bot.formatters import format_fedresurs

        payload = {
            "data": [
                {"type": "Уведомление о ликвидации", "date": "2024-03-01"},
            ]
        }

        text = format_fedresurs(payload)

        self.assertIn("Федресурс", text)
        self.assertIn("Уведомление о ликвидации", text)
        self.assertIn("2024-03-01", text)


class BankFormatterTests(unittest.TestCase):
    def test_format_bank_shows_info(self) -> None:
        from bot.formatters import format_bank

        payload = {
            "data": {
                "БИК": "044525225",
                "Наим": "ПАО Сбербанк",
                "Адрес": "г. Москва",
                "Тип": "Банк",
                "КорСчет": {"Номер": "30101810400000000225", "Дата": "2002-04-12"},
            }
        }

        text = format_bank(payload)

        self.assertIn("Банк", text)
        self.assertIn("ПАО Сбербанк", text)
        self.assertIn("044525225", text)
        self.assertIn("30101810400000000225", text)


if __name__ == "__main__":
    unittest.main()
