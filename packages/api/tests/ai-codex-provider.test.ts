import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  estimateTokens,
  PROVIDER_MAX_BODY_BYTES,
  PROVIDER_MAX_MESSAGES,
  PROVIDER_MAX_OUTPUT_TOKENS,
  ProviderContextOverflowError,
  ProviderKeyRequiredError,
  ProviderProtocolError,
  ProviderRateLimitError,
  ProviderResponseTruncatedError,
  ProviderTransportError,
  type ProviderMessage,
  type ProviderTool,
} from "../src/ai/ai-provider.js";
import { fromCodexResponsesResult, generateCodexRequest, toCodexResponsesBody, type CodexProviderConfig } from "../src/ai/ai-codex-provider.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())))); });

type CapturedRequest = { path: string | undefined; headers: IncomingHttpHeaders; body: string };

async function codexBackend(responseBody: unknown, status = 200): Promise<{ config: CodexProviderConfig; requests: () => CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request,response) => {
    const chunks: Buffer[] = [];
    request.on("data",(chunk:Buffer)=>chunks.push(chunk));
    request.on("end",()=>{
      requests.push({ path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(status,{"Content-Type":"application/json"});
      response.end(JSON.stringify(responseBody));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address=server.address(); if(!address || typeof address==="string") throw new Error("Missing listener");
  return { config:{ apiBaseUrl:`http://127.0.0.1:${address.port}`, cliVersion:"0.42.0", model:"gpt-5-codex", accessToken:"synthetic-codex-token", allowPrivateEndpoint:true }, requests: () => requests };
}

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { return error as Error; }
  throw new Error("expected the codex call to fail");
}

const diskTool: ProviderTool = { type: "function", function: { name: "list_disks", description: "List mounted disks", parameters: { type: "object", properties: { path: { type: "string" } } } } };
const completed = { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("Codex Responses request translation",()=>{
  it("maps system+user+assistant history, tools and flags to the Responses body shape",()=>{
    const messages: ProviderMessage[] = [
      { role: "system", content: "You are a VPS assistant." },
      { role: "system", content: "Be brief." },
      { role: "user", content: "check disk" },
      { role: "assistant", content: "Running df." },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", type: "function", function: { name: "list_disks", arguments: '{"path":"/"}' } }] },
      { role: "tool", content: '"/dev/sda"', toolCallId: "call_1" },
      { role: "user", content: "thanks" },
    ];
    const body = toCodexResponsesBody("gpt-5-codex", messages, [diskTool]);
    expect(body.model).toBe("gpt-5-codex");
    expect(body.instructions).toBe("You are a VPS assistant.\n\nBe brief.");
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "check disk" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Running df." }] },
      { type: "function_call", call_id: "call_1", name: "list_disks", arguments: '{"path":"/"}' },
      { type: "function_call_output", call_id: "call_1", output: '"/dev/sda"' },
      { type: "message", role: "user", content: [{ type: "input_text", text: "thanks" }] },
    ]);
    expect(body.tools).toEqual([{ type: "function", name: "list_disks", description: "List mounted disks", parameters: { type: "object", properties: { path: { type: "string" } } }, strict: false }]);
    expect(body.tool_choice).toBe("auto");
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(false);
    expect(body.max_output_tokens).toBe(PROVIDER_MAX_OUTPUT_TOKENS);
  });
  it("omits instructions, tools and tool_choice when the conversation has none",()=>{
    const body = toCodexResponsesBody("gpt-5.1-codex",[{ role: "user", content: "hi" }],[]);
    expect(body.instructions).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  });
  it("keeps non-empty assistant content as a message item preceding its function calls",()=>{
    const body = toCodexResponsesBody("gpt-5-codex",[{ role: "assistant", content: "Checking now.", toolCalls: [{ id: "call_2", type: "function", function: { name: "list_disks", arguments: "{}" } }, { id: "call_3", type: "function", function: { name: "list_disks", arguments: "{}" } }] }],[diskTool]);
    expect(body.input).toEqual([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking now." }] },
      { type: "function_call", call_id: "call_2", name: "list_disks", arguments: "{}" },
      { type: "function_call", call_id: "call_3", name: "list_disks", arguments: "{}" },
    ]);
  });
  it("rejects a tool result without the call id the Responses format requires",()=>{
    expect(() => toCodexResponsesBody("gpt-5-codex",[{ role: "tool", content: "result" }],[])).toThrow(ProviderProtocolError);
  });
  it("validates the bounded output cap before any dispatch",()=>{
    expect(() => toCodexResponsesBody("gpt-5-codex",[{ role: "user", content: "x" }],[],{ maxOutputTokens: 0 })).toThrow(ProviderProtocolError);
    expect(() => toCodexResponsesBody("gpt-5-codex",[{ role: "user", content: "x" }],[],{ maxOutputTokens: PROVIDER_MAX_OUTPUT_TOKENS + 1 })).toThrow(ProviderProtocolError);
    expect(toCodexResponsesBody("gpt-5-codex",[{ role: "user", content: "x" }],[],{ maxOutputTokens: 1024 }).max_output_tokens).toBe(1024);
  });
});

describe("Codex Responses result translation",()=>{
  it("translates message and function_call items into a tool-call result with measured usage",()=>{
    const parsed = { status: "completed", output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking disks." }] },
      { type: "function_call", call_id: "call_9", name: "list_disks", arguments: '{"path":"/"}' },
    ], usage: { input_tokens: 42, output_tokens: 7, total_tokens: 49 } };
    const result = fromCodexResponsesResult(parsed,{ tools: [diskTool] });
    expect(result.message).toEqual({ role: "assistant", content: "Checking disks.", toolCalls: [{ id: "call_9", type: "function", function: { name: "list_disks", arguments: '{"path":"/"}' } }] });
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7, estimated: false });
  });
  it("concatenates output_text parts across multiple message items in order",()=>{
    const result = fromCodexResponsesResult({ status: "completed", output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "a" },{ type: "output_text", text: "b" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "c" }] },
    ] });
    expect(result.message).toEqual({ role: "assistant", content: "abc" });
    expect(result.usage.estimated).toBe(true);
  });
  it("skips non-text items such as reasoning between dispatch-relevant items",()=>{
    const result = fromCodexResponsesResult({ status: "completed", output: [
      { type: "reasoning", summary: [], encrypted_content: "opaque" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    ] },{ tools: [diskTool] });
    expect(result.message.content).toBe("done");
    expect(result.message.toolCalls).toBeUndefined();
  });
  it("redacts assistant text exactly like the chat path",()=>{
    const result = fromCodexResponsesResult({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "key sk-abcdefghijklmnopqrst and Bearer abc123 in logs" }] }] });
    expect(result.message.content).not.toContain("sk-abcdefghijklmnopqrst");
    expect(result.message.content).not.toContain("abc123");
    expect(result.message.content).toContain("[REDACTED]");
  });
  it("maps status incomplete to the truncated error so cut-off output is never accepted",()=>{
    expect(() => fromCodexResponsesResult({ status: "incomplete", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "partial" }] }] })).toThrow(ProviderResponseTruncatedError);
    try { fromCodexResponsesResult({ status: "incomplete", output: [] }); } catch (error) { expect(error).toBeInstanceOf(ProviderProtocolError); expect((error as Error).code).toBe("provider_response_truncated"); return; }
    throw new Error("expected a truncated error");
  });
  it.each([
    ["missing output", {}],
    ["output not an array", { status: "completed", output: "nope" }],
    ["non-terminal status", { status: "failed", output: [] }],
    ["non-assistant message item", { status: "completed", output: [{ type: "message", role: "user", content: [] }] }],
    ["string message content", { status: "completed", output: [{ type: "message", role: "assistant", content: "plain" }] }],
    ["input_text part in output", { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "input_text", text: "x" }] }] }],
    ["partial usage", { status: "completed", output: [], usage: { input_tokens: 1 } }],
    ["negative usage", { status: "completed", output: [], usage: { input_tokens: -1, output_tokens: 1 } }],
  ])("rejects malformed responses (%s) as protocol errors",(_name,parsed)=>{
    expect(() => fromCodexResponsesResult(parsed,{ tools: [diskTool] })).toThrow(ProviderProtocolError);
  });
  it.each([
    ["arguments not an object", [{ type: "function_call", call_id: "c1", name: "list_disks", arguments: "[]" }], [diskTool]],
    ["arguments not JSON", [{ type: "function_call", call_id: "c1", name: "list_disks", arguments: "nope" }], [diskTool]],
    ["undeclared tool name", [{ type: "function_call", call_id: "c1", name: "list_disks", arguments: "{}" }], []],
    ["invalid tool name", [{ type: "function_call", call_id: "c1", name: "bad name!", arguments: "{}" }], [diskTool]],
    ["duplicate call ids", [
      { type: "function_call", call_id: "c1", name: "list_disks", arguments: "{}" },
      { type: "function_call", call_id: "c1", name: "list_disks", arguments: "{}" },
    ], [diskTool]],
    ["missing arguments", [{ type: "function_call", call_id: "c1", name: "list_disks" }], [diskTool]],
  ])("rejects invalid function_call items (%s) as protocol errors",(_name,items,tools)=>{
    expect(() => fromCodexResponsesResult({ status: "completed", output: items },{ tools })).toThrow(ProviderProtocolError);
  });
  it("estimates conservative usage from the request body and assistant message when usage is missing",()=>{
    const requestBody = JSON.stringify({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "請檢查磁碟使用量".repeat(20) }] }] });
    const outputText = "磁碟空間不足".repeat(25);
    const result = fromCodexResponsesResult({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: outputText }] }] },{ requestBody });
    expect(result.usage.estimated).toBe(true);
    expect(result.usage.outputTokens).toBe(estimateTokens(JSON.stringify(result.message)));
    expect(result.usage.inputTokens).toBe(estimateTokens(requestBody));
    // CJK text must never be underestimated by the naive bytes/4 rule.
    expect(result.usage.outputTokens).toBeGreaterThan(Math.ceil(Buffer.byteLength(outputText) / 4));
    expect(result.usage.inputTokens).toBeGreaterThan(Math.ceil(Buffer.byteLength(requestBody) / 4));
  });
});

