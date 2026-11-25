"""BYOK Header & Error Inspection Example.

Demonstrates:
1. Calling a BYOK-eligible model (OpenAI, Anthropic, Azure, DeepInfra, Meta, or Alibaba)
   with a standard virtual key (sk-nrouter-...)
2. Inspecting `funding_source`, `cost_status`, `cost`, and `byok_fallback`
   (`credential_rejected`, `permission_denied`, `rate_limited`, `overloaded`,
   `connect_refused`, or `plan_inactive`) on `client.last_response`
3. Handling all four public BYOK inference error codes (`byok_plan_required`,
   `byok_fair_use_exceeded`, `byok_credential_rejected`,
   `byok_credential_unavailable`)

Usage:
    export NROUTER_API_KEY="sk-nrouter-your-key-here"
    python examples/byok_inspection.py
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdks", "python"))

from nroutersdk import (
    nRouter,
    nRouterAuthenticationError,
    nRouterCreditError,
    nRouterError,
    nRouterRateLimitError,
)


def main() -> None:
    api_key = os.environ.get("NROUTER_API_KEY")
    if not api_key:
        print("Set NROUTER_API_KEY='sk-nrouter-...' to run against the live gateway.")
        return

    with nRouter(
        api_key=api_key,
        base_url=os.environ.get("NROUTER_BASE_URL", "https://api.nrouter.ai/v1"),
    ) as client:
        try:
            response = client.chat.completions.create(
                model=os.environ.get("NROUTER_MODEL", "openai/gpt-4.1-mini"),
                messages=[{"role": "user", "content": "Reply with OK."}],
                max_tokens=16,
            )
            print("Assistant:", response.choices[0].message.content or "")

            meta = client.last_response
            if meta is not None:
                print(f"Request ID:     {meta.request_id}")
                print(f"Funding Source: {meta.funding_source}")
                print(f"Cost Status:    {meta.cost_status}")
                if meta.funding_source == "byok":
                    # Pure BYOK call: provider billed your saved key directly; cost is None.
                    print("Settled Spend:  billed directly to saved provider key ($0 nRouter credits)")
                elif meta.byok_fallback is not None:
                    # Credit fallback served the request (e.g. plan_inactive or rate_limited).
                    if meta.is_priced and meta.cost is not None:
                        print(
                            f"BYOK Fallback:  {meta.byok_fallback} -> "
                            f"settled ${meta.cost:.6f} USD from prepaid credits"
                        )
                    else:
                        print(
                            f"BYOK Fallback:  {meta.byok_fallback} -> "
                            f"served on prepaid credits (cost_status={meta.cost_status})"
                        )
                elif meta.is_priced and meta.cost is not None:
                    print(f"Settled Spend:  ${meta.cost:.6f} USD")

        except nRouterCreditError as err:
            if err.code == "byok_plan_required":
                print(f"[402 byok_plan_required] Subscribe or renew the BYOK plan: {err.message}")
            else:
                print(f"[402 {err.code}] Credit refusal: {err.message}")
        except nRouterRateLimitError as err:
            if err.code == "byok_fair_use_exceeded":
                print(
                    f"[429 byok_fair_use_exceeded] Monthly BYOK token fair-use reached "
                    f"(limit_source={err.limit_source}, retry_after={err.retry_after}s)"
                )
            else:
                print(f"[429 {err.code}] Rate limit: {err.message}")
        except nRouterAuthenticationError as err:
            if err.code == "byok_credential_rejected":
                print(f"[401 byok_credential_rejected] Replace saved provider key: {err.message}")
            else:
                print(f"[401 {err.code}] Virtual key refused ({err.auth_reason}): {err.message}")
        except nRouterError as err:
            if err.code == "byok_credential_unavailable":
                print(f"[409 byok_credential_unavailable] Saved key disabled or unavailable: {err.message}")
            else:
                print(f"[{err.status_code} {err.code}] Gateway error: {err.message}")


if __name__ == "__main__":
    main()
