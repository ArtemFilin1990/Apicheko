#!/usr/bin/env python
"""Verify Cloudflare tokens and run a narrow Workers AI smoke test."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

API_BASE = "https://api.cloudflare.com/client/v4"


def load_token(token_env: str) -> str:
    token = os.getenv(token_env)
    if not token:
        raise SystemExit(f"Environment variable {token_env} is not set.")
    return token


def load_account_id(explicit: str | None, account_env: str) -> str:
    if explicit:
        return explicit
    account_id = os.getenv(account_env)
    if not account_id:
        raise SystemExit(
            f"Account ID is required. Pass --account-id or set {account_env}."
        )
    return account_id


def request_json(url: str, token: str, payload: dict | None, timeout: int) -> dict:
    data = None
    headers = {"Authorization": f"Bearer {token}"}

    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url=url, data=data, headers=headers)

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"success": False, "http_status": exc.code, "body": body}
        print(json.dumps(parsed, indent=2, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(exc.code) from exc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Verify Cloudflare API tokens and run a Workers AI REST smoke test."
    )
    parser.add_argument(
        "--token-env",
        default="CLOUDFLARE_API_TOKEN",
        help="Environment variable containing the API token.",
    )
    parser.add_argument(
        "--account-env",
        default="CLOUDFLARE_ACCOUNT_ID",
        help="Environment variable containing the account ID.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="HTTP timeout in seconds.",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    verify_account = subparsers.add_parser(
        "verify-account", help="Verify an account-owned API token."
    )
    verify_account.add_argument(
        "--account-id",
        help="Cloudflare account ID. Falls back to --account-env.",
    )

    subparsers.add_parser("verify-user", help="Verify a user-owned API token.")

    run = subparsers.add_parser(
        "run", help="Run a minimal Workers AI REST API smoke test."
    )
    run.add_argument(
        "--account-id",
        help="Cloudflare account ID. Falls back to --account-env.",
    )
    run.add_argument(
        "--model",
        required=True,
        help="Workers AI model ID, for example @cf/meta/llama-3.1-8b-instruct.",
    )
    run_group = run.add_mutually_exclusive_group(required=True)
    run_group.add_argument(
        "--prompt",
        help="Prompt text. Encoded as {\"prompt\": ...}.",
    )
    run_group.add_argument(
        "--input-json",
        help="Raw JSON request body for models that do not use a prompt field.",
    )

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    token = load_token(args.token_env)

    if args.command == "verify-account":
        account_id = load_account_id(args.account_id, args.account_env)
        url = f"{API_BASE}/accounts/{account_id}/tokens/verify"
        result = request_json(url, token, payload=None, timeout=args.timeout)
    elif args.command == "verify-user":
        url = f"{API_BASE}/user/tokens/verify"
        result = request_json(url, token, payload=None, timeout=args.timeout)
    else:
        account_id = load_account_id(args.account_id, args.account_env)
        if args.prompt is not None:
            payload = {"prompt": args.prompt}
        else:
            try:
                payload = json.loads(args.input_json)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"--input-json is not valid JSON: {exc}") from exc

        url = f"{API_BASE}/accounts/{account_id}/ai/run/{args.model}"
        result = request_json(url, token, payload=payload, timeout=args.timeout)

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
