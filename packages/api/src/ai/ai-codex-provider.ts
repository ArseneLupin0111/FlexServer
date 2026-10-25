import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  estimateTokens,
  PROVIDER_MAX_BODY_BYTES,
  PROVIDER_MAX_MESSAGES,
  PROVIDER_MAX_OUTPUT_TOKENS,
  PROVIDER_MAX_TOOLS,
  providerJsonExchange,
  ProviderKeyRequiredError,
  ProviderProtocolError,
  ProviderResponseTruncatedError,
  ProviderTransportError,
  resolveProviderTarget,
  type ProviderConfig,
  type ProviderMessage,
  type ProviderResult,
  type ProviderTool,
  type ProviderToolCall,
  type UsageInfo,
} from "./ai-provider.js";
import { redactString } from "../common/redaction.js";

/** Codex OAuth transport (docs/ai-chatgpt-oauth-provider-plan.md slice 3).
 * ChatGPT subscription dispatch goes through the same guarded request funnel
 * (resolveProviderTarget + providerJsonExchange) as every API-key provider, so
 * URL/DNS/BlockList policy, classified failures and redaction stay identical. */

function normalizedMaxOutputTokens(options?: { maxOutputTokens?: number }): number {
  const requested = options?.maxOutputTokens ?? PROVIDER_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(requested) || requested < 1 || requested > PROVIDER_MAX_OUTPUT_TOKENS) throw new ProviderProtocolError();
  return requested;
}

export type CodexResponsesBody = {
  model: string;
  instructions: string | undefined;
  input: unknown[];
  tools?: unknown[];
  tool_choice?: string;
  parallel_tool_calls: boolean;
  store: boolean;
  stream: boolean;
  max_output_tokens: number;
};

/** Pure Chat-Completions-conversation → Responses-API request translator.
 * System messages collapse into `instructions` (first wins, the rest append
 * with blank-line separators); everything else maps in order to input items.
 * Throws ProviderProtocolError on invalid output caps or a tool result without
 * the call id the Responses format requires. */
export function toCodexResponsesBody(model: string, messages: readonly ProviderMessage[], tools: readonly ProviderTool[], options?: { maxOutputTokens?: number }): CodexResponsesBody {
  const maxOutputTokens = normalizedMaxOutputTokens(options);
  const instructions = messages.filter(message => message.role === "system").map(message => message.content).join("\n\n");
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") { input.push({ type: "message", role: "user", content: [{ type: "input_text", text: message.content }] }); continue; }
    if (message.role === "assistant") {
      const calls = message.toolCalls ?? [];
      if (!calls.length) { input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: message.content }] }); continue; }
      if (message.content) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: message.content }] });
      for (const call of calls) input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      continue;
    }
    if (!message.toolCallId) throw new ProviderProtocolError();
    input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
  }
  return {
    model,
    instructions: instructions.length > 0 ? instructions : undefined,
    input,
    ...(tools.length ? { tools: tools.map(tool => ({ type: "function", name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters, strict: false })), tool_choice: "auto" } : {}),
    parallel_tool_calls: false,
    store: false,
    stream: false,
    max_output_tokens: maxOutputTokens,
  };
}

const codexResponseSchema = z.object({
  output: z.array(z.object({ type: z.string().min(1).max(64) }).passthrough()).max(256),
  status: z.string().max(32).optional(),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).passthrough().optional(),
}).passthrough();

const CODEX_FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CODEX_MAX_FUNCTION_CALLS = 16;
const CODEX_MAX_TEXT_CHARS = 262144;

export type CodexResultContext = { tools?: readonly ProviderTool[]; requestBody?: string };

/** Responses-API result → ProviderResult translator. status "incomplete"
 * maps to ProviderResponseTruncatedError (never accept cut-off output);
 * anything malformed maps to ProviderProtocolError. Non-text item kinds the
 * Codex backend interleaves (e.g. reasoning items) carry no dispatch-relevant
 * content and are skipped. When the response omits `usage`, conservative
 * estimates are derived from the assistant message and, when supplied, the
 * exact serialized request body. */
