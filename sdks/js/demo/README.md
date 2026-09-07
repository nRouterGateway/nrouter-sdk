# nRouter JS / TypeScript SDK Demos & Examples

Runnable demonstrations, test suites, and interactive agents for `@nrouter_ai/sdk`.

## Quick Start

```bash
cd sdks/js
npm run build
node demo/agent.js --dry-run
```

Dry-run mode uses an in-memory requester and does not spend credits.

To hit the live gateway, set `NROUTER_API_KEY`:

```bash
export NROUTER_API_KEY="sk-nrouter-..."
# nrouter-doc-wire: messages
node demo/agent.js --live
```

The live mode defaults to `claude-haiku-4-5-20251001`. Override with:

```bash
<!-- nrouter-doc-wire: messages -->
NROUTER_DEMO_MODEL=claude-sonnet-4-5-20250929 node demo/agent.js --live
```

## Available Demos & Suites

### 1. Interactive CLI & Web Demos
- `agent.js`: Interactive agent verifying model discovery, chat/messages, response metadata, and guardrails.
- `aggressive-agent-test.js`: Stressed execution against cost targets or request limits.
- `feature-spend-test.js`: Feature billing verification across embeddings, images, speech, transcription, and video.
- `log-error-test.js`: Error path verification and logging.
- `metric-reconciliation-test.js`: Token & cost metric reconciliation.
- `performance-reconciliation-test.js`: Latency and throughput reconciliation.
- `ui/server.js`: Local lightweight web UI running on `http://127.0.0.1:4317`.

### 2. Standalone Quickstarts & Frameworks
- `quickstart.js`: Vanilla JavaScript quickstart.
- `quickstart.ts`: TypeScript quickstart with type safety.
- `node.ts`: Plain OpenAI Node.js compatibility example.
- `vercel_ai.ts`: Integration with Vercel AI SDK (`ai`, `@ai-sdk/openai`).

### 3. Modality & Agent Test Suites
- `demo_e2e_suite.js`: Comprehensive multi-modal certification suite.
- `chat_agent_suite.js`: Chat routing, buffering, and streaming certification.
- `image_agent_suite.js`: Image generation certification.
- `video_agent_suite.js`: Asynchronous video job certification.
- `voice_agent_suite.js`: Speech and transcription certification.

### 4. Specialized Agents
- `chat-agent/`: Interactive CLI chatbot demonstrating multi-turn history and streaming.
- `image-agent/`: Image generation agent with cost breakdown.
- `voice-agent/`: Voice synthesis and speech transcription agent.
- `video-agent/`: Video creation, status polling, and download agent.

### 5. Published Package Verification
- `demo-e2e-sdk-example/`: Standalone external project consuming `@nrouter_ai/sdk` tarball.

## Running Tests

```bash
# Unit test accounting logic
node --test demo/lib/
```
