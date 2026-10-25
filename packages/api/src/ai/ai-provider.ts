import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { z } from "zod";
import { redactString } from "../common/redaction.js";
export type ProviderConfig = { endpoint: string; model: string; apiKey: string; allowPrivateEndpoint?: boolean };
export type ProviderToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ProviderMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; toolCalls?: ProviderToolCall[]; toolCallId?: string; name?: string };
export type ProviderTool = { type: "function"; function: { name: string; description: string; parameters: object } };
export type UsageInfo = { inputTokens: number; outputTokens: number; estimated: boolean };
export type ProviderResult = { message: ProviderMessage; usage: UsageInfo };
export class ProviderProtocolError extends Error { readonly code: string = "provider_protocol_error"; constructor(message: string = "Invalid provider response") { super(message); this.name = "ProviderProtocolError"; } }
export class ProviderTransportError extends Error { readonly code: string = "provider_unavailable"; constructor(message: string = "Provider request unavailable") { super(message); this.name = "ProviderTransportError"; } }
export class ProviderKeyRequiredError extends Error { readonly code: string = "provider_key_required"; constructor() { super("Provider key required"); this.name = "ProviderKeyRequiredError"; } }
/** Provider rate limiting (HTTP 429). Distinct from context overflow and protocol failures. */
export class ProviderRateLimitError extends ProviderTransportError { readonly code: string = "provider_rate_limit"; constructor() { super("Provider rate limit exceeded"); this.name = "ProviderRateLimitError"; } }
/** Request exceeded the provider context window (HTTP 413 or a recognized context-length error body). Caller may retry after compaction; never a rate limit. */
export class ProviderContextOverflowError extends ProviderTransportError { readonly code: string = "provider_context_overflow"; constructor() { super("Provider request exceeds context window"); this.name = "ProviderContextOverflowError"; } }
/** finish_reason "length": output was cut off at max_tokens. Never treat such content (incl. summaries) as complete. */
export class ProviderResponseTruncatedError extends ProviderProtocolError { readonly code: string = "provider_response_truncated"; constructor() { super("Provider response truncated at token limit"); this.name = "ProviderResponseTruncatedError"; } }

// Hard provider-facing request ceilings, shared by the request path and preflight measurement.
export const PROVIDER_MAX_MESSAGES = 128;
export const PROVIDER_MAX_TOOLS = 32;
export const PROVIDER_MAX_BODY_BYTES = 1024 * 1024;
export const PROVIDER_MAX_OUTPUT_TOKENS = 2048;
/** Bounded output for no-tools compaction/summary requests. */
export const PROVIDER_SUMMARY_MAX_OUTPUT_TOKENS = 1024;
export type ProviderRequestOptions = { maxOutputTokens?: number };
export type ProviderRequestMeasure = { bodyBytes: number; messageCount: number; toolCount: number; maxOutputTokens: number; estimatedPromptTokens: number };

function normalizedMaxOutputTokens(options?: ProviderRequestOptions): number {
  const requested = options?.maxOutputTokens ?? PROVIDER_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(requested) || requested < 1 || requested > PROVIDER_MAX_OUTPUT_TOKENS) throw new ProviderProtocolError();
  return requested;
}
/** Exact request serializer shared by the network path and preflight measurement. Never includes credentials. */
export function serializeProviderRequestBody(model: string, messages: readonly ProviderMessage[], tools: readonly ProviderTool[], options?: ProviderRequestOptions): string {
  return JSON.stringify({model,stream:false,messages:messages.map(m=>({role:m.role,content:m.content,...(m.toolCalls ? {tool_calls:m.toolCalls}:{}),...(m.toolCallId ? {tool_call_id:m.toolCallId}:{}),...(m.name ? {name:m.name}:{})})),...(tools.length ? {tools}:{}),max_tokens:normalizedMaxOutputTokens(options)});
}
/** Conservative token estimate. Never exact by design: CJK/fullwidth code points count as at least one
 * token each (a 3-byte UTF-8 CJK char is undercounted by the naive bytes/4 rule); when extended-Latin
 * diacritics dominate (Vietnamese and similar), the remainder is measured at bytes/3 because BPE
 * tokenizers frequently spend more than one token per syllable; otherwise bytes/4. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let dense = 0, otherBytes = 0, otherCodePoints = 0, extendedLatin = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    // Hangul Jamo, CJK radicals through Yi, Hangul syllables, CJK compatibility, fullwidth forms, CJK extensions.
    if ((code >= 0x1100 && code <= 0x11ff) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3fffd)) dense++;
    else { otherBytes += Buffer.byteLength(character, "utf8"); otherCodePoints++; if ((code >= 0x100 && code <= 0x24f) || (code >= 0x1e00 && code <= 0x1eff)) extendedLatin++; }
  }
  // Diacritic-heavy text (Vietnamese and similar) tokenizes denser than plain ASCII.
  const divisor = otherCodePoints > 0 && extendedLatin * 20 >= otherCodePoints ? 3 : 4;
  return Math.ceil(otherBytes / divisor) + dense;
}
/** Pure preflight measurement of a would-be request: serialized size, counts, output cap and a
 * conservative prompt-token estimate. Performs no I/O, needs no API key, and deliberately measures
 * oversized inputs so callers can detect limit breaches before dispatch. */