export function fromCodexResponsesResult(parsed: unknown, context?: CodexResultContext): { message: ProviderMessage; usage: UsageInfo } {
  const decoded = codexResponseSchema.safeParse(parsed);
  if (!decoded.success) throw new ProviderProtocolError();
  const status = decoded.data.status;
  if (status === "incomplete") throw new ProviderResponseTruncatedError();
  if (status !== undefined && status !== "completed") throw new ProviderProtocolError();
  let text = "";
  const calls: ProviderToolCall[] = [];
  for (const item of decoded.data.output) {
    if (item.type === "message") {
      if (item.role !== "assistant" || !Array.isArray(item.content)) throw new ProviderProtocolError();
      for (const part of item.content) {
        if (!part || typeof part !== "object" || part.type !== "output_text" || typeof part.text !== "string") throw new ProviderProtocolError();
        text += part.text;
        if (text.length > CODEX_MAX_TEXT_CHARS) throw new ProviderProtocolError();
      }
    } else if (item.type === "function_call") {
      if (calls.length >= CODEX_MAX_FUNCTION_CALLS) throw new ProviderProtocolError();
      const callId = item.call_id, name = item.name, args = item.arguments;
      if (typeof callId !== "string" || callId.length < 1 || callId.length > 128) throw new ProviderProtocolError();
      if (typeof name !== "string" || !CODEX_FUNCTION_NAME_PATTERN.test(name)) throw new ProviderProtocolError();
      if (typeof args !== "string" || args.length > 65536) throw new ProviderProtocolError();
      calls.push({ id: callId, type: "function", function: { name, arguments: args } });
    }
  }
  const declared = context?.tools ? new Set(context.tools.map(tool => tool.function.name)) : undefined;
  const ids = new Set<string>();
  for (const call of calls) {
    if (declared && !declared.has(call.function.name)) throw new ProviderProtocolError();
    if (ids.has(call.id)) throw new ProviderProtocolError();
    ids.add(call.id);
    try { const args: unknown = JSON.parse(call.function.arguments); if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(); } catch { throw new ProviderProtocolError(); }
  }
  const assistant: ProviderMessage = { role: "assistant", content: redactString(text), ...(calls.length ? { toolCalls: calls } : {}) };
  const usage = decoded.data.usage;
  return {
    message: assistant,
    usage: usage
      ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, estimated: false }
      : { inputTokens: estimateTokens(context?.requestBody ?? JSON.stringify(assistant)), outputTokens: estimateTokens(JSON.stringify(assistant)), estimated: true },
  };
}

export type CodexProviderConfig = {
  apiBaseUrl: string;
  cliVersion: string;
  model: string;
  accessToken: string;
  /** Loopback/private endpoint opt-in for offline stub-server tests only;
   * production dispatch leaves it unset so the default policy holds. */
  allowPrivateEndpoint?: boolean;
};

/** One guarded Codex responses exchange: mirrors generateProviderRequest's
 * caps, deadline and failure mapping, sends the Codex client headers
 * (originator/version/session_id/OpenAI-Beta) beside the bearer token, and
 * translates via the pure functions above. */
export async function generateCodexRequest(config: CodexProviderConfig, messages: readonly ProviderMessage[], tools: readonly ProviderTool[], signal?: AbortSignal, options?: { maxOutputTokens?: number }): Promise<ProviderResult> {
  if (!config.accessToken) throw new ProviderKeyRequiredError();
  if (tools.length > PROVIDER_MAX_TOOLS || messages.length > PROVIDER_MAX_MESSAGES || !config.model || config.model.length > 256) throw new ProviderProtocolError();
  normalizedMaxOutputTokens(options);
  const deadline = AbortSignal.timeout(60000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const providerConfig: ProviderConfig = { endpoint: config.apiBaseUrl, model: config.model, apiKey: config.accessToken, allowPrivateEndpoint: config.allowPrivateEndpoint };
    const target = await resolveProviderTarget(providerConfig, combined, "/backend-api/codex/responses");
    const body = JSON.stringify(toCodexResponsesBody(config.model, messages, tools, options));
    if (Buffer.byteLength(body) > PROVIDER_MAX_BODY_BYTES) throw new ProviderProtocolError();
    const raw = await providerJsonExchange(target, providerConfig, combined, body, {
      originator: "codex_cli_rs",
      version: config.cliVersion,
      session_id: randomUUID(),
      "OpenAI-Beta": "responses=experimental",
    });
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { throw new ProviderProtocolError(); }
    return fromCodexResponsesResult(decoded, { tools, requestBody: body });
  } catch (error) {
    if (error instanceof ProviderProtocolError || error instanceof ProviderTransportError) throw error;
    throw new ProviderTransportError();
  }
}
