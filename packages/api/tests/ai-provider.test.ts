import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AiProvider, ProviderContextOverflowError, ProviderProtocolError, ProviderRateLimitError, ProviderResponseTruncatedError, ProviderTransportError, PROVIDER_MAX_BODY_BYTES, PROVIDER_MAX_MESSAGES, PROVIDER_SUMMARY_MAX_OUTPUT_TOKENS, estimateTokens, measureProviderRequest, serializeProviderRequestBody, type ProviderConfig, type ProviderMessage } from "../src/ai/ai-provider.js";
import { decryptAiSecret, encryptAiSecret, rewrapAiEnvelope, type AiAadContext } from "../src/ai/ai-crypto.js";
import type { Keyring } from "../src/ssh/key-encryption.js";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())))); });
async function provider(body: unknown, status = 200): Promise<ProviderConfig> {
  const server = createServer((request,response) => { request.resume(); response.writeHead(status,{"Content-Type":"application/json",Location:"http://169.254.169.254/"}); response.end(JSON.stringify(body)); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address=server.address(); if(!address || typeof address==="string") throw new Error("Missing listener");
  return {endpoint:`http://127.0.0.1:${address.port}`,apiKey:"synthetic-test-key",model:"synthetic",allowPrivateEndpoint:true};
}
const valid = {choices:[{message:{role:"assistant",content:null,tool_calls:[{id:"call-1",type:"function",function:{name:"flexserver_check",arguments:'{"ok":true}'}}]},finish_reason:"tool_calls"}],usage:{prompt_tokens:12,completion_tokens:4}};

describe("AI provider safety",()=>{
  it("accepts a synthetic tool-call check and preserves measured usage",async()=>{
    const config=await provider(valid);
    expect(await new AiProvider().check(config)).toEqual({ok:true});
    const result=await new AiProvider().generate(config,[{role:"user",content:"check"}],[{type:"function",function:{name:"flexserver_check",description:"check",parameters:{type:"object"}}}]);
    expect(result.usage).toEqual({inputTokens:12,outputTokens:4,estimated:false});
  });
  it("charges conservative prompt and assistant output estimates when usage is missing", async () => {
    const messages: ProviderMessage[] = [{ role: "user", content: "請檢查磁碟使用量".repeat(20) }];
    const content = "磁碟空間不足".repeat(25);
    const config = await provider({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
    const result = await new AiProvider().generate(config, messages, []);
    expect(result.usage.estimated).toBe(true);
    expect(result.usage.inputTokens).toBe(measureProviderRequest(config.model, messages, []).estimatedPromptTokens);
    expect(result.usage.outputTokens).toBe(estimateTokens(JSON.stringify(result.message)));
    expect(result.usage.outputTokens).toBeGreaterThan(Math.ceil(Buffer.byteLength(content) / 4));
  });
  it("rejects loopback without explicit opt-in before connection",async()=>{
    const config=await provider(valid); config.allowPrivateEndpoint=false;
    await expect(new AiProvider().check(config)).rejects.toBeInstanceOf(ProviderTransportError);
  });
  it.each(["http://169.254.169.254","http://[fd00:ec2::254]","http://[::ffff:127.0.0.1]","https://[::127.0.0.1]","https://[64:ff9b:1::a9fe:a9fe]","https://[fec0::1]","https://[2001::1]"])("always rejects forbidden endpoint %s",async endpoint=>{
    await expect(new AiProvider().check({endpoint,apiKey:"secret",model:"test",allowPrivateEndpoint:true})).rejects.toBeInstanceOf(ProviderTransportError);
  });
  it("does not follow redirects or expose their body",async()=>{
    const config=await provider({error:"synthetic-test-key"},302);
    await expect(new AiProvider().check(config)).rejects.toThrow("Provider request unavailable");
  });
  it("rejects pre-cancelled inference without dispatch", async () => {
    const config = await provider(valid);
    const controller = new AbortController(); controller.abort();
    await expect(new AiProvider().check(config, controller.signal)).rejects.toBeInstanceOf(ProviderTransportError);
  });
  it("rejects oversized provider output", async () => {
    const config = await provider({ payload: "x".repeat(1024 * 1024) });
    await expect(new AiProvider().check(config)).rejects.toBeInstanceOf(ProviderProtocolError);
  });
  it.each([
    {...valid,choices:[{message:{role:"assistant",content:null,tool_calls:[{id:"c",type:"function",function:{name:"unauthorized",arguments:"{}"}}]},finish_reason:"tool_calls"}]},
    {...valid,usage:{prompt_tokens:-1,completion_tokens:1}},
    {...valid,choices:[{message:{role:"assistant",content:null,tool_calls:[{id:"c",type:"function",function:{name:"flexserver_check",arguments:"[]"}}]},finish_reason:"tool_calls"}]},
  ])("rejects invalid or unauthorized response %#",async body=>{
    await expect(new AiProvider().check(await provider(body))).rejects.toBeInstanceOf(ProviderProtocolError);
  });
});

async function failureOf(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { return error as Error; }
  throw new Error("expected the provider call to fail");
}
async function countingProvider(status: number, body: unknown): Promise<{ config: ProviderConfig; requests: () => number }> {
  let count = 0;
  const server = createServer((request,response) => { count++; request.resume(); response.writeHead(status,{"Content-Type":"application/json"}); response.end(JSON.stringify(body)); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address=server.address(); if(!address || typeof address==="string") throw new Error("Missing listener");
  return { config:{endpoint:`http://127.0.0.1:${address.port}`,apiKey:"synthetic-test-key",model:"synthetic",allowPrivateEndpoint:true}, requests: () => count };
}
async function capturingProvider(responseBody: unknown = valid): Promise<{ config: ProviderConfig; bodies: () => string[] }> {
  const received: string[] = [];
  const server = createServer((request,response) => {
    const chunks: Buffer[] = [];
    request.on("data",(chunk:Buffer)=>chunks.push(chunk));
    request.on("end",()=>{ received.push(Buffer.concat(chunks).toString("utf8")); response.writeHead(200,{"Content-Type":"application/json"}); response.end(JSON.stringify(responseBody)); });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address=server.address(); if(!address || typeof address==="string") throw new Error("Missing listener");
  return { config:{endpoint:`http://127.0.0.1:${address.port}`,apiKey:"synthetic-test-key",model:"synthetic",allowPrivateEndpoint:true}, bodies: () => received };
}

describe("AI provider failure classification",()=>{
  it("classifies HTTP 413 as context overflow, distinct from transport and protocol",async()=>{
    const error = await failureOf(new AiProvider().generate(await provider({error:"request entity too large"},413),[{role:"user",content:"check"}],[]));
    expect(error).toBeInstanceOf(ProviderContextOverflowError);
    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).not.toBeInstanceOf(ProviderProtocolError);
    expect(error.code).toBe("provider_context_overflow");
    expect(error.message).not.toContain("request entity too large");
  });
  it("classifies a provider context-length error body as context overflow",async()=>{
    const body = {error:{code:"context_length_exceeded",message:"This model's maximum context length is 8192 tokens. However, you requested 20000 tokens."}};
    const error = await failureOf(new AiProvider().generate(await provider(body,400),[{role:"user",content:"check"}],[]));
    expect(error).toBeInstanceOf(ProviderContextOverflowError);
    expect(error.code).toBe("provider_context_overflow");
  });
  it("keeps unrelated 400 and 5xx failures as transport failures",async()=>{
    const badRequest = await failureOf(new AiProvider().generate(await provider({error:"invalid model"},400),[{role:"user",content:"check"}],[]));
    expect(badRequest).toBeInstanceOf(ProviderTransportError);
    expect(badRequest).not.toBeInstanceOf(ProviderContextOverflowError);
    const serverError = await failureOf(new AiProvider().generate(await provider({error:"boom"},500),[{role:"user",content:"check"}],[]));
    expect(serverError).toBeInstanceOf(ProviderTransportError);
    expect(serverError).not.toBeInstanceOf(ProviderContextOverflowError);
  });
  it("classifies HTTP 429 as rate limiting, separate from context overflow and protocol",async()=>{
    const error = await failureOf(new AiProvider().generate(await provider({error:"rate limited"},429),[{role:"user",content:"check"}],[]));
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toBeInstanceOf(ProviderTransportError);
    expect(error).not.toBeInstanceOf(ProviderContextOverflowError);
    expect(error).not.toBeInstanceOf(ProviderProtocolError);
    expect(error.code).toBe("provider_rate_limit");
  });
  it("classifies finish_reason length as truncated output so summaries are never accepted",async()=>{
    const truncated = {...valid,choices:[{...valid.choices[0],finish_reason:"length",message:{role:"assistant",content:"Tóm tắt bị cắt ngắn"}}]};
    const error = await failureOf(new AiProvider().generate(await provider(truncated),[{role:"user",content:"summarize"}],[]));
    expect(error).toBeInstanceOf(ProviderResponseTruncatedError);
    expect(error).toBeInstanceOf(ProviderProtocolError);
    expect(error).not.toBeInstanceOf(ProviderTransportError);
    expect(error.code).toBe("provider_response_truncated");
  });
  it("still rejects truncated output when tool calls were cut off mid-round",async()=>{
    const truncated = {...valid,choices:[{...valid.choices[0],finish_reason:"length"}]};
    const error = await failureOf(new AiProvider().generate(await provider(truncated),[{role:"user",content:"check"}],[]));
    expect(error).toBeInstanceOf(ProviderResponseTruncatedError);
  });
});

describe("AI provider request caps and preflight measurement",()=>{
  it(`rejects more than ${PROVIDER_MAX_MESSAGES} messages without any network dispatch`,async()=>{
    const { config, requests } = await countingProvider(200,valid);
    const messages = Array.from({length: PROVIDER_MAX_MESSAGES + 1},() => ({role:"user",content:"x"}) as ProviderMessage);
    const error = await failureOf(new AiProvider().generate(config,messages,[]));
    expect(error).toBeInstanceOf(ProviderProtocolError);
    expect(requests()).toBe(0);
  });
  it("rejects more than 32 tools without any network dispatch",async()=>{
    const { config, requests } = await countingProvider(200,valid);
    const tools = Array.from({length:33},(_,index)=>({type:"function" as const,function:{name:`tool_${index}`,description:"d",parameters:{type:"object"}}}));
    const error = await failureOf(new AiProvider().generate(config,[{role:"user",content:"x"}],tools));
    expect(error).toBeInstanceOf(ProviderProtocolError);
    expect(requests()).toBe(0);
  });
  it(`rejects serialized request bodies over ${PROVIDER_MAX_BODY_BYTES} bytes without any network dispatch`,async()=>{
    const { config, requests } = await countingProvider(200,valid);
    const error = await failureOf(new AiProvider().generate(config,[{role:"user",content:"x".repeat(PROVIDER_MAX_BODY_BYTES)}],[]));
    expect(error).toBeInstanceOf(ProviderProtocolError);
    expect(requests()).toBe(0);
  });
  it("measures the exact serialized bytes the provider receives, with the default output cap",async()=>{
    const { config, bodies } = await capturingProvider();
    const messages: ProviderMessage[] = [{role:"system",content:"Bạn là trợ lý VPS."},{role:"user",content:"kiểm tra trạng thái máy chủ"}];
    const tools = [{type:"function",function:{name:"flexserver_check",description:"check",parameters:{type:"object"}}}];
    const measure = measureProviderRequest("synthetic",messages,tools);
    expect(measure.messageCount).toBe(2);
    expect(measure.toolCount).toBe(1);
    expect(measure.maxOutputTokens).toBe(2048);
    await new AiProvider().generate(config,messages,tools);
    const [sent] = bodies();
    expect(sent).toBeDefined();
    expect(Buffer.byteLength(sent!)).toBe(measure.bodyBytes);
    expect(JSON.parse(sent!)).toEqual(JSON.parse(serializeProviderRequestBody("synthetic",messages,tools)));
  });
  it("supports the bounded summary output cap and rejects invalid output caps preflight",async()=>{
    const { config, bodies } = await capturingProvider({choices:[{message:{role:"assistant",content:"Đã tóm tắt cuộc hội thoại."},finish_reason:"stop"}],usage:{prompt_tokens:40,completion_tokens:12}});
    const summary = await new AiProvider().generate(config,[{role:"user",content:"tóm tắt"}],[],undefined,{maxOutputTokens: PROVIDER_SUMMARY_MAX_OUTPUT_TOKENS});
    expect(summary.usage).toEqual({inputTokens:40,outputTokens:12,estimated:false});
    expect(JSON.parse(bodies()[0]!).max_tokens).toBe(PROVIDER_SUMMARY_MAX_OUTPUT_TOKENS);
    expect(() => measureProviderRequest("synthetic",[{role:"user",content:"x"}],[],{maxOutputTokens: 0})).toThrow(ProviderProtocolError);
    expect(() => measureProviderRequest("synthetic",[{role:"user",content:"x"}],[],{maxOutputTokens: 2049})).toThrow(ProviderProtocolError);
    const { config: strictConfig, requests } = await countingProvider(200,{choices:[{message:{role:"assistant",content:"ok"},finish_reason:"stop"}]});
    const error = await failureOf(new AiProvider().generate(strictConfig,[{role:"user",content:"x"}],[],undefined,{maxOutputTokens: 5000}));
    expect(error).toBeInstanceOf(ProviderProtocolError);
    expect(requests()).toBe(0);
  });
  it("measures oversized inputs so preflight can detect breaches before dispatch",async()=>{
    const messages = Array.from({length: PROVIDER_MAX_MESSAGES + 1},() => ({role:"user",content:"x".repeat(9000)}) as ProviderMessage);
    const measure = measureProviderRequest("synthetic",messages,[]);
    expect(measure.messageCount).toBe(PROVIDER_MAX_MESSAGES + 1);
    expect(measure.bodyBytes).toBeGreaterThan(PROVIDER_MAX_BODY_BYTES);
  });
});

describe("AI provider token estimation",()=>{
  it("never returns an exact or underestimated count for ASCII text",()=>{
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("x".repeat(400))).toBe(100);
    expect(estimateTokens("abcdefgh")).toBe(2);
  });
  it("counts dense CJK text as at least one token per character",()=>{
    const cjk = "サーバーを確認しています".repeat(100);
    expect(estimateTokens(cjk)).toBeGreaterThanOrEqual([...cjk].length);
    expect(estimateTokens(cjk)).toBeGreaterThan(Math.ceil(Buffer.byteLength(cjk,"utf8")/4));
  });
  it("applies a safer divisor for Vietnamese diacritic text",()=>{
    const vietnamese = "Tôi cần kiểm tra trạng thái của máy chủ ảo hóa trước khi triển khai.";
    const bytes = Buffer.byteLength(vietnamese,"utf8");
    expect(estimateTokens(vietnamese)).toBe(Math.ceil(bytes/3));
    expect(estimateTokens(vietnamese)).toBeGreaterThan(Math.ceil(bytes/4));
    expect(estimateTokens(vietnamese)).toBeGreaterThanOrEqual(vietnamese.split(/\s+/).length);
  });
  it("keeps plain bytes/4 for diacritic-free text and blends mixed scripts",()=>{
    const plain = "check the server status now please";
    expect(estimateTokens(plain)).toBe(Math.ceil(Buffer.byteLength(plain,"utf8")/4));
    const mixed = "hãy chạy lệnh trừ khi 日本語 instructions say otherwise";
    const cjkChars = [...mixed].filter(c=>{const code=c.codePointAt(0)!;return code>=0x2e80&&code<=0xa4cf;}).length;
    expect(estimateTokens(mixed)).toBeGreaterThanOrEqual(cjkChars);
  });
});

describe("AI provider hostname transport",()=>{
  async function hostnameProvider(body: unknown): Promise<ProviderConfig> {
    const serve=()=>createServer((request,response)=>{request.resume();response.writeHead(200,{"Content-Type":"application/json"});response.end(JSON.stringify(body));});
    const ipv6=serve(), ipv4=serve(); servers.push(ipv4);
    let port=0;
    await new Promise<void>(resolve=>{
      const degraded=()=>{ipv6.off("error",degraded);resolve();};
      ipv6.once("error",degraded);
      ipv6.listen({port:0,host:"::1",ipv6Only:true},()=>{servers.push(ipv6);ipv6.off("error",degraded);const bound=ipv6.address();if(bound&&typeof bound!=="string")port=bound.port;resolve();});
    });
    await new Promise<void>((resolve,reject)=>{
      ipv4.once("error",reject);
      ipv4.listen({port,host:"127.0.0.1"},()=>{ipv4.off("error",reject);resolve();});
    });
    const address=ipv4.address(); if(!address||typeof address==="string") throw new Error("Missing listener");
    return {endpoint:`http://localhost:${address.port}`,apiKey:"synthetic-test-key",model:"synthetic",allowPrivateEndpoint:true};
  }
  it("pins hostname resolution through the lookup callback under modern autoSelectFamily defaults",async()=>{
    const config=await hostnameProvider(valid);
    const previous=getDefaultAutoSelectFamily(); setDefaultAutoSelectFamily(true);
    try { expect(await new AiProvider().check(config)).toEqual({ok:true}); }
    finally { setDefaultAutoSelectFamily(previous); }
  });
  it("rejects hostname loopback without explicit opt-in before connection",async()=>{
    const config=await hostnameProvider(valid); config.allowPrivateEndpoint=false;
    const previous=getDefaultAutoSelectFamily(); setDefaultAutoSelectFamily(true);
    try { await expect(new AiProvider().check(config)).rejects.toBeInstanceOf(ProviderTransportError); }
    finally { setDefaultAutoSelectFamily(previous); }
  });
});

describe("AI envelope identity",()=>{
  const context:AiAadContext={vpsId:"vps-a",taskId:"task-a",field:"executionPayload",version:1};
  it.each([{...context,vpsId:"vps-b"},{...context,taskId:"task-b"},{...context,field:"providerApiKey" as const},{...context,version:2}])("rejects cross-context substitution %#",other=>{
    const keys:Keyring={version:1,activeKekId:"one",keys:{one:randomBytes(32).toString("base64")}};
    const envelope=encryptAiSecret("exact approved script",context,keys);
    expect(()=>decryptAiSecret(envelope,other,keys)).toThrow();
  });
  it("rotates wrapping key without invalidating payload recovery",()=>{
    const keys:Keyring={version:1,activeKekId:"one",keys:{one:randomBytes(32).toString("base64"),two:randomBytes(32).toString("base64")}};
    const envelope=encryptAiSecret("exact approved script",context,keys); keys.activeKekId="two";
    const rotated=rewrapAiEnvelope(envelope,context,keys);
    expect(rotated.encryptedKey).toEqual(envelope.encryptedKey);
    expect(decryptAiSecret(rotated,context,{...keys,keys:{two:keys.keys.two!}})).toBe("exact approved script");
    expect(()=>decryptAiSecret(envelope,context,{...keys,keys:{two:keys.keys.two!}})).toThrow();
  });
});
