import { parseAllDocuments, visit, isAlias, isCollection } from "yaml";
import { BadRequestException } from "@nestjs/common";

const rootFields: Record<string,true> = { services:true, volumes:true, networks:true };
const serviceFields: Record<string,true> = Object.fromEntries(["image","command","entrypoint","environment","depends_on","profiles","restart","healthcheck","ports","expose","working_dir","user","read_only","init","cpus","mem_limit","pids_limit","stop_signal","stop_grace_period","tmpfs","volumes","networks","deploy"].map(k=>[k,true]));
const healthcheckFields: Record<string,true> = Object.fromEntries(["test","interval","timeout","retries","start_period"].map(k=>[k,true]));
const dependsFields: Record<string,true> = { condition:true };
const volumeFields: Record<string,true> = { type:true, source:true, target:true, read_only:true, bind:true, volume:true };
const bindFields: Record<string,true> = { create_host_path:true };
const mountedVolumeFields: Record<string,true> = { nocopy:true, subpath:true };
const networkFields: Record<string,true> = { aliases:true };
const portFields: Record<string,true> = Object.fromEntries(["mode","host_ip","target","published","protocol"].map(k=>[k,true]));
const environmentKeys = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export type ComposeModel = { services: Record<string, Record<string, unknown>>; volumes?: Record<string, unknown>; networks?: Record<string, unknown> };
function refuse(path: string): never { throw new BadRequestException({ error: { code: "unsupported_configuration", field: path } }); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(path);
  return value as Record<string, unknown>;
}
const string=(value:unknown,path:string,max:number)=>{if(typeof value!=="string"||!value||value.length>max||/[\x00-\x1f]/u.test(value))refuse(path);return value;};
const integer=(value:unknown,path:string,min:number,max:number)=>{if(!Number.isInteger(value)||typeof value!=="number"||value<min||value>max)refuse(path);return value;};
const duration=(value:unknown,path:string,max:string)=>{if(typeof value!=="string"||!/^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(value)||value.length>8)refuse(path);return value;};
function fields(value:unknown,allowed:Record<string,true>,path:string):Record<string,unknown>{const o=object(value,path);for(const key of Object.keys(o))if(!Object.hasOwn(allowed,key))refuse(`${path}.${key}`);return o;}
/** Data-only validation runs before any host file or Compose CLI access. */
export function validateComposeYaml(source: string, secretNames: readonly string[] = []): ComposeModel {
  if (Buffer.byteLength(source) > 262144 || source.includes("\0")) refuse("document");
  const documents = parseAllDocuments(source, { uniqueKeys: true, merge: false, customTags: [] });
  if (documents.length !== 1) refuse("document");
  const document = documents[0];
  if (document.errors.length) refuse("document");
  let aliases = 0;
  visit(document, { Node(_, node, ancestors) {
    if (ancestors.length > 32) refuse("document.depth");
    if (isAlias(node) && ++aliases > 50) refuse("document.aliases");
    if (node.tag && !node.tag.startsWith("tag:yaml.org,2002:")) refuse("document.tag");
    if (isCollection(node) && node.items.length > 1024) refuse("document.items");
  } });
  let decoded: unknown;
  try { decoded = document.toJS({ maxAliasCount: 50 }); } catch { refuse("document"); }
  const root = object(decoded, "document");
  for (const key of Object.keys(root)) if (!Object.hasOwn(rootFields,key)) refuse(key);
  const protectedNames = new Set(secretNames);
  const checkVisibleValue = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      const interpolation = value.replace(/\$\$/g, "");
      for (const match of interpolation.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (protectedNames.has(match[1] ?? match[2])) refuse(path);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) checkVisibleValue(item, path);
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        checkVisibleValue(key, path);
        checkVisibleValue(item, `${path}.${key}`);
      }
    }
  };
  for (const [section, value] of Object.entries(root)) {
    if (section !== "services") checkVisibleValue(value, section);
  }
  const services = object(root.services, "services");
  if (!Object.keys(services).length || Object.keys(services).length > 64) refuse("services");
  for (const [name, raw] of Object.entries(services)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(name)) refuse("services.name");
    const s = object(raw, `services.${name}`);
    for (const key of Object.keys(s)) if (!Object.hasOwn(serviceFields,key)) refuse(`services.${name}.${key}`);
    for (const [field, value] of Object.entries(s)) {
      if (["environment", "command", "entrypoint"].includes(field)) continue;
      if (field === "healthcheck" && value && typeof value === "object" && !Array.isArray(value)) {
        const { test: _protectedTest, ...visibleHealthcheck } = value as Record<string, unknown>;
        checkVisibleValue(visibleHealthcheck, `services.${name}.healthcheck`);
      } else checkVisibleValue(value, `services.${name}.${field}`);
    }
    string(s.image,`services.${name}.image`,512);
    for (const field of ["command", "entrypoint"] as const) if (s[field] !== undefined) { const value=s[field]; if (Array.isArray(value)) { if(value.length>256)refuse(`services.${name}.${field}`); for(const arg of value) string(arg,`services.${name}.${field}`,4096); } else string(value,`services.${name}.${field}`,4096); }
    if (s.restart !== undefined) { if(!["no","always","unless-stopped","on-failure"].includes(String(s.restart))) refuse(`services.${name}.restart`); }
    if (s.environment !== undefined) {
      if (Array.isArray(s.environment)) { if(s.environment.length>256) refuse("services.environment"); for(const e of s.environment){if(typeof e!=="string"||!e.includes("=")||!environmentKeys.test(e.slice(0,e.indexOf("="))))refuse(`services.${name}.environment`);} }
      else { const env=object(s.environment,`services.${name}.environment`);if(Object.keys(env).length>256)refuse(`services.${name}.environment`);for(const key of Object.keys(env)){if(!environmentKeys.test(key))refuse(`services.${name}.environment`);if(typeof env[key]!=="string")refuse(`services.${name}.environment`);} }
    }
    if (s.depends_on !== undefined) {
      if (Array.isArray(s.depends_on)) { } // simple list of existing services checked later
      else { const deps=object(s.depends_on,`services.${name}.depends_on`);if(Object.keys(deps).length>64)refuse(`services.${name}.depends_on`);for(const key of Object.keys(deps)){const depFields=fields(deps[key],dependsFields,`services.${name}.depends_on.${key}`);if(!["service_started","service_healthy","service_completed_successfully"].includes(String(depFields.condition)))refuse(`services.${name}.depends_on.condition`);} }
      if (!Array.isArray(s.depends_on) && s.depends_on !== null) for (const dep of Object.keys(s.depends_on)) if (typeof dep!=="string"||!Object.hasOwn(services,dep)) refuse(`services.${name}.depends_on`);
    }
    if (s.healthcheck !== undefined) {
      const h=fields(s.healthcheck,healthcheckFields,`services.${name}.healthcheck`);
      if (h.retries !== undefined) integer(h.retries,`services.${name}.healthcheck.retries`,1,64);
      for (const key of ["interval","timeout","start_period"]) if (h[key]!==undefined) duration(h[key],`services.${name}.healthcheck.${key}`,key);
      if (h.test!==undefined) { if(Array.isArray(h.test)){if(!h.test.length||h.test.length>32)refuse(`services.${name}.healthcheck.test`);for(const arg of h.test)string(arg,`services.${name}.healthcheck.test`,512);}else string(h.test,`services.${name}.healthcheck.test`,512); }
    }
    if (s.ports !== undefined) {
      if(!Array.isArray(s.ports)||s.ports.length>64)refuse(`services.${name}.ports`);
      for(const port of s.ports){
        if(typeof port==="string"){const p=port.split(":");if(p.length>3||p.some(x=>!x))refuse(`services.${name}.ports`);}
        else { const o=fields(port,portFields,`services.${name}.ports`); integer(o.target,`services.${name}.ports.target`,1,65535); if(o.published!==undefined){if(typeof o.published==="number")integer(o.published,`services.${name}.ports.published`,1,65535);else string(o.published,`services.${name}.ports.published`,64);} for(const key of ["host_ip","protocol","mode"])if(o[key]!==undefined)string(o[key],`services.${name}.ports.${key}`,64); }
      }
    }
    if (s.tmpfs !== undefined) { if(Array.isArray(s.tmpfs)){if(s.tmpfs.length>32)refuse(`services.${name}.tmpfs`);for(const t of s.tmpfs)string(t,`services.${name}.tmpfs`,256);}else string(s.tmpfs,`services.${name}.tmpfs`,256); }
    if (s.profiles !== undefined) { if(!Array.isArray(s.profiles)||s.profiles.length>64)refuse(`services.${name}.profiles`);for(const p of s.profiles)string(p,`services.${name}.profiles`,128); }
    for (const key of ["user","working_dir","stop_signal","stop_grace_period"]) if (s[key]!==undefined) string(s[key],`services.${name}.${key}`,256);
    if (s.init !== undefined && typeof s.init !== "boolean") refuse(`services.${name}.init`);
    if (s.read_only !== undefined && typeof s.read_only !== "boolean") refuse(`services.${name}.read_only`);
    if (s.cpus !== undefined && (typeof s.cpus !== "number" || !Number.isFinite(s.cpus) || s.cpus <= 0 || s.cpus > 1024)) refuse(`services.${name}.cpus`);
    for (const key of ["mem_limit","pids_limit"]) if (s[key]!==undefined && typeof s[key]!=="string" && typeof s[key]!=="number") refuse(`services.${name}.${key}`);
    if (s.volumes !== undefined) {
      if (!Array.isArray(s.volumes) || s.volumes.length > 64) refuse(`services.${name}.volumes`);
      for (const mount of s.volumes) {
        // Bind identity is host-verified later; accept only structured binds.
        if (typeof mount === "string") {
          const parts = mount.split(":");
          if (parts.length < 2 || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(parts[0]) || !parts[1].startsWith("/")) refuse(`services.${name}.volumes`);
        } else {
          const m = object(mount, `services.${name}.volumes`);
          for (const key of Object.keys(m)) if (!Object.hasOwn(volumeFields,key)) refuse(`services.${name}.volumes.${key}`);
          if (!["volume", "bind"].includes(String(m.type)) || typeof m.source !== "string" || typeof m.target !== "string" || !m.target.startsWith("/")) refuse(`services.${name}.volumes`);
          if (m.read_only !== undefined && typeof m.read_only !== "boolean") refuse(`services.${name}.volumes.read_only`);
          if (m.type === "bind" && (object(m.bind, `services.${name}.volumes.bind`).create_host_path !== false || Object.keys(object(m.bind, `services.${name}.volumes.bind`)).some(k=>k!=="create_host_path"))) refuse(`services.${name}.volumes.bind`);
          if (m.type === "volume" && m.volume !== undefined) { const v=fields(m.volume,mountedVolumeFields,`services.${name}.volumes.volume`); if(v.nocopy!==undefined&&typeof v.nocopy!=="boolean")refuse(`services.${name}.volumes.volume.nocopy`); if(v.subpath!==undefined)string(v.subpath,`services.${name}.volumes.volume.subpath`,256); }
        }
      }
    }
    if (s.networks !== undefined) {
      if(Array.isArray(s.networks)){if(s.networks.length>32)refuse(`services.${name}.networks`);}else{const nets=object(s.networks,`services.${name}.networks`);if(Object.keys(nets).length>32)refuse(`services.${name}.networks`);for(const key of Object.keys(nets)){const n=fields(nets[key],networkFields,`services.${name}.networks.${key}`);for(const alias of Array.isArray(n.aliases)?n.aliases:[])string(alias,`services.${name}.networks.aliases`,64);}}
    }
    if (s.deploy !== undefined) {
      const deploy = object(s.deploy, "deploy");
      for (const key of Object.keys(deploy)) if (!["replicas", "resources"].includes(key)) refuse(`services.${name}.deploy.${key}`);
      if (deploy.replicas !== undefined) integer(deploy.replicas, `services.${name}.deploy.replicas`, 1, 100);
      if (deploy.resources !== undefined) {const r=object(deploy.resources,`services.${name}.deploy.resources`);for(const key of Object.keys(r))if(!["limits","reservations"].includes(key))refuse(`services.${name}.deploy.resources.${key}`);for(const key of["limits","reservations"])if(r[key]!==undefined){const b=object(r[key],`services.${name}.deploy.resources.${key}`);for(const sub of Object.keys(b))if(!["cpus","memory"].includes(sub))refuse(`services.${name}.deploy.resources.${key}.${sub}`);for(const sub of["cpus","memory"])if(b[sub]!==undefined)string(b[sub],`services.${name}.deploy.resources.${key}.${sub}`,32);}}
    }
  }
  for (const section of ["volumes", "networks"] as const) if (root[section] !== undefined) {
    for (const [name, raw] of Object.entries(object(root[section],section))) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(name)) refuse(section);
      if (raw === null) continue;
      const resource = object(raw,section);
      if (Object.keys(resource).some(k => !["external", "name"].includes(k)) || (resource.name !== undefined && resource.external !== true)) refuse(`${section}.${name}`);
    }
  }
  const state:Record<string, 0|1|2>={};
  const emptyService:Record<string, unknown>={};
  const visitService=(name:string)=>{if(state[name]===1)refuse(`services.${name}.depends_on.cycle`);if(state[name]===2)return;state[name]=1;const service:Record<string, unknown>=object(services[name]??emptyService,`services.${name}`);for(const dep of dependsOn(service))visitService(dep);state[name]=2;};
  for(const name of Object.keys(services))visitService(name);
  return root as ComposeModel;
}
function dependsOn(s:Record<string,unknown>):string[]{const d=s?.depends_on;return Array.isArray(d)?d.filter(x=>typeof x==="string") as string[]:d&&typeof d==="object"?Object.keys(d):[];}
