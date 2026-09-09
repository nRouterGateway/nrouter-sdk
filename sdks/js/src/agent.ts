// The bounded multi-turn tool loop.
//
// This SDK translated tool calls on both wires and then stopped: there was no
// agent loop, no step cap and no stop condition anywhere in it, so every author
// hand-rolled `while (true)` around `nr.chat`. The loop itself is easy; the
// three things people get wrong in it are not, and each one costs money:
//
//   * THE BOUND. A model that keeps asking for the same tool never terminates,
//     and every turn is a billed provider call. The cap belongs here, once,
//     rather than in each author's copy where it is the first thing dropped
//     "just to see if it works".
//
//   * THE APPEND. A tool result must go back as a `tool` turn carrying the
//     `tool_call_id` that binds it to the call. Rebuild the assistant turn from
//     `{ role, content }` — the exact defect options.ts records — and the
//     binding is gone, so the model answers as if the tool never ran.
//
//   * THE COST. A run is many calls, and `sum += meta.cost ?? 0` folds an
//     UNPRICED step to free. `CostAccumulator` counts it instead, and
//     `result.cost.complete` is what says whether the total means anything.
//
// A tool THROWING is not a run failure. The model chose the arguments, so a
// handler error is information it can act on — it is serialised back as the
// tool result, exactly like an unknown tool name. Only the SDK's own refusals
// (a bad `maxSteps`, a malformed tool list) reject the run.

import { chat as runChat } from './chat';
import type { ChatRunner } from './chat';
import { configurationError } from './errors';
import { buildMessages } from './options';
import { CostAccumulator, type CostSummary } from './meta';
import type {
  ChatMessage,
  ChatTool,
  NRouterCallOptions,
  NRouterResponse,
  ResponseMeta,
  ToolCall,
} from './types';

/** Default step ceiling. Bounded by default is the whole point of this module. */
export const DEFAULT_MAX_STEPS = 8;

/** A tool the loop may execute: its wire definition plus the local handler. */
export interface AgentTool {
  definition: ChatTool;
  /**
   * Run the tool. The parsed arguments come first; the raw `ToolCall` is passed
   * too so a handler can read the id or the original argument string when the
   * model emitted something `JSON.parse` could not read.
   */
  execute(args: Record<string, unknown>, call: ToolCall): unknown | Promise<unknown>;
}

/** What the loop knows after each step, handed to `stopWhen`. */
export interface RunState {
  /** Completed provider calls so far. */
  steps: number;
  /** The conversation as it now stands, including tool results. */
  messages: ChatMessage[];
  /** The metadata of the step just completed. */
  meta: ResponseMeta;
  /** The run cost so far — `complete: false` means `total` is a floor. */
  cost: CostSummary;
}

export type StopCondition = (state: RunState) => boolean | Promise<boolean>;

export type StopReason = 'stop' | 'maxSteps' | 'stopWhen';

export interface RunToolsOptions extends Omit<NRouterCallOptions, 'tools'> {
  tools: AgentTool[];
  /** Hard ceiling on provider calls. Must be a whole number ≥ 1. */
  maxSteps?: number;
  /** Called after each step; return true to end the run early. */
  stopWhen?: StopCondition;
}

export interface RunToolsResult {
  /** The final assistant text, or `''` when the run ended without one. */
  text: string;
  /** The whole conversation, ready to feed straight back into another run. */
  messages: ChatMessage[];
  /** Provider calls actually made. */
  steps: number;
  /** Why the loop ended. `'stop'` is the only one that means the model finished. */
  stopReason: StopReason;
  /** Cost across every step, with the unpriced ones counted rather than summed. */
  cost: CostSummary;
  /** The last response, so nothing this helper does not model is lost. */
  last: NRouterResponse<Record<string, unknown>> | null;
}

/**
 * Drive a bounded tool-calling conversation to completion.
 *
 * `runner` is anything with `request(path, body)` — `NRouterSurface` is one, so
 * the ordinary call is `runTools(client.nr, { … })` and every client setting
 * (key, base URL, timeouts, the zero-retry pin on billed POSTs) applies.
 */
