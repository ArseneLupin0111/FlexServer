import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AiProvider, ProviderProtocolError, ProviderTransportError, type ProviderConfig } from "../src/ai/ai-provider.js";
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
    {...valid,choices:[{...valid.choices[0],finish_reason:"length"}]},
    {...valid,choices:[{message:{role:"assistant",content:null,tool_calls:[{id:"c",type:"function",function:{name:"unauthorized",arguments:"{}"}}]},finish_reason:"tool_calls"}]},
    {...valid,usage:{prompt_tokens:-1,completion_tokens:1}},
    {...valid,choices:[{message:{role:"assistant",content:null,tool_calls:[{id:"c",type:"function",function:{name:"flexserver_check",arguments:"[]"}}]},finish_reason:"tool_calls"}]},
  ])("rejects invalid or unauthorized response %#",async body=>{
    await expect(new AiProvider().check(await provider(body))).rejects.toBeInstanceOf(ProviderProtocolError);
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
