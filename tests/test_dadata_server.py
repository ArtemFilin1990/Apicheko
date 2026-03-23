import unittest

from dadata_server import (
    build_bitrix_fields,
    build_raw_hash,
    enrich_company_for_bitrix_payload,
    normalize_party,
    validate_company_query,
)


class ValidateCompanyQueryTests(unittest.TestCase):
    def test_accepts_10_digit_inn(self) -> None:
        self.assertEqual(validate_company_query("7707083893"), "7707083893")

    def test_accepts_13_digit_ogrn(self) -> None:
        self.assertEqual(validate_company_query("1027700132195"), "1027700132195")

    def test_rejects_empty_value(self) -> None:
        with self.assertRaisesRegex(ValueError, "empty query"):
            validate_company_query(" ")

    def test_rejects_non_digit_value(self) -> None:
        with self.assertRaisesRegex(ValueError, "digits only"):
            validate_company_query("77A7083893")


class NormalizePartyTests(unittest.TestCase):
    def test_maps_key_fields(self) -> None:
        normalized = normalize_party(
            {
                "data": {
                    "inn": "7707083893",
                    "kpp": "770701001",
                    "ogrn": "1027700132195",
                    "okved": "62.01",
                    "name": {
                        "full_with_opf": "Общество с ограниченной ответственностью Тест",
                        "short_with_opf": "ООО Тест",
                    },
                    "opf": {"code": "12300", "full": "Общество с ограниченной ответственностью", "short": "ООО"},
                    "management": {"name": "Иванов И.И.", "post": "Генеральный директор"},
                    "state": {"status": "ACTIVE", "registration_date": 1262304000000, "actuality_date": 1704067200000},
                    "address": {
                        "value": "г Москва, ул Тверская",
                        "data": {"postal_code": "125009", "region_with_type": "г Москва", "city_with_type": "г Москва"},
                    },
                }
            }
        )

        self.assertEqual(normalized["short_name"], "ООО Тест")
        self.assertEqual(normalized["opf_short"], "ООО")
        self.assertEqual(normalized["ceo_post"], "Генеральный директор")
        self.assertEqual(normalized["postal_code"], "125009")


class HashAndBitrixMappingTests(unittest.IsolatedAsyncioTestCase):
    async def test_bitrix_payload_returns_expected_fields(self) -> None:
        import dadata_server

        async def fake_enrich_company_payload(query: str):
            return {
                "status": "synced",
                "query": query,
                "source": "DaData/findById/party",
                "raw_hash": "hash",
                "fields": {
                    "full_name": "Общество с ограниченной ответственностью Тест",
                    "short_name": "ООО Тест",
                    "inn": "7707083893",
                    "kpp": "770701001",
                    "ogrn": "1027700132195",
                    "okved": "62.01",
                    "ceo_name": "Иванов И.И.",
                    "ceo_post": "Генеральный директор",
                    "status": "ACTIVE",
                    "address_full": "г Москва, ул Тверская",
                },
                "raw": {"data": {"inn": "7707083893"}},
            }

        original = dadata_server.enrich_company_payload
        dadata_server.enrich_company_payload = fake_enrich_company_payload
        try:
            payload = await enrich_company_for_bitrix_payload("7707083893")
        finally:
            dadata_server.enrich_company_payload = original

        self.assertEqual(payload["status"], "synced")
        self.assertEqual(payload["bitrix_fields"]["UF_CRM_DD_INN"], "7707083893")
        self.assertEqual(payload["bitrix_fields"]["UF_CRM_DD_FULLNM"], "Общество с ограниченной ответственностью Тест")
        self.assertEqual(payload["raw_hash"], "hash")

    def test_build_raw_hash_is_stable(self) -> None:
        first = build_raw_hash({"b": 2, "a": 1})
        second = build_raw_hash({"a": 1, "b": 2})

        self.assertEqual(first, second)

    def test_build_bitrix_fields_skips_none_values(self) -> None:
        fields = build_bitrix_fields({"inn": "7707083893", "kpp": None, "full_name": "ООО Тест"})

        self.assertEqual(fields, {"UF_CRM_DD_FULLNM": "ООО Тест", "UF_CRM_DD_INN": "7707083893"})


if __name__ == "__main__":
    unittest.main()