export async function runTools(
  runner: ChatRunner,
  options: RunToolsOptions,
): Promise<RunToolsResult> {
  const { tools, maxSteps = DEFAULT_MAX_STEPS, stopWhen, ...call } = options;

  // REFUSED, never clamped. A zero or fractional ceiling is an uninitialised
  // caller state — `parseInt('')` is NaN — and quietly substituting a default
  // for it means the run makes calls the caller believed they had forbidden.
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw configurationError(
      `maxSteps must be a whole number of at least 1, got ${String(maxSteps)}. ` +
        'It is not clamped: the step ceiling is what bounds what this run costs.',
    );
  }

  if (!Array.isArray(tools) || tools.length === 0) {
    throw configurationError(
      'runTools needs at least one tool. With no tools there is no loop to run — ' +
        'call `chat()` instead.',
    );
  }

  const handlers = new Map<string, AgentTool>();
  for (const tool of tools) {
    const name = tool?.definition?.function?.name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw configurationError(
        'every tool needs a non-empty `definition.function.name`: the name is the ' +
          'only thing binding a returned tool_call back to its handler.',
      );
    }
    if (handlers.has(name)) {
      throw configurationError(`two tools are named "${name}"; names must be unique.`);
    }
    handlers.set(name, tool);
  }

  const definitions = tools.map((tool) => tool.definition);
  const cost = new CostAccumulator();

  // Seeded ONCE from the ergonomic options, then carried as an explicit list.
  // Re-deriving it from `prompt`/`systemPrompt` on every turn would resend the
  // opening question and discard the whole conversation.
  const messages: ChatMessage[] = seedMessages(call);
  // Where THIS run's own turns begin. The maxSteps walk-back below must not
  // reach behind it: everything at a lower index came from the caller.
  const seeded = messages.length;

  let steps = 0;
  let stopReason: StopReason = 'maxSteps';
  let last: NRouterResponse<Record<string, unknown>> | null = null;
  let text = '';

  while (steps < maxSteps) {
    // `messages` is the whole conversation, seeded by `seedMessages` — which
    // has ALREADY placed the system turn, the opening prompt and any images
    // where they belong. Every ergonomic field that `buildMessages` would
    // expand into a turn must therefore be cleared here, or it is expanded a
    // SECOND time on every step: the system prompt was prepended ahead of the
    // seeded one (two identical system turns per request), and the images were
    // re-folded — and because the newest turn in a tool loop is a tool RESULT,
    // that fold appends them as a fresh trailing user turn AFTER the tool
    // output, so the model watched the attachment arrive again after every
    // call. Both are billed on each step.
    const response = await runChat(runner, {
      ...call,
      prompt: undefined,
      systemPrompt: undefined,
      images: undefined,
      messages,
      tools: definitions,
    } as NRouterCallOptions);

    steps += 1;
    last = response;
    cost.add(response.meta);

    const choice = firstChoice(response.body);
    const assistant = asRecord(choice?.['message']);
    // Push the assistant turn WHOLE. Rebuilt from two fields it loses
    // `tool_calls`, and the next request then asks the model to answer a tool
    // result for a call it has no record of making.
    const assistantTurn: ChatMessage = assistant
      ? ({ ...assistant, role: 'assistant' } as ChatMessage)
      : { role: 'assistant', content: '' };
    messages.push(assistantTurn);

    const calls = toolCallsOf(assistantTurn);

    if (calls.length === 0) {
      text = typeof assistantTurn.content === 'string' ? assistantTurn.content : contentText(assistantTurn);
      stopReason = 'stop';
      break;
    }

    for (const toolCall of calls) {
      messages.push(await runOneTool(handlers, toolCall));
    }

    if (stopWhen) {
      const state: RunState = { steps, messages, meta: response.meta, cost: cost.summary() };
      if (await stopWhen(state)) {
        stopReason = 'stopWhen';
        break;
      }
    }
  }

  if (stopReason === 'maxSteps' && last) {
    // The bound was reached mid-conversation. Report whatever ASSISTANT text
    // the run produced rather than '' — a partial answer the caller paid for is
    // still theirs.
    //
    // Walk back to the last assistant turn instead of reading
    // `messages[length - 1]`. The final turn of a loop that halted on maxSteps
    // is, by construction, the `tool` RESULT that the next (never-made) request
    // would have answered — so reading the tail returned raw tool output as
    // `result.text`, which the type documents as the assistant's answer. A
    // caller rendering it showed the user a JSON blob from a function.
    // BOUNDED AT `seeded`, and that bound is the whole correctness of the walk.
    // Skipping an empty candidate is right within the run — a step whose
    // assistant turn was a bare tool call has `content: null`, and the step
    // before it may well have spoken. It is wrong the moment the scan crosses
    // into the SEED: a caller resuming a conversation passes their own
    // assistant turns in `messages`, and returning one of those reports, as
    // this run's answer, a sentence this run never produced and nobody was
    // billed for. `''` is the honest value for "this bounded run said nothing".
    for (let i = messages.length - 1; i >= seeded; i -= 1) {
      if (messages[i].role !== 'assistant') continue;
      const candidate = contentText(messages[i]);
      if (candidate) {
        text = candidate;
        break;
      }
    }
  }

  return { text, messages, steps, stopReason, cost: cost.summary(), last };
}