export function measureProviderRequest(model: string, messages: readonly ProviderMessage[], tools: readonly ProviderTool[], options?: ProviderRequestOptions): ProviderRequestMeasure {
  const body = serializeProviderRequestBody(model, messages, tools, options);
  return { bodyBytes: Buffer.byteLength(body), messageCount: messages.length, toolCount: tools.length, maxOutputTokens: normalizedMaxOutputTokens(options), estimatedPromptTokens: estimateTokens(body) };
}

const forbidden = new BlockList();
for (const [address, prefix] of [["0.0.0.0",8],["169.254.0.0",16],["100.64.0.0",10],["192.0.0.0",24],["192.0.2.0",24],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) forbidden.addSubnet(address,prefix,"ipv4");
for (const [address,prefix] of [["::",96],["fe80::",10],["fec0::",10],["ff00::",8],["2001::",23],["2001:db8::",32],["2002::",16],["64:ff9b::",96],["64:ff9b:1::",48]] as const) forbidden.addSubnet(address,prefix,"ipv6");
forbidden.addAddress("fd00:ec2::254","ipv6");
const privateRanges = new BlockList();
privateRanges.addSubnet("10.0.0.0",8,"ipv4"); privateRanges.addSubnet("172.16.0.0",12,"ipv4"); privateRanges.addSubnet("192.168.0.0",16,"ipv4"); privateRanges.addSubnet("127.0.0.0",8,"ipv4"); privateRanges.addSubnet("fc00::",7,"ipv6"); privateRanges.addAddress("::1","ipv6");
function allowed(address: string, privateOptIn: boolean): boolean {
  // Mapped addresses are classified as IPv4, never allowed to bypass its policy.
  if (address.toLowerCase().startsWith("::ffff:")) return false;
  const family = isIP(address) === 4 ? "ipv4" : "ipv6";
  if (address === "::1") return privateOptIn;
  return isIP(address) !== 0 && !forbidden.check(address,family) && (privateOptIn || !privateRanges.check(address,family));
}
const callSchema = z.object({id:z.string().min(1).max(128),type:z.literal("function"),function:z.object({name:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),arguments:z.string().max(65536)}).strict()}).strict();
const responseSchema = z.object({choices:z.array(z.object({message:z.object({role:z.literal("assistant"),content:z.string().max(262144).nullable(),tool_calls:z.array(callSchema).max(16).optional()}).passthrough(),finish_reason:z.enum(["stop","tool_calls","length"])}).passthrough()).length(1),usage:z.object({prompt_tokens:z.number().int().nonnegative(),completion_tokens:z.number().int().nonnegative()}).passthrough().optional()}).passthrough();
/** Status bodies are only inspected for classification, never echoed into error messages. */
const contextOverflowPattern = /context[_ ]?length|context window|maximum context|prompt.{0,20}too long|too many (input )?tokens/i;

/** Classifies non-200 responses into distinct failure kinds without exposing body content. */
function rejectClassifiedStatus(response: IncomingMessage, reject: (error: Error) => void): void {
  const status = response.statusCode ?? 0;
  const finish = (error: Error) => { response.destroy(); reject(error); };
  if (status === 413) { finish(new ProviderContextOverflowError()); return; }
  if (status === 429) { finish(new ProviderRateLimitError()); return; }
  if (status === 400) {
    // Some providers report context overflow as 400 with a context-length error body; read a
    // bounded prefix purely to classify, then discard.
    let settled = false;
    const chunks: Buffer[] = []; let bytes = 0;
    const settle = (error: Error) => { if (settled) return; settled = true; finish(error); };
    response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes >= 16384) { settle(new ProviderTransportError()); return; } chunks.push(chunk); });
    response.on("end", () => { settle(contextOverflowPattern.test(Buffer.concat(chunks).toString("utf8")) ? new ProviderContextOverflowError() : new ProviderTransportError()); });
    response.on("error", () => settle(new ProviderTransportError()));
    response.on("aborted", () => settle(new ProviderTransportError()));
    return;
  }
  finish(new ProviderTransportError());
}

