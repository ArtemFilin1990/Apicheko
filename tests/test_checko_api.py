import unittest

from bot.formatters import format_history
from services.checko_api import CheckoAPI


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
        await api.get_entrepreneur(inn="770708389312")
        await api.get_person(inn="123456789012")

        self.assertEqual(
            api.calls[:3],
            [
                ("company", {"inn": "7707083893"}),
                ("entrepreneur", {"inn": "770708389312"}),
                ("person", {"inn": "123456789012"}),
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
    def test_company_detail_keyboard_no_bank_button(self) -> None:
        from bot.keyboards import company_detail_keyboard

        markup = company_detail_keyboard("7707083893")
        callbacks = [btn.callback_data for row in markup.inline_keyboard for btn in row]
        self.assertNotIn("detail:7707083893:bank", callbacks)

    def test_company_detail_keyboard_has_new_company_nav_buttons(self) -> None:
        from bot.keyboards import company_detail_keyboard

        markup = company_detail_keyboard("7707083893")
        callbacks = [btn.callback_data for row in markup.inline_keyboard for btn in row]
        self.assertIn("co:main:7707083893", callbacks)
        self.assertIn("co:tax:7707083893", callbacks)
        self.assertIn("menu", callbacks)


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


class CompanyFormatterTests(unittest.TestCase):
    def test_format_company_handles_array_phone_and_email(self) -> None:
        from bot.formatters import format_company

        payload = {
            "data": {
                "НаимПолн": "ООО Тест",
                "ИНН": "7707083893",
                "ОГРН": "1027700132195",
                "Контакты": {
                    "Тел": ["+79001234567", "+79007654321"],
                    "Емэйл": ["info@test.ru", "support@test.ru"],
                },
            }
        }

        text = format_company(payload)

        self.assertIn("+79001234567", text)
        self.assertIn("+79007654321", text)
        self.assertIn("info@test.ru", text)
        self.assertIn("support@test.ru", text)
        # Must not contain Python list representation
        self.assertNotIn("[", text)
        self.assertNotIn("]", text)

    def test_format_company_handles_scalar_phone(self) -> None:
        from bot.formatters import format_company

        payload = {
            "data": {
                "НаимПолн": "ООО Тест",
                "ИНН": "7707083893",
                "Контакты": {
                    "Тел": "+79001234567",
                },
            }
        }

        text = format_company(payload)

        self.assertIn("+79001234567", text)


class IdentifierParamsTests(unittest.TestCase):
    def test_10_digit_returns_inn(self) -> None:
        from bot.cards import _identifier_params

        self.assertEqual(_identifier_params("7707083893"), {"inn": "7707083893"})

    def test_13_digit_returns_ogrn(self) -> None:
        from bot.cards import _identifier_params

        self.assertEqual(_identifier_params("1027700132195"), {"ogrn": "1027700132195"})

    def test_15_digit_returns_ogrnip(self) -> None:
        from bot.cards import _identifier_params

        self.assertEqual(_identifier_params("304500116000157"), {"ogrnip": "304500116000157"})

    def test_12_digit_returns_inn(self) -> None:
        from bot.cards import _identifier_params

        self.assertEqual(_identifier_params("123456789012"), {"inn": "123456789012"})


class SearchIdentifierRegexTests(unittest.TestCase):
    def test_accepts_9_digit_bic(self) -> None:
        from bot.handlers.search import IDENTIFIER_RE

        self.assertIsNotNone(IDENTIFIER_RE.match("044525225"))

    def test_accepts_10_digit_inn(self) -> None:
        from bot.handlers.search import IDENTIFIER_RE

        self.assertIsNotNone(IDENTIFIER_RE.match("7707083893"))

    def test_rejects_8_digits(self) -> None:
        from bot.handlers.search import IDENTIFIER_RE

        self.assertIsNone(IDENTIFIER_RE.match("12345678"))

    def test_rejects_11_digits(self) -> None:
        from bot.handlers.search import IDENTIFIER_RE

        self.assertIsNone(IDENTIFIER_RE.match("12345678901"))


if __name__ == "__main__":
    unittest.main()


class CheckoAPIDetailEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_documented_finance_history_fedresurs_endpoints(self) -> None:
        api = _FakeCheckoAPI()

        await api.get_financial(inn="7707083893")
        await api.get_history(inn="7707083893")
        await api.get_fedresurs(inn="7707083893")

        self.assertEqual(
            api.calls,
            [
                ("finance", {"inn": "7707083893"}),
                ("history", {"inn": "7707083893"}),
                ("fedresurs-messages", {"inn": "7707083893"}),
            ],
        )
