# Evals for Customer Support Agent

This directory contains evaluation cases for the support agent, testing KB retrieval accuracy, guardrails, and fallback behavior.

## Usage

1. Build the library first:
   ```bash
   npm run build
   ```

2. Run the evals:
   ```bash
   KB_PATH=/path/to/kb.json NROUTER_API_KEY=sk-nrouter-... [EVAL_MODEL=...] node evals/run.mjs
   ```

Note: These evals require an API key and perform real gateway requests. They must not be run as part of the normal unit test suite.
