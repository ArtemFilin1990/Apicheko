"""Tests for handler bug fixes."""
import unittest
from unittest.mock import AsyncMock, MagicMock

from bot.handlers.callbacks import _DETAIL_FETCHERS, calculate_risk_score, cb_detail
from bot.keyboards import cancel_keyboard, company_detail_keyboard, main_menu_keyboard
from services.checko_api import CheckoAPI


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
        ]
        self.assertIn("detail:7707083893:company", callbacks_data)


    def test_main_menu_contains_expected_actions(self) -> None:
        markup = main_menu_keyboard()
        labels = [btn.text for row in markup.inline_keyboard for btn in row]

        self.assertIn("🔎 Поиск по ИНН", labels)
        self.assertIn("🧾 Поиск по названию", labels)
        self.assertIn("📋 История запросов", labels)
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
