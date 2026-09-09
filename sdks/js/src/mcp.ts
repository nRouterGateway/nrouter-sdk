// The MCP surface — `POST /mcp` and `POST /mcp/{server_id}`.
//
// The gateway has mounted both since the MCP work landed, and it meters them
// like inference: `enforce_free_gates` runs the per-key budget translation and
// the RPM limiter on every dispatch, because a call here spends a THIRD-PARTY
// TOOL CREDENTIAL on our account. The SDK could reach neither. `mcp` appeared
// in this package exactly twice — once in a comment, once as a capability
// string in `models.ts` — so the only thing it could tell a caller was that the
// feature exists somewhere they cannot get to.
//
// TWO THINGS THIS FILE GETS RIGHT AND A HAND-ROLLED FETCH DOES NOT.
//
//   1. THE PATH. `/mcp` is mounted at the ROOT of the gateway, NOT under `/v1`,
//      while the client's baseURL carries the `/v1` suffix (the OpenAI and
//      Anthropic SDKs both append their own path to it, so the suffix is not
//      ours to drop — see client.ts). A plain `'/mcp'` therefore resolves to
//      `/v1/mcp`, which 404s. `'/../mcp'` is how `models.ts` already reaches
//      the root-mounted `/capabilities`, and it is the same trick here so there
//      is one answer to "how do I reach a root route" rather than two.
//
//   2. THE ERROR ENVELOPE. MCP is JSON-RPC 2.0, which answers a FAILURE with
//      HTTP 200 and an `error` member. `jsonRequest` — correctly, for every
//      other endpoint — treats a 200 with a parseable body as success, so a
//      "Method not found" would be handed back as a result the caller then
//      reads fields off. Unwrapping the envelope here is what turns it into the
//      same typed `nRouterError` every other call in this SDK throws.
//
// DELIBERATELY NOT MODELLED: the streaming half of Streamable HTTP. The gateway
// forwards the upstream's own response, which may be an SSE stream for a
// long-running tool. `jsonRequest` refuses a non-JSON 2xx with a sentence
// naming the content type rather than parsing bytes as JSON, so that case fails
// loudly and describes itself instead of returning an empty object.

import { createError } from './errors';
import { jsonRequest } from './json';
import type { ChatRunner } from './chat';
import type { NRouterResponse, ResponseMeta } from './types';

/** The root-mounted MCP path, past a baseURL whose suffix is `/v1`. */
const MCP_PATH = '/../mcp';

/** One tool as an MCP server describes it. Shape passes through unmodelled. */
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The result of `tools/call`, as the server returned it. */
export interface MCPCallResult {
  content?: unknown[];
  isError?: boolean;
  [key: string]: unknown;
}

/** A JSON-RPC result paired with the gateway's `x-nr-*` metadata for the call. */
export interface MCPResponse<T> {
  result: T;
  meta: ResponseMeta;
}

let nextId = 1;

/**
 * Reach the MCP servers this gateway fronts.
 *
 * Constructed with any `ChatRunner` — which `NRouterSurface` is — so it shares
 * the client's key, base URL, timeouts and the zero-retry pin on billed POSTs
 * rather than opening a second, differently-configured transport.
 */
export class NRouterMCP {
  constructor(private readonly runner: ChatRunner) {}

  /** List the tools a server exposes. Omit `serverId` when only one is configured. */
  async list(serverId?: string): Promise<MCPTool[]> {
    const { result } = await this.rpc<{ tools?: MCPTool[] }>('tools/list', {}, serverId);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /** Invoke one tool on one server. */
  async call(
    serverId: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<MCPCallResult> {
    const { result } = await this.rpc<MCPCallResult>(
      'tools/call',
      { name, arguments: args },
      serverId,
    );
    return result;
  }

  /**
   * One JSON-RPC round trip, with the gateway metadata kept.
   *
   * Public because a method this SDK does not model yet — `resources/list`,
   * `prompts/get` — must never be a blocker; the same reasoning as `extra` on
   * the chat path.
   */
  async rpc<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    serverId?: string,
  ): Promise<MCPResponse<T>> {
    const path = serverId ? `${MCP_PATH}/${encodeURIComponent(serverId)}` : MCP_PATH;
    const id = nextId++;
    const response: NRouterResponse<Record<string, unknown>> = await jsonRequest(
      this.runner,
      path,
      { jsonrpc: '2.0', id, method, params },
    );

    const envelope = response.body['error'];
    if (envelope !== undefined && envelope !== null) {
      // JSON-RPC reports failure inside a 200. Left alone it reaches the caller
      // as a "successful" body with no result on it.
      const asRecord =
        typeof envelope === 'object' && !Array.isArray(envelope)
          ? (envelope as Record<string, unknown>)
          : {};
      const message =
        typeof asRecord['message'] === 'string' ? asRecord['message'] : 'the MCP server returned an error';
      const code = asRecord['code'];
      throw createError(`MCP ${method} failed: ${message}`, {
        code: code === undefined ? undefined : String(code),
        meta: response.meta,
      });
    }

    return { result: response.body['result'] as T, meta: response.meta };
  }
}