type ProviderTarget = { url: URL; addresses: { address: string; family: number }[] };

/** Shared endpoint policy + DNS pinning for every provider HTTP call (chat,
 * check, model listing): URL shape, forbidden/private ranges and the
 * loopback-HTTP opt-in are identical on all paths. */
async function resolveProviderTarget(config: ProviderConfig, combined: AbortSignal, pathSuffix: string): Promise<ProviderTarget> {
  const url = new URL(config.endpoint);
  if (url.username || url.password || url.hash || url.search || !["https:","http:"].includes(url.protocol)) throw new ProviderTransportError();
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  combined.throwIfAborted();
  let addresses: { address: string; family: number }[];
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    let onAbort: () => void = () => {};
    try {
      addresses = await Promise.race([
        lookup(hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new ProviderTransportError());
          combined.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      combined.removeEventListener("abort", onAbort);
    }
  }
  if (combined.aborted || !addresses.length || addresses.some(a=>!allowed(a.address,config.allowPrivateEndpoint === true))) throw new ProviderTransportError();
  if (url.protocol === "http:" && !(config.allowPrivateEndpoint && addresses.every(a=>a.address === "::1" || a.address.startsWith("127.")))) throw new ProviderTransportError();
  url.pathname = `${url.pathname.replace(/\/$/, "").replace(/\/v1$/, "")}${pathSuffix}`;
  return { url, addresses };
}

/** One authenticated provider JSON exchange (POST when a body is given, GET
 * otherwise) with pinned DNS, bounded response and classified failures. */
function providerJsonExchange(target: ProviderTarget, config: ProviderConfig, combined: AbortSignal, body?: string): Promise<string> {
  return new Promise<string>((resolve,reject)=>{
    const request = (target.url.protocol === "https:" ? httpsRequest : httpRequest)(target.url,{method: body === undefined ? "GET" : "POST",agent:false,signal:combined,lookup:(_host,options,callback)=>{
      // Resolve only to addresses already validated by the endpoint policy.
      const familyFiltered=options.family===4||options.family===6?target.addresses.filter(a=>a.family===options.family):[];
      const pinned=familyFiltered.length?familyFiltered:target.addresses;
      if(options.all) callback(null,pinned.map(a=>({address:a.address,family:a.family})));
      else { const first=pinned[0]!; callback(null,first.address,first.family); }
    },headers:{Authorization:`Bearer ${config.apiKey}`,...(body === undefined ? {} : {"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}),Accept:"application/json"}},response=>{
      if (response.statusCode !== 200) { rejectClassifiedStatus(response, reject); return; }
      if (!response.headers["content-type"]?.toLowerCase().includes("application/json")) { response.destroy(); reject(new ProviderTransportError()); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data",(chunk:Buffer)=>{bytes += chunk.length;if(bytes > PROVIDER_MAX_BODY_BYTES){reject(new ProviderProtocolError());response.destroy();}else chunks.push(chunk);});
      response.on("end",()=>resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error",()=>reject(new ProviderTransportError()));
      response.on("aborted",()=>reject(new ProviderTransportError()));
    });
    request.on("error",()=>reject(new ProviderTransportError()));
    if (body === undefined) request.end(); else request.end(body);
  });
}

export async function generateProviderRequest(config: ProviderConfig, messages: readonly ProviderMessage[], tools: readonly ProviderTool[], signal?: AbortSignal, options?: ProviderRequestOptions): Promise<ProviderResult> {
  if (!config.apiKey) throw new ProviderKeyRequiredError();
  if (tools.length > PROVIDER_MAX_TOOLS || messages.length > PROVIDER_MAX_MESSAGES || !config.model || config.model.length > 256) throw new ProviderProtocolError();
  normalizedMaxOutputTokens(options);
  const deadline = AbortSignal.timeout(60000);
  const combined = signal ? AbortSignal.any([signal,deadline]) : deadline;
  try {
    const target = await resolveProviderTarget(config, combined, "/v1/chat/completions");
    const body = serializeProviderRequestBody(config.model, messages, tools, options);
    if (Buffer.byteLength(body) > PROVIDER_MAX_BODY_BYTES) throw new ProviderProtocolError();
    const raw = await providerJsonExchange(target, config, combined, body);
    let decoded: unknown; try { decoded=JSON.parse(raw); } catch { throw new ProviderProtocolError(); }
    const parsed=responseSchema.safeParse(decoded); if(!parsed.success) throw new ProviderProtocolError();
    const choice=parsed.data.choices[0]!; const message=choice.message;
    if (choice.finish_reason === "length") throw new ProviderResponseTruncatedError();
    if ((choice.finish_reason === "tool_calls") !== Boolean(message.tool_calls?.length)) throw new ProviderProtocolError();
    const names=new Set(tools.map(t=>t.function.name)); const ids=new Set<string>();
    for(const call of message.tool_calls ?? []) { if(!names.has(call.function.name)||ids.has(call.id)) throw new ProviderProtocolError(); ids.add(call.id); try { const args:unknown=JSON.parse(call.function.arguments); if(!args||typeof args!=="object"||Array.isArray(args)) throw new Error(); } catch { throw new ProviderProtocolError(); } }
    const usage=parsed.data.usage;
    const assistant = {role:"assistant" as const,content:redactString(message.content ?? ""),...(message.tool_calls ? {toolCalls:message.tool_calls}:{})};
    const output = JSON.stringify(assistant);
    return {message:assistant,usage:usage?{inputTokens:usage.prompt_tokens,outputTokens:usage.completion_tokens,estimated:false}:{inputTokens:estimateTokens(body),outputTokens:estimateTokens(output),estimated:true}};
  } catch(error) { if(error instanceof ProviderProtocolError || error instanceof ProviderTransportError) throw error; throw new ProviderTransportError(); }
}

const modelsResponseSchema = z.object({ data: z.array(z.object({ id: z.string().min(1).max(256) }).passthrough()) }).passthrough();

/** Bounded GET /v1/models through the same endpoint policy as chat (docs/
 * ai-multi-provider-plan.md egress invariant). Returns at most 100 unique,
 * redacted model ids; never contacts anything but the pinned addresses. */
export async function fetchProviderModels(config: ProviderConfig, signal?: AbortSignal): Promise<string[]> {
  if (!config.apiKey) throw new ProviderKeyRequiredError();
  const deadline = AbortSignal.timeout(60000);
  const combined = signal ? AbortSignal.any([signal,deadline]) : deadline;
  try {
    const target = await resolveProviderTarget(config, combined, "/v1/models");
    const raw = await providerJsonExchange(target, config, combined);
    let decoded: unknown; try { decoded=JSON.parse(raw); } catch { throw new ProviderProtocolError(); }
    const parsed=modelsResponseSchema.safeParse(decoded); if(!parsed.success) throw new ProviderProtocolError();
    const seen=new Set<string>(); const models: string[]=[];
    for(const entry of parsed.data.data) {
      const id=redactString(entry.id).trim();
      if(!id || seen.has(id) || models.length >= 100) continue;
      seen.add(id); models.push(id);
    }
    if(!models.length) throw new ProviderProtocolError();
    return models;
  } catch(error) { if(error instanceof ProviderProtocolError || error instanceof ProviderTransportError) throw error; throw new ProviderTransportError(); }
}
export class AiProvider {
  generate(config:ProviderConfig,messages:readonly ProviderMessage[],tools:readonly ProviderTool[],signal?:AbortSignal,options?:ProviderRequestOptions):Promise<ProviderResult> { return generateProviderRequest(config,messages,tools,signal,options); }
  async check(config:ProviderConfig,signal?:AbortSignal):Promise<{ok:true}> {
    const result=await this.generate(config,[{role:"user",content:"Call flexserver_check with {ok:true}. No infrastructure data is provided."}],[{type:"function",function:{name:"flexserver_check",description:"Synthetic protocol check only",parameters:{type:"object",properties:{ok:{type:"boolean",const:true}},required:["ok"],additionalProperties:false}}}],signal);
    const calls=result.message.toolCalls;
    if(calls?.length!==1||calls[0]!.function.name!=="flexserver_check") throw new ProviderProtocolError();
    const args=JSON.parse(calls[0]!.function.arguments) as Record<string,unknown>;
    if(args.ok!==true || Object.keys(args).length!==1) throw new ProviderProtocolError();
    return {ok:true};
  }
}
