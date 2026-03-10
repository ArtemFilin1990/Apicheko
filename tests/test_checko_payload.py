import unittest

from utils.checko_payload import extract_data, extract_items, extract_search_results


class CheckoPayloadTests(unittest.TestCase):
    def test_extract_data_supports_nested_payload_data(self) -> None:
        payload = {"payload": {"data": {"ИНН": "7707083893"}}}

        self.assertEqual(extract_data(payload), {"ИНН": "7707083893"})

    def test_extract_items_supports_russian_keys(self) -> None:
        payload = {"data": {"Сообщения": [{"Тип": "notice"}]}}

        self.assertEqual(extract_items(payload), [{"Тип": "notice"}])

    def test_extract_search_results_supports_russian_keys(self) -> None:
        payload = {"data": {"Результаты": [{"ИНН": "7707083893"}]}}

        self.assertEqual(extract_search_results(payload), [{"ИНН": "7707083893"}])


if __name__ == "__main__":
    unittest.main()
