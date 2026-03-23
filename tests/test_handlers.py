"""Tests for handler bug fixes."""
import unittest
from unittest.mock import AsyncMock, MagicMock
from unittest.mock import patch

from bot.formatters import build_main_card
from bot.handlers.callbacks import _DETAIL_FETCHERS, build_connections_screen, calculate_risk_score, cb_company_nav, cb_detail
from bot.handlers.search import handle_name_input
from bot.keyboards import cancel_keyboard, company_detail_keyboard, main_menu_keyboard
from services.checko_api import CheckoAPI
from bot.formatters import build_main_card
from dadata import AffiliatedData, CompanyData


class EntrepreneurDetailFetcherTests(unittest.IsolatedAsyncioTestCase):
    """cb_detail must call get_entrepreneur for 12-digit INNs (section=company)."""

    def _make_api(self) -> CheckoAPI:
        api = MagicMock(spec=CheckoAPI)
        api.get_entrepreneur = AsyncMock(return_value={"data": {"fio": "Иванов И.И.", "inn": "123456789012"}})
        api.get_company = AsyncMock(return_value={"data": {}})
        return api

    def _make_call(self, callback_data: str) -> MagicMock:
        call = MagicMock()
        call.data = callback_data
        call.message = MagicMock()
        call.message.edit_text = AsyncMock()
        call.answer = AsyncMock()
        return call

    async def test_detail_company_12digit_uses_get_entrepreneur(self) -> None:
        """For a 12-digit INN, 'company' detail section should call get_entrepreneur."""
        api = self._make_api()
        call = self._make_call("detail:123456789012:company")

        await cb_detail(call, api)

        api.get_entrepreneur.assert_called_once_with(inn="123456789012")
        api.get_company.assert_not_called()

    async def test_detail_company_10digit_uses_get_company(self) -> None:
        """For a 10-digit INN, 'company' detail section should call get_company."""
        api = self._make_api()
        call = self._make_call("detail:7707083893:company")

        await cb_detail(call, api)

        api.get_company.assert_called_once_with(inn="7707083893")
        api.get_entrepreneur.assert_not_called()


class PersonKeyboardTests(unittest.TestCase):
    """Person results should use cancel_keyboard (no sub-sections)."""

    def test_cancel_keyboard_has_no_company_detail_callback(self) -> None:
        markup = cancel_keyboard()
        callbacks_data = [
            btn.callback_data
            for row in markup.inline_keyboard
            for btn in row
        ]
        self.assertFalse(
            any(cb.startswith("detail:") for cb in callbacks_data if cb),
            "cancel_keyboard must not contain detail: callbacks",
        )

    def test_company_detail_keyboard_has_company_section(self) -> None:
        markup = company_detail_keyboard("7707083893")
        callbacks_data = [
            btn.callback_data
            for row in markup.inline_keyboard
            for btn in row
            if btn.callback_data
        ]
        self.assertIn("co:main:7707083893", callbacks_data)
        self.assertNotIn("co:succ:7707083893", callbacks_data)
        self.assertTrue(
            any(btn.url == "https://egrul.nalog.ru/" for row in markup.inline_keyboard for btn in row),
            "company keyboard must contain the FNS history URL button",
        )


    def test_main_menu_contains_expected_actions(self) -> None:
        markup = main_menu_keyboard()
        labels = [btn.text for row in markup.inline_keyboard for btn in row]

        self.assertIn("🔎 По ИНН / ОГРН", labels)
        self.assertIn("🧾 По названию", labels)
        self.assertIn("🏦 По БИК", labels)
        self.assertIn("✉️ По Email", labels)
        self.assertIn("ℹ️ Помощь", labels)

    def test_detail_fetchers_map_does_not_have_person_key(self) -> None:
        """Persons have no API sub-sections; the detail fetchers map must not include 'person'."""
        self.assertNotIn("person", _DETAIL_FETCHERS)


if __name__ == "__main__":
    unittest.main()


class CemeteryRiskTests(unittest.IsolatedAsyncioTestCase):
    async def test_calculate_risk_score_uses_counts_formula(self) -> None:
        api = MagicMock(spec=CheckoAPI)
        api.get_arbitration = AsyncMock(return_value={"data": {"cases": [{}, {}]}})
        api.get_enforcements = AsyncMock(return_value={"data": {"items": [{}]}})
        api.get_bankruptcy = AsyncMock(return_value={"data": {"messages": [{}, {}, {}]}})

        score, label = await calculate_risk_score(api, "7707083893")

        self.assertEqual(score, 2 * 4 + 1 * 6 + 3 * 10)
        self.assertEqual(label, "🔴 Высокий риск")


