import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { z } from "zod";
import { redactString } from "../common/redaction.js";
export type ProviderConfig = { endpoint: string; model: string; apiKey: string; allowPrivateEndpoint?: boolean };
export type ProviderToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ProviderMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; toolCalls?: ProviderToolCall[]; toolCallId?: string; name?: string };
export type ProviderTool = { type: "function"; function: { name: string; description: string; parameters: object } };
export type UsageInfo = { inputTokens: number; outputTokens: number; estimated: boolean };
export type ProviderResult = { message: ProviderMessage; usage: UsageInfo };
export class ProviderProtocolError extends Error { readonly code = "provider_protocol_error"; constructor() { super("Invalid provider response"); this.name = "ProviderProtocolError"; } }
export class ProviderTransportError extends Error { readonly code = "provider_unavailable"; constructor() { super("Provider request unavailable"); this.name = "ProviderTransportError"; } }
export class ProviderKeyRequiredError extends Error { readonly code = "provider_key_required"; constructor() { super("Provider key required"); this.name = "ProviderKeyRequiredError"; } }

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
const responseSchema = z.object({choices:z.array(z.object({message:z.object({role:z.literal("assistant"),content:z.string().max(262144).nullable(),tool_calls:z.array(callSchema).max(16).optional()}).passthrough(),finish_reason:z.enum(["stop","tool_calls"])}).passthrough()).length(1),usage:z.object({prompt_tokens:z.number().int().nonnegative(),completion_tokens:z.number().int().nonnegative()}).passthrough().optional()}).passthrough();

export async function generateProviderRequest(config: ProviderConfig, messages: readonly ProviderMessage[], tools: readonly ProviderTool[], signal?: AbortSignal): Promise<ProviderResult> {
  if (!config.apiKey) throw new ProviderKeyRequiredError();
  if (tools.length > 32 || messages.length > 128 || !config.model || config.model.length > 256) throw new ProviderProtocolError();
  const deadline = AbortSignal.timeout(60000);
  const combined = signal ? AbortSignal.any([signal,deadline]) : deadline;
  try {
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
    url.pathname = `${url.pathname.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/chat/completions`;
    const body = JSON.stringify({model:config.model,stream:false,messages:messages.map(m=>({role:m.role,content:m.content,...(m.toolCalls ? {tool_calls:m.toolCalls}:{}),...(m.toolCallId ? {tool_call_id:m.toolCallId}:{}),...(m.name ? {name:m.name}:{})})),...(tools.length ? {tools}:{}),max_tokens:2048});
    if (Buffer.byteLength(body) > 1024*1024) throw new ProviderProtocolError();
    const raw = await new Promise<string>((resolve,reject)=>{
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url,{method:"POST",agent:false,signal:combined,lookup:(_host,options,callback)=>{
            // Resolve only to addresses already validated by the endpoint policy.
            const familyFiltered=options.family===4||options.family===6?addresses.filter(a=>a.family===options.family):[];
            const pinned=familyFiltered.length?familyFiltered:addresses;
            if(options.all) callback(null,pinned.map(a=>({address:a.address,family:a.family})));
            else { const first=pinned[0]!; callback(null,first.address,first.family); }
          },headers:{Authorization:`Bearer ${config.apiKey}`,"Content-Type":"application/json","Content-Length":Buffer.byteLength(body),Accept:"application/json"}},response=>{
        if (response.statusCode !== 200 || !response.headers["content-type"]?.toLowerCase().includes("application/json")) { response.destroy(); reject(new ProviderTransportError()); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        response.on("data",(chunk:Buffer)=>{bytes += chunk.length;if(bytes > 1024*1024){reject(new ProviderProtocolError());response.destroy();}else chunks.push(chunk);});
        response.on("end",()=>resolve(Buffer.concat(chunks).toString("utf8")));
        response.on("error",()=>reject(new ProviderTransportError()));
        response.on("aborted",()=>reject(new ProviderTransportError()));
      });
      request.on("error",()=>reject(new ProviderTransportError())); request.end(body);
    });
    let decoded: unknown; try { decoded=JSON.parse(raw); } catch { throw new ProviderProtocolError(); }
    const parsed=responseSchema.safeParse(decoded); if(!parsed.success) throw new ProviderProtocolError();
    const choice=parsed.data.choices[0]!; const message=choice.message;
    if ((choice.finish_reason === "tool_calls") !== Boolean(message.tool_calls?.length)) throw new ProviderProtocolError();
    const names=new Set(tools.map(t=>t.function.name)); const ids=new Set<string>();
    for(const call of message.tool_calls ?? []) { if(!names.has(call.function.name)||ids.has(call.id)) throw new ProviderProtocolError(); ids.add(call.id); try { const args:unknown=JSON.parse(call.function.arguments); if(!args||typeof args!=="object"||Array.isArray(args)) throw new Error(); } catch { throw new ProviderProtocolError(); } }
    const usage=parsed.data.usage;
    return {message:{role:"assistant",content:redactString(message.content ?? ""),...(message.tool_calls ? {toolCalls:message.tool_calls}:{})},usage:usage?{inputTokens:usage.prompt_tokens,outputTokens:usage.completion_tokens,estimated:false}:{inputTokens:Math.ceil(Buffer.byteLength(body)/4),outputTokens:Math.ceil(Buffer.byteLength(raw)/4),estimated:true}};
  } catch(error) { if(error instanceof ProviderProtocolError || error instanceof ProviderTransportError) throw error; throw new ProviderTransportError(); }
}
export class AiProvider {
  generate(config:ProviderConfig,messages:readonly ProviderMessage[],tools:readonly ProviderTool[],signal?:AbortSignal):Promise<ProviderResult> { return generateProviderRequest(config,messages,tools,signal); }
  async check(config:ProviderConfig,signal?:AbortSignal):Promise<{ok:true}> {
    const result=await this.generate(config,[{role:"user",content:"Call flexserver_check with {ok:true}. No infrastructure data is provided."}],[{type:"function",function:{name:"flexserver_check",description:"Synthetic protocol check only",parameters:{type:"object",properties:{ok:{type:"boolean",const:true}},required:["ok"],additionalProperties:false}}}],signal);
    const calls=result.message.toolCalls;
    if(calls?.length!==1||calls[0]!.function.name!=="flexserver_check") throw new ProviderProtocolError();
    const args=JSON.parse(calls[0]!.function.arguments) as Record<string,unknown>;
    if(args.ok!==true || Object.keys(args).length!==1) throw new ProviderProtocolError();
    return {ok:true};
  }
}
