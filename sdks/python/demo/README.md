# nRouter Python SDK Demos & Examples

Runnable demonstrations for the official nRouter Python SDK (`nrouter-sdk`).

## Prerequisites

```bash
pip install -e ..
# Or from PyPI:
# pip install nrouter-sdk
export NROUTER_API_KEY="sk-nrouter-..."
```

## Available Demos

### Core Demos
- `01_quickstart.py`: Basic completions and OpenAI client compatibility.
- `02_async_concurrency.py`: High-throughput async client and concurrency patterns.
- `03_streaming.py`: Token streaming with real-time response chunks.
- `04_anthropic_messages.py`: Native Anthropic Messages API routing.
- `05_metadata_cost_tracking.py`: Gateway header inspection (`x-nr-request-cost`, `x-nr-request-id`, tokens).
- `06_prompt_templates.py`: Prompt template compilation and interpolation.
- `07_tool_calling.py`: Function calling and structured tool execution.
- `08_structured_outputs.py`: JSON schema structured output enforcement.
- `09_error_handling.py`: Typed gateway exceptions (`AuthenticationError`, `RateLimitError`, `GuardrailBlockedError`, etc.).
- `10_conversation_memory.py`: Multi-turn stateful conversation management.
- `11_embeddings.py`: Vector embeddings generation.
- `12_multimodal_vision.py`: Vision and multimodal image understanding.

### Autonomous Agents (Native nRouter SDK)
*Build autonomous agents directly with native SDK building blocks — zero third-party framework overhead, zero OpenAI wrapper dependencies, with full per-turn cost tracking and guardrails:*
- `agent.py`: Complete autonomous agent featuring model discovery, multi-turn memory (`create_memory`), dynamic tool execution loop, server-side guardrail interception (`nRouterGuardrailBlockedError`), and real-time spend telemetry (`client.last_response`). Supports `--dry-run` and `--live`.
- `13_multi_agent_workflow.py`: Role-based multi-agent collaboration (Researcher with tools + Executive Writer) with independent memory states and per-agent spend accounting.

### End-to-End Suites
- `demo_e2e_suite.py`: Complete certified multi-modal suite with spend and latency checks.
- `full_walkthrough.py`: Comprehensive guide covering all gateway features in a single flow.

### Framework Integrations
*Adapters for external libraries. Note: Native SDK Agents above are recommended for new agent workflows to preserve full gateway telemetry (`client.last_response`) and avoid artificial OpenAI dependencies.*
- `frameworks/instructor.py`: Pydantic structured output extraction using `instructor.from_openai(client)` with native nRouter client and direct telemetry.
- `frameworks/langchain.py`: Integration with LangChain (`ChatOpenAI`, `OpenAIEmbeddings`) and nRouter guardrail error handling.
- `frameworks/llamaindex.py`: Integration with LlamaIndex (`OpenAI`, `OpenAIEmbedding`).
- `frameworks/crewai.py`: Multi-agent orchestration with CrewAI targeting nRouter.
- `frameworks/autogen.py`: Conversational agents with Microsoft AutoGen.

## Running a Demo

```bash
python 01_quickstart.py
python agent.py --dry-run
python 13_multi_agent_workflow.py --dry-run
python demo_e2e_suite.py
```