class DadataHandlersTests(unittest.IsolatedAsyncioTestCase):
    def _make_message(self, text: str) -> MagicMock:
        message = MagicMock()
        message.text = text
        message.answer = AsyncMock()
        message.from_user = MagicMock(id=77)
        return message

    async def test_handle_name_input_uses_dadata_email_lookup(self) -> None:
        state = MagicMock()
        state.clear = AsyncMock()
        db = MagicMock()
        db.add_search = AsyncMock()
        api = MagicMock(spec=CheckoAPI)
        api.search = AsyncMock()
        message = self._make_message("info@example.com")

        company = CompanyData(
            inn="7707083893",
            name="ООО Ромашка",
            ogrn="1027700132195",
            address="г. Москва, ул. Тверская, д. 1",
            status="Действует",
            manager="Иванов И.И.",
            okved="62.01 — Разработка программного обеспечения",
        )

        with patch("bot.handlers.search.get_company_by_email", AsyncMock(return_value=company)):
            await handle_name_input(message, state, db, api)

        api.search.assert_not_called()
        state.clear.assert_awaited_once()
        db.add_search.assert_awaited_once_with(user_id=77, query="info@example.com")
        message.answer.assert_any_await(unittest.mock.ANY)
        _, kwargs = message.answer.await_args_list[-1]
        self.assertEqual(kwargs["reply_markup"].inline_keyboard[0][0].callback_data, "co:main:7707083893")

    def test_build_main_card_formats_compact_dadata_screen(self) -> None:
        company = CompanyData(
            inn="7707083893",
            name="ООО Ромашка",
            ogrn="1027700132195",
            address="г. Москва, ул. Тверская, д. 1",
            status="ACTIVE",
            manager="Иванов И.И.",
            okved="62.01",
            email="info@example.com",
        )

        card = build_main_card(company)

        self.assertIn("🏢 <b>ООО Ромашка</b>", card)
        self.assertIn("🟢 Действующая", card)
        self.assertIn("• ИНН: <code>7707083893</code>", card)
        self.assertIn("• ОГРН: <code>1027700132195</code>", card)
        self.assertIn("• ОКВЭД: 62.01", card)
        self.assertIn("• г. Москва, ул. Тверская, д. 1", card)
        self.assertIn("• Email: info@example.com", card)

    async def test_company_nav_links_uses_dadata_affiliations(self) -> None:
        call = MagicMock()
        call.message = MagicMock()
        call.message.edit_text = AsyncMock()
        call.answer = AsyncMock()
        callback_data = MagicMock(sec="lnk", ident="7707083893")
        api = MagicMock(spec=CheckoAPI)

        affiliations = [
            AffiliatedData(inn="1234567890", name="ООО Ромашка", type="Дочерняя компания"),
            AffiliatedData(inn="0987654321", name="Иванов Иван Иванович", type="Руководитель"),
        ]

        with patch("bot.handlers.callbacks.get_affiliated", AsyncMock(return_value=affiliations)):
            await cb_company_nav(call, callback_data, api)

        call.answer.assert_awaited()
        final_text = call.message.edit_text.await_args_list[-1].args[0]
        self.assertIn("Связанные лица и компании", final_text)
        self.assertIn("ООО Ромашка", final_text)
        self.assertIn("Дочерняя компания", final_text)
        self.assertIn("Иванов Иван Иванович", final_text)

    async def test_build_connections_screen_trims_long_affiliation_list(self) -> None:
        affiliations = [
            AffiliatedData(inn=f"7707083{i:03d}", name=f"Компания {i}", type="Связанная компания")
            for i in range(20)
        ]

        with patch("bot.handlers.callbacks.get_affiliated", AsyncMock(return_value=affiliations)):
            text = await build_connections_screen("7707083893")

        self.assertIn("Показаны основные связи", text)
        self.assertEqual(text.count("• <b>Компания"), 15)


class DadataMainCardFormatterTests(unittest.TestCase):
    def test_build_main_card_formats_structured_company_view(self) -> None:
        company = CompanyData(
            inn="7707083893",
            name="ООО Ромашка",
            ogrn="1027700132195",
            address="г. Москва, ул. Тверская, д. 1",
            status="ACTIVE",
            manager="Иванов И.И.",
            okved="62.01",
            email="info@example.com",
        )

        text = build_main_card(company)

        self.assertIn("🏢 <b>ООО Ромашка</b>", text)
        self.assertIn("🟢 Действующая", text)
        self.assertIn("• ИНН: <code>7707083893</code>", text)
        self.assertIn("• ОГРН: <code>1027700132195</code>", text)
        self.assertIn("• ОКВЭД: 62.01", text)
        self.assertIn("• Иванов И.И.", text)
        self.assertIn("• Email: info@example.com", text)
        self.assertIn("• г. Москва, ул. Тверская, д. 1", text)