/**
 * Build the opening conversation from the ergonomic single-turn options.
 *
 * This DELEGATES to `buildMessages` rather than restating its rules. The
 * hand-rolled version here handled `systemPrompt`, `messages` and `prompt` but
 * silently ignored `images`, so an attachment never entered the conversation
 * and was instead re-folded into the outgoing body on every step — landing
 * after the newest tool result each time. One seeding rule, in one place, is
 * also what stops the two drifting the next time `buildMessages` learns a field.
 */
function seedMessages(call: Omit<NRouterCallOptions, 'tools'>): ChatMessage[] {
  return buildMessages(call as NRouterCallOptions);
}

/**
 * Execute one tool call and shape the `tool` turn that answers it.
 *
 * Every failure below becomes a tool RESULT rather than a rejection: an unknown
 * name, unparseable arguments and a throwing handler are all things the MODEL
 * caused, and handing the error back is what lets it correct itself on the next
 * step. Throwing instead discards a turn the caller has already paid for.
 */
async function runOneTool(
  handlers: Map<string, AgentTool>,
  call: ToolCall,
): Promise<ChatMessage> {
  const name = call?.function?.name;
  const turn = (content: string): ChatMessage => ({
    role: 'tool',
    tool_call_id: call?.id ?? '',
    name: typeof name === 'string' ? name : undefined,
    content,
  });

  const tool = typeof name === 'string' ? handlers.get(name) : undefined;
  if (!tool) {
    return turn(
      JSON.stringify({
        error: `no tool named "${String(name)}" is available`,
        available: [...handlers.keys()],
      }),
    );
  }

  let args: Record<string, unknown> = {};
  const raw = call.function?.arguments;
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const decoded: unknown = JSON.parse(raw);
      args = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
        ? (decoded as Record<string, unknown>)
        : {};
    } catch {
      // A truncated argument document is what a model that ran out of output
      // tokens emits. Naming it lets the model retry with a shorter call.
      return turn(JSON.stringify({ error: 'the tool arguments were not valid JSON', received: raw.slice(0, 200) }));
    }
  }

  try {
    const value = await tool.execute(args, call);
    return turn(typeof value === 'string' ? value : JSON.stringify(value ?? null));
  } catch (err) {
    return turn(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}

function firstChoice(body: Record<string, unknown>): Record<string, unknown> | null {
  const choices = body['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  return asRecord(choices[0]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolCallsOf(message: ChatMessage): ToolCall[] {
  const calls = message.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.filter((call): call is ToolCall => {
    const record = asRecord(call);
    return record !== null && typeof asRecord(record['function'])?.['name'] === 'string';
  });
}

function contentText(message: ChatMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const part of content) {
      const text = asRecord(part)?.['text'];
      if (typeof text === 'string') out += text;
    }
    return out;
  }
  return '';
}
