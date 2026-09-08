# nRouter — AutoGen (Microsoft) Integration
# Multi-agent conversations with guardrails on every message.
#
# NOTE: For conversational and collaborative agents built natively with zero
# framework overhead, direct telemetry (client.last_response), and no OpenAI wrapper,
# see the native SDK agent examples:
#   - `sdks/python/demo/agent.py`: Autonomous agent with tools and memory.
#   - `sdks/python/demo/13_multi_agent_workflow.py`: Role-based multi-agent collaboration.
#
# pip install autogen-agentchat autogen-ext[openai] nroutersdk

import asyncio
import os
from nroutersdk import nRouter
from autogen_agentchat.agents import AssistantAgent
from autogen_ext.models.openai import OpenAIChatCompletionClient

NROUTER_BASE = "https://api.nrouter.ai"
NROUTER_KEY = os.environ["NROUTER_API_KEY"]

# nRouter SDK for guardrails, credits, prompts.
client = nRouter()  # reads NROUTER_API_KEY from env
MODEL = "gpt-5.4-mini"

# ━━━ 1. SEE WHAT THIS KEY CAN REACH ━━━━━━━━━━━━━━━━━━━━━━━

# Scoped to your key: exactly the models you may call.
print("Models:", [m.id for m in client.models.list().data])

# Guardrails, prompt templates and budgets are configured in the dashboard and
# applied server-side to every request. There is deliberately no client call to
# list or override them — a request cannot opt out of its own org's policy.

# ━━━ 2. MODERN MODEL CLIENT (Microsoft AutoGen v0.4+) ━━━━━

async def main():
    model_client = OpenAIChatCompletionClient(
        model=MODEL,
        base_url=f"{NROUTER_BASE}/v1",
        api_key=NROUTER_KEY,
        model_info={
            "vision": False,
            "function_calling": True,
            "json_output": True,
            "family": "unknown",
            "max_tokens": 1024,
        },
    )

    # ━━━ 3. AGENTS WITH SERVER-SIDE GUARDRAIL PROTECTION ━━━━━━━

    assistant = AssistantAgent(
        name="coding_assistant",
        model_client=model_client,
        system_message="You are an enterprise AI coding specialist.",
    )

    # Every message between agents is checked by guardrails.
    # Cache, guardrails, and rate limits auto-apply from org config.
    # PII in agent conversations → blocked.
    # Prompt injection in agent prompts → blocked.

    response = await assistant.run(task="Write a Python function that validates email addresses.")
    print(response.messages[-1].content)

if __name__ == "__main__":
    asyncio.run(main())

# ━━━ 4. WHAT THAT COST ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Cost is reported per request on the response itself, not polled from a
# balance endpoint. Call through the nRouter client to read it.
client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": "One-line summary of the run."}],
    max_tokens=256,
)

meta = client.last_response
print(f"\nrequest  {meta.request_id}")
print(f"tokens   {meta.input_tokens} in / {meta.output_tokens} out")

# `cost` is None when the model is unpriced — nRouter never reports a
# confident $0. Always branch on `cost_status`.
if meta.cost_status == "exact":
    print(f"cost     ${meta.cost:.6f}")
else:
    print(f"cost     unpriced ({meta.cost_status})")

# Balances and spend history live in the dashboard at https://app.nrouter.ai —
# they are org-scoped billing data, not inference.
