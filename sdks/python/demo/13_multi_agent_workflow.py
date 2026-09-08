#!/usr/bin/env python3
"""13. Multi-Agent Workflow — Native role-based agent collaboration without external frameworks.

Demonstrates replacing heavyweight third-party multi-agent frameworks (CrewAI, AutoGen)
with native nRouter SDK primitives:
  - Role-based separation: Researcher agent (tool calling) + Writer agent (synthesis)
  - Scoped conversation memory: Independent memory instances via create_memory()
  - Unified inference client: Both agents use one nRouter() client with zero OpenAI dependencies
  - Per-agent cost accounting: Tracking spend and token consumption per agent role via client.last_response

Prerequisites:
    pip install nrouter-sdk
    export NROUTER_API_KEY="sk-nrouter-..."

Usage:
    # Dry-run mode (default, in-process mock, no API key or network required):
    python 13_multi_agent_workflow.py --dry-run

    # Live mode (hits live nRouter gateway):
    export NROUTER_API_KEY="sk-nrouter-..."
    python 13_multi_agent_workflow.py --live
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from nroutersdk import nRouter, create_memory

MODEL = os.environ.get("NROUTER_MODEL", "gpt-5.4-mini")


# ━━━ 1. RESEARCH TOOLS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def lookup_database(query: str) -> str:
    """Mock research database retrieval."""
    facts = {
        "nrouter": "nRouter provides a unified API gateway across 6 provider clouds with zero-code guardrails and cost tracking.",
        "guardrails": "nRouter guardrails intercept PII and prompt injections server-side with zero per-request code.",
        "pricing": "nRouter records exact token and USD cost on response headers (x-nr-request-cost) with exact status.",
    }
    for key, val in facts.items():
        if key in query.lower():
            return json.dumps({"status": "found", "fact": val})
    return json.dumps({"status": "found", "fact": "Unified multi-cloud LLM routing with sub-millisecond overhead."})


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "lookup_database",
            "description": "Look up verified enterprise AI facts and benchmarks.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Subject or topic to research"},
                },
                "required": ["query"],
            },
        },
    }
]


# ━━━ 2. MOCK GATEWAY FOR DRY-RUN CERTIFICATION ━━━━━━━━━━━━

class _MockMultiAgentGateway(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        messages = body.get("messages", [])

        system_msg = messages[0].get("content", "") if messages else ""

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("x-nr-cost-status", "exact")

        if "Researcher" in system_msg:
            last_msg = messages[-1] if messages else {}
            if last_msg.get("role") == "tool":
                # Researcher final findings
                self.send_header("x-nr-request-id", "req-researcher-synthesis")
                self.send_header("x-nr-request-cost", "0.000350")
                self.send_header("x-nr-latency-ms", "110")
                self.end_headers()
                resp = {
                    "id": "chatcmpl-research-002",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": MODEL,
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "Key Finding: nRouter unifies 6 provider clouds with automatic server-side guardrails and exact USD cost tracking.",
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 95, "completion_tokens": 25, "total_tokens": 120},
                }
            else:
                # Researcher tool request
                self.send_header("x-nr-request-id", "req-researcher-tool")
                self.send_header("x-nr-request-cost", "0.000280")
                self.send_header("x-nr-latency-ms", "85")
                self.end_headers()
                resp = {
                    "id": "chatcmpl-research-001",
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
                                        "id": "call_db_001",
                                        "type": "function",
                                        "function": {
                                            "name": "lookup_database",
                                            "arguments": json.dumps({"query": "guardrails"}),
                                        },
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ],
                    "usage": {"prompt_tokens": 70, "completion_tokens": 20, "total_tokens": 90},
                }
        else:
            # Writer synthesis
            self.send_header("x-nr-request-id", "req-writer-briefing")
            self.send_header("x-nr-request-cost", "0.000520")
            self.send_header("x-nr-latency-ms", "165")
            self.end_headers()
            resp = {
                "id": "chatcmpl-writer-001",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": MODEL,
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "Executive Summary: Enterprise AI architectures require multi-provider resilience. nRouter delivers unified routing across six clouds, applying automated guardrails and real-time per-request spend accounting.",
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 140, "completion_tokens": 35, "total_tokens": 175},
            }

        self.wfile.write(json.dumps(resp).encode("utf-8"))


# ━━━ 3. MULTI-AGENT WORKFLOW RUNNER ━━━━━━━━━━━━━━━━━━━━━━━

async def run_multi_agent_workflow(client: nRouter, topic: str) -> None:
    print(f"\n[Multi-Agent Workflow Goal]: {topic}")
    spend_ledger: dict[str, float] = {}

    # ── Role 1: Researcher Agent ──────────────────────────────
    print("\n▶ Launching Role: Researcher Agent...")
    research_memory = create_memory()
    await research_memory.add({
        "role": "system",
        "content": "You are a Senior Technical Researcher. Gather factual information using the lookup tool.",
    })
    await research_memory.add({
        "role": "user",
        "content": f"Research key enterprise capabilities for: {topic}",
    })

    # Researcher Step 1: Query tool
    res1 = client.chat.completions.create(
        model=MODEL,
        messages=await research_memory.messages(),
        tools=TOOLS,
        tool_choice="auto",
    )
    meta1 = client.last_response
    spend_ledger["Researcher"] = (meta1.cost or 0.0) if meta1 else 0.0

    msg1 = res1.choices[0].message
    if msg1.tool_calls:
        tc = msg1.tool_calls[0]
        args = json.loads(tc.function.arguments)
        print(f"  Researcher executing tool: {tc.function.name}({args})")
        tool_out = lookup_database(**args)
        print(f"  Tool result: {tool_out}")

        await research_memory.add({
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": tc.id,
                    "type": tc.type,
                    "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                }
            ],
        })
        await research_memory.add({
            "role": "tool",
            "tool_call_id": tc.id,
            "content": tool_out,
        })

    # Researcher Step 2: Synthesize findings
    res2 = client.chat.completions.create(
        model=MODEL,
        messages=await research_memory.messages(),
    )
    meta2 = client.last_response
    if meta2 and meta2.cost:
        spend_ledger["Researcher"] += meta2.cost

    research_findings = res2.choices[0].message.content or ""
    print(f"  Researcher Report: {research_findings}")

    # ── Role 2: Writer Agent ──────────────────────────────────
    print("\n▶ Launching Role: Writer Agent...")
    writer_memory = create_memory()
    await writer_memory.add({
        "role": "system",
        "content": "You are an Executive Technical Writer. Transform technical research into an executive briefing.",
    })
    await writer_memory.add({
        "role": "user",
        "content": f"Format this research into an executive briefing:\n\n{research_findings}",
    })

    res_writer = client.chat.completions.create(
        model=MODEL,
        messages=await writer_memory.messages(),
    )
    meta_writer = client.last_response
    spend_ledger["Writer"] = (meta_writer.cost or 0.0) if meta_writer else 0.0

    final_briefing = res_writer.choices[0].message.content or ""
    print(f"\n[Final Executive Briefing]:\n{final_briefing}")

    # ── Multi-Agent Cost & Telemetry Accounting ───────────────
    print("\n━━━ Multi-Agent Spend Accounting (Zero Extra Overhead) ━━━")
    total_spend = sum(spend_ledger.values())
    for role, cost in spend_ledger.items():
        print(f"  • {role:<12}: ${cost:.6f}")
    print(f"  ------------------------")
    print(f"  • Total Workflow : ${total_spend:.6f}")


# ━━━ 4. MAIN ENTRYPOINT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async def main() -> None:
    mode = "live" if "--live" in sys.argv else "dry-run"
    print("=" * 70)
    print(f"nRouter SDK — Multi-Agent Workflow ({mode.upper()} mode)")
    print("=" * 70)

    server = None
    if mode == "dry-run":
        server = HTTPServer(("127.0.0.1", 0), _MockMultiAgentGateway)
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
        await run_multi_agent_workflow(client, "Enterprise Multi-Cloud LLM Routing & Guardrails")
        print("\n" + "=" * 70)
        print("MULTI-AGENT WORKFLOW PASSED (Zero-framework native agent execution)")
        print("=" * 70)
    finally:
        if server:
            server.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
