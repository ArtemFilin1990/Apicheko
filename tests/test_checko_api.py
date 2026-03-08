import unittest

from bot.checko_api import CheckoAPI


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

        self.assertEqual(api.calls[0][0], "legal-cases")
        self.assertEqual(api.calls[1][0], "bankruptcy-messages")
        self.assertEqual(api.calls[2][0], "finances")
        self.assertEqual(api.calls[3][0], "timeline")

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


if __name__ == "__main__":
    unittest.main()
