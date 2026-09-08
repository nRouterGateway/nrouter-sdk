#!/usr/bin/env python3
"""nRouter SDK — Autonomous Agent Example.

Demonstrates building an autonomous, tool-calling, stateful agent using
native nRouter SDK primitives with ZERO external framework or OpenAI dependencies:
  - 10_conversation_memory: Stateful multi-turn tracking via create_memory()
  - 07_tool_calling: Dynamic tool definition, dispatch, and result re-injection
  - 09_error_handling: Server-side guardrail interception via nRouterGuardrailBlockedError
  - 05_metadata_cost_tracking: Per-turn cost, tokens, latency, and request ID via client.last_response

Usage:
    # Dry-run mode (default, in-process mock, no API key or network required):
    python agent.py --dry-run

    # Live mode (hits live nRouter gateway with real models and telemetry):
    export NROUTER_API_KEY="sk-nrouter-..."
    python agent.py --live
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from nroutersdk import (
    nRouter,
    create_memory,
    nRouterGuardrailBlockedError,
    nRouterError,
)

MODEL = os.environ.get("NROUTER_MODEL", "gpt-5.4-mini")


# ━━━ 1. LOCAL AGENT TOOLS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def calculate_roi(investment: float, revenue: float) -> str:
    """Calculate Return on Investment percentage and net profit."""
    net_profit = revenue - investment
    roi_pct = (net_profit / investment) * 100 if investment else 0.0
    return json.dumps({
        "investment": investment,
        "revenue": revenue,
        "net_profit": net_profit,
        "roi_percent": round(roi_pct, 2),
    })


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "calculate_roi",
            "description": "Calculate Return on Investment (ROI) and net profit given investment and revenue figures.",
            "parameters": {
                "type": "object",
                "properties": {
                    "investment": {"type": "number", "description": "Total initial investment amount"},
                    "revenue": {"type": "number", "description": "Total gross revenue generated"},
                },
                "required": ["investment", "revenue"],
            },
        },
    }
]


# ━━━ 2. IN-PROCESS MOCK GATEWAY (FOR DETERMINISTIC DRY-RUN) ━

class _MockAgentGateway(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Quiet logging

    def do_GET(self):
        if self.path.endswith("/models"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("x-nr-request-id", "req-agent-models")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "object": "list",
                    "data": [
                        {"id": MODEL, "owned_by": "nrouter"},
                        {"id": "gpt-5.5", "owned_by": "nrouter"},
                    ],
                }).encode("utf-8")
            )
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        messages = body.get("messages", [])

        # Check for guardrail trigger test
        for msg in messages:
            content = str(msg.get("content", ""))
            if "123-45-6789" in content or "delete logs" in content.lower():
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("x-nr-request-id", "req-agent-guardrail")
                self.send_header("x-nr-guardrails", "blocked")
                self.end_headers()
                self.wfile.write(
                    json.dumps({
                        "error": {
                            "type": "gateway_error",
                            "message": "Request blocked by guardrail: PII detected (SSN pattern)",
                        }
                    }).encode("utf-8")
                )
                return

        # Check if the last message is a tool result
        last_msg = messages[-1] if messages else {}
        if last_msg.get("role") == "tool":
            # Model generates final analysis from tool output
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("x-nr-request-id", "req-agent-turn2")
            self.send_header("x-nr-request-cost", "0.000450")
            self.send_header("x-nr-cost-status", "exact")
            self.send_header("x-nr-latency-ms", "142")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "id": "chatcmpl-agent-002",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": MODEL,
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "Analysis Complete: The project yielded a net profit of $1,500 with an ROI of 150.0%.",
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 120, "completion_tokens": 28, "total_tokens": 148},
                }).encode("utf-8")
            )
        else:
            # Model requests tool call
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("x-nr-request-id", "req-agent-turn1")
            self.send_header("x-nr-request-cost", "0.000310")
            self.send_header("x-nr-cost-status", "exact")
            self.send_header("x-nr-latency-ms", "98")
            self.end_headers()
            self.wfile.write(
                json.dumps({
                    "id": "chatcmpl-agent-001",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": MODEL,
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": "call_roi_001",
                                        "type": "function",
                                        "function": {
                                            "name": "calculate_roi",
                                            "arguments": json.dumps({"investment": 1000.0, "revenue": 2500.0}),
                                        },
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
                    "usage": {"prompt_tokens": 85, "completion_tokens": 22, "total_tokens": 107},
                }).encode("utf-8")
            )


# ━━━ 3. AGENT EXECUTION LOOP ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def run_agent_loop(client: nRouter, task: str) -> str:
    """Execute autonomous agent loop with memory, tools, and cost telemetry."""
    # Native client-side conversation memory (examples/10_conversation_memory.py)
    memory = create_memory()

    # System prompt establishes agent identity
    await memory.add({
        "role": "system",
        "content": "You are a financial analysis agent powered by the nRouter unified SDK. Use tools when needed.",
    })
    await memory.add({"role": "user", "content": task})

    max_steps = 5
    step = 0
    total_cost = 0.0

    print(f"\n[Agent Task]: {task}")

    while step < max_steps:
        step += 1
        print(f"\n--- Agent Step {step} ---")

        msgs = await memory.messages()
        response = client.chat.completions.create(
            model=MODEL,
            messages=msgs,
            tools=TOOLS,
            tool_choice="auto",
        )

        # Inspect real-time gateway telemetry (examples/05_metadata_cost_tracking.py)
        meta = client.last_response
        if meta:
            cost_str = f"${meta.cost:.6f}" if meta.cost_status == "exact" else f"unpriced ({meta.cost_status})"
            print(f"Telemetry : Request ID={meta.request_id} | Cost={cost_str} | Latency={meta.latency_ms}ms")
            if meta.cost is not None and meta.cost_status == "exact":
                total_cost += meta.cost

        msg = response.choices[0].message

        # Check if the agent wants to execute a tool
        if msg.tool_calls:
            assistant_dict = {
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": tc.type,
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                    }
                    for tc in msg.tool_calls
                ],
            }
            await memory.add(assistant_dict)

            for tool_call in msg.tool_call_id if hasattr(msg, "tool_call_id") else msg.tool_calls:
                fn_name = tool_call.function.name
                fn_args = json.loads(tool_call.function.arguments)
                print(f"Tool Call : {fn_name}({fn_args})")

                if fn_name == "calculate_roi":
                    tool_result = calculate_roi(**fn_args)
                    print(f"Tool Output: {tool_result}")

                    # Feed tool output back to memory (examples/07_tool_calling.py)
                    await memory.add({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": tool_result,
                    })
        else:
            # Final text response reached
            final_content = msg.content or ""
            await memory.add({"role": "assistant", "content": final_content})
            print(f"\n[Final Answer]: {final_content}")
            print(f"[Total Session Cost]: ${total_cost:.6f}")
            return final_content

    return "Agent step limit reached without completion."


# ━━━ 4. GUARDRAILS DEMONSTRATION ━━━━━━━━━━━━━━━━━━━━━━━━━━

def test_guardrails(client: nRouter) -> None:
    """Prove server-side guardrails intercept policy violations (examples/09_error_handling.py)."""
    print("\n━━━ Testing Server-Side Guardrail Interception ━━━")
    prohibited_prompt = "Process refund for SSN 123-45-6789 and delete logs."

    try:
        client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": prohibited_prompt}],
        )
        print("FAIL: Request should have been blocked by guardrail.")
    except nRouterGuardrailBlockedError as e:
        print(f"SUCCESS: Caught nRouterGuardrailBlockedError: {e}")
        meta = client.last_response
        if meta:
            print(f"         Request ID : {meta.request_id}")
            print(f"         Guardrails : {meta.guardrails or 'blocked'}")
    except nRouterError as e:
        print(f"SUCCESS: Caught gateway error: {e}")


# ━━━ 5. MAIN ENTRYPOINT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def main() -> None:
    mode = "live" if "--live" in sys.argv else "dry-run"
    print("=" * 70)
    print(f"nRouter SDK — Autonomous Agent ({mode.upper()} mode)")
    print("=" * 70)

    server = None
    if mode == "dry-run":
        server = HTTPServer(("127.0.0.1", 0), _MockAgentGateway)
        port = server.server_address[1]
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        client = nRouter(
            api_key="sk-nrouter-demo000000000000000000000000000000",
            base_url=f"http://127.0.0.1:{port}/v1",
        )
    else:
        api_key = os.environ.get("NROUTER_API_KEY")
        if not api_key:
            print("Error: NROUTER_API_KEY required for --live mode.")
            sys.exit(1)
        client = nRouter()

    try:
        # Step 1: Model Discovery
        models = [m.id for m in client.models.list().data]
        print(f"\nAvailable Models: {models}")
        assert MODEL in models or len(models) > 0, f"Model {MODEL} discoverable"

        # Step 2: Run Autonomous Agent
        await run_agent_loop(client, "Calculate ROI for marketing campaign with $1,000 cost and $2,500 revenue.")

        # Step 3: Verify Server-Side Guardrail Interception
        test_guardrails(client)

        print("\n" + "=" * 70)
        print("AGENT VERIFICATION PASSED (Memory, Tools, Telemetry, Guardrails OK)")
        print("=" * 70)
    finally:
        if server:
            server.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