describe("Codex executor",()=>{
  it("dispatches through the guarded path with the Codex client headers and body",async()=>{
    const { config, requests } = await codexBackend(completed);
    const result = await generateCodexRequest(config,[{ role: "user", content: "check" }],[]);
    expect(result.message).toEqual({ role: "assistant", content: "ok" });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2, estimated: false });
    const [sent] = requests();
    expect(sent?.path).toBe("/backend-api/codex/responses");
    expect(sent?.headers["authorization"]).toBe("Bearer synthetic-codex-token");
    expect(sent?.headers["originator"]).toBe("codex_cli_rs");
    expect(sent?.headers["version"]).toBe("0.42.0");
    expect(sent?.headers["openai-beta"]).toBe("responses=experimental");
    expect(String(sent?.headers["session_id"])).toMatch(uuidV4);
    const parsedBody = JSON.parse(sent!.body);
    expect(parsedBody.model).toBe("gpt-5-codex");
    expect(parsedBody.stream).toBe(false);
    expect(parsedBody.store).toBe(false);
    expect(parsedBody.parallel_tool_calls).toBe(false);
    expect(parsedBody.max_output_tokens).toBe(PROVIDER_MAX_OUTPUT_TOKENS);
    expect(parsedBody.instructions).toBeUndefined();
    expect(parsedBody.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "check" }] }]);
  });
  it("mints a fresh session id per request",async()=>{
    const { config, requests } = await codexBackend(completed);
    await generateCodexRequest(config,[{ role: "user", content: "one" }],[]);
    await generateCodexRequest(config,[{ role: "user", content: "two" }],[]);
    const [first, second] = requests();
    expect(first?.headers["session_id"]).toBeTruthy();
    expect(first?.headers["session_id"]).not.toBe(second?.headers["session_id"]);
  });
  it("rejects loopback endpoints unless the test-only opt-in is set",async()=>{
    const { config } = await codexBackend(completed);
    const hardened = { ...config, allowPrivateEndpoint: undefined };
    await expect(generateCodexRequest(hardened,[{ role: "user", content: "x" }],[])).rejects.toBeInstanceOf(ProviderTransportError);
  });
  it("requires an access token before any dispatch",async()=>{
    const { config, requests } = await codexBackend(completed);
    await expect(generateCodexRequest({ ...config, accessToken: "" },[{ role: "user", content: "x" }],[])).rejects.toBeInstanceOf(ProviderKeyRequiredError);
    expect(requests()).toHaveLength(0);
  });
  it("rejects pre-cancelled inference without dispatch",async()=>{
    const { config, requests } = await codexBackend(completed);
    const controller = new AbortController(); controller.abort();
    await expect(generateCodexRequest(config,[{ role: "user", content: "x" }],[],controller.signal)).rejects.toBeInstanceOf(ProviderTransportError);
    expect(requests()).toHaveLength(0);
  });
  it("enforces the shared request caps without dispatch",async()=>{
    const { config, requests } = await codexBackend(completed);
    const messages = Array.from({ length: PROVIDER_MAX_MESSAGES + 1 },() => ({ role: "user", content: "x" }) as ProviderMessage);
    await expect(generateCodexRequest(config,messages,[])).rejects.toBeInstanceOf(ProviderProtocolError);
    await expect(generateCodexRequest(config,[{ role: "user", content: "x".repeat(PROVIDER_MAX_BODY_BYTES) }],[])).rejects.toBeInstanceOf(ProviderProtocolError);
    expect(requests()).toHaveLength(0);
  });
  it("classifies HTTP 429 as rate limiting, distinct from protocol failures",async()=>{
    const { config } = await codexBackend({ error: "rate limited" },429);
    const error = await failureOf(generateCodexRequest(config,[{ role: "user", content: "x" }],[]));
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).not.toBeInstanceOf(ProviderProtocolError);
    expect(error.code).toBe("provider_rate_limit");
  });
  it("classifies HTTP 413 as context overflow",async()=>{
    const { config } = await codexBackend({ error: "request entity too large" },413);
    const error = await failureOf(generateCodexRequest(config,[{ role: "user", content: "x" }],[]));
    expect(error).toBeInstanceOf(ProviderContextOverflowError);
    expect(error.code).toBe("provider_context_overflow");
    expect(error.message).not.toContain("request entity too large");
  });
  it("rejects malformed response payloads as protocol failures",async()=>{
    const { config } = await codexBackend({ status: "completed", output: "nope" });
    await expect(generateCodexRequest(config,[{ role: "user", content: "x" }],[])).rejects.toBeInstanceOf(ProviderProtocolError);
  });
});
