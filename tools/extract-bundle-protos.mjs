#!/usr/bin/env node
// Wirecat extractor: protobuf-es generated code in a JS bundle -> typed catalog.
// Usage: node tools/extract-bundle-protos.mjs <bundle.js> [bundle2.js ...] --out catalog.json
//
// Recognizes generated shapes:
//   <ns>.makeMessageType("<pkg.Type>", () => [ {no,name,kind,T,V,K,L,repeated,opt,req,delimited,oneof,jsonName} ... ])
//   <ns>.makeEnum("<pkg.Type>", [ {no,name,localName} ... ])
//   { typeName: "<pkg.Service>", methods: { key: {name,I,O,kind} ... } }   (protobuf-es GenService literal)
//   <ns>.makeService / fileGen registration variants are caught generically.
// Method I/O and message/enum field references are bare identifiers resolved
// through an ident -> typeName binding map built from makeMessageType/makeEnum
// and simple alias assignments (A=B).

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const SCALAR = {
  1: "double", 2: "float", 3: "int64", 4: "uint64", 5: "int32",
  6: "fixed64", 7: "fixed32", 8: "bool", 9: "string", 10: "group",
  11: "message", 12: "bytes", 13: "uint32", 14: "enum", 15: "sfixed32",
  16: "sfixed64", 17: "sint32", 18: "sint64",
};
const METHOD_KIND = {
  "Unary": "unary", "ServerStreaming": "server_streaming",
  "ClientStreaming": "client_streaming", "BiDiStreaming": "bidi_streaming",
};

// ---- balanced-scan helpers -------------------------------------------------
function findBalanced(s, open, openCh, closeCh) {
  let depth = 0, inStr = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === openCh) depth++;
    else if (c === closeCh) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function splitTop(body, sep = ",") {
  const out = [];
  let depth = 0, inStr = null, start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) { if (c === "\\") i++; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === sep && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
  }
  const last = body.slice(start).trim();
  if (last) out.push(last);
  return out;
}

// Parse a JS object literal body (inner text, no braces) into a flat map of
// key -> raw value text at top level. Values that are nested objects/arrays
// are kept raw.
function parseObjectBody(body) {
  const map = {};
  for (const part of splitTop(body)) {
    const m = part.match(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*)|(\d+))\s*:\s*([\s\S]*)$/);
    if (!m) continue;
    map[m[1] ?? m[2] ?? m[3] ?? m[4]] = m[5].trim();
  }
  return map;
}

const str = (v) => (v ? v.replace(/^["']|["']$/g, "") : undefined);
const ident = (v) => (v && /^[A-Za-z_$][\w$]*$/.test(v) ? v : undefined);

// ---- extraction ------------------------------------------------------------
export function extractFromSource(src, fileLabel) {
  const messages = {};
  const enums = {};
  const services = {};
  const bindings = {}; // ident -> typeName

  const unresolvedIdents = new Set();
  const notes = [];

  // pass 1: bindings from makeMessageType / makeEnum (and simple aliases)
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*[\w$]+\.makeMessageType\s*\(\s*["'`]([^"'`]+)["'`]/g))
    bindings[m[1]] = m[2];
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*[\w$]+\.makeEnum\s*\(\s*["'`]([^"'`]+)["'`]/g))
    bindings[m[1]] = m[2];
  // class-bound GenMessage/GenEnum statics: Ident.typeName="<pkg.Type>"
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\.typeName\s*=\s*["'`]([^"'`]+)["'`]/g))
    bindings[m[1]] = m[2];
  // aliases: A=B where B is bound (single pass is enough for direct aliases)
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b/g)) {
    if (!(m[1] in bindings) && m[2] in bindings) bindings[m[1]] = bindings[m[2]];
  }
  // namespace member exports: Ns.Prop=Ident (webpack `t.FooRequest=I` style) where
  // Ident is a minified class var reused across messages. Codegen emits the export
  // first and `Ident.typeName="..."` right after, so pair each export with the
  // NEXT typeName assignment for that ident. prop -> typeName, or null on conflict.
  const tnEvents = [...src.matchAll(/\b([A-Za-z_$][\w$]*)\.typeName\s*=\s*["'`]([^"'`]+)["'`]/g)]
    .map((m) => ({ idx: m.index, ident: m[1], tn: m[2] }));
  const memberBindings = {};
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b/g)) {
    if (m[1] === m[3] || m[2] === "typeName") continue;
    const next = tnEvents.find((e) => e.ident === m[3] && e.idx > m.index && e.idx - m.index < 10000);
    if (!next) continue;
    if (m[2] in memberBindings && memberBindings[m[2]] !== next.tn) memberBindings[m[2]] = null;
    else memberBindings[m[2]] = next.tn;
  }

  const resolve = (raw) => {
    if (raw === undefined || raw === null) return { ref: "", resolved: null };
    const member = String(raw).trim().match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
    if (member) {
      const tn = memberBindings[member[2]];
      if (tn) return { ref: raw, resolved: tn };
      unresolvedIdents.add(raw.trim());
      return { ref: raw, resolved: null };
    }
    const id = ident(raw);
    if (!id) return { ref: raw, resolved: null };
    if (id in bindings) return { ref: id, resolved: bindings[id] };
    unresolvedIdents.add(id);
    return { ref: id, resolved: null };
  };

  const parseFieldList = (fieldsBody) => {
    const fields = [];
    for (const fo of splitTop(fieldsBody)) {
      const t = fo.trim();
      if (!t.startsWith("{")) continue;
      const inner = t.slice(1, findBalanced(t, 0, "{", "}") ?? t.length - 1);
      const f = parseObjectBody(inner);
      const field = { no: Number(f.no), name: str(f.name), kind: str(f.kind) };
      if (f.T !== undefined) {
        if (field.kind === "scalar") {
          const tn = Number(f.T);
          field.type = SCALAR[tn] ?? `scalar#${tn}`;
        } else {
          const inner2 = f.T.match(/getEnumType\(\s*([A-Za-z_$][\w$]*)\s*\)/);
          const r = resolve(inner2 ? inner2[1] : f.T);
          field.type = r.resolved ?? `unresolved:${r.ref}`;
        }
      }
      if (field.kind === "map") {
        if (f.K !== undefined) {
          const kn = Number(f.K);
          field.key_type = SCALAR[kn] ?? `scalar#${kn}`;
        }
        if (f.V !== undefined) {
          const vobj = parseObjectBody(f.V.replace(/^\{|\}$/g, ""));
          const vKind = str(vobj.kind);
          if (vKind === "scalar" || vKind === undefined) {
            const vn = Number(vobj.T);
            field.value_type = SCALAR[vn] ?? `scalar#${vn}`;
          } else {
            const r = resolve(vobj.T);
            field.value_type = r.resolved ?? `unresolved:${r.ref}`;
          }
        }
      }
      if (f.repeated === "!0" || f.repeat === "!0" || f.repeat === "1" || f.repeat === "2") field.repeated = true;
      if (f.opt === "!0") field.optional = true;
      if (f.req === "!0") field.required = true;
      if (f.packed === "!0") field.packed = true;
      if (f.jsonName) field.json_name = str(f.jsonName);
      if (f.oneof) field.oneof = str(f.oneof);
      if (f.L) field.list_kind = f.L;
      fields.push(field);
    }
    return fields.sort((a, b) => a.no - b.no);
  };

  // pass 2: protobuf-es makeMessageType field lists
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*[\w$]+\.makeMessageType\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    const typeName = m[2];
    const arrow = src.indexOf("=>", m.index + m[0].length);
    if (arrow === -1) continue;
    const openBracket = src.indexOf("[", arrow);
    if (openBracket === -1) continue;
    const close = findBalanced(src, openBracket, "[", "]");
    if (close === -1) continue;
    messages[typeName] = { kind: "message", name: typeName, fields: parseFieldList(src.slice(openBracket + 1, close)) };
  }

  // pass 2b: protobuf-ts messages — Ident.typeName="pkg.Msg",Ident.fields=X.proto3.util.newFieldList(()=>[...])
  for (const e of tnEvents) {
    if (messages[e.tn]) continue;
    const tail = src.slice(e.idx, e.idx + 20000);
    const id = e.ident.replace(/[$]/g, "\\$&");
    const fl = tail.match(new RegExp(`\\b${id}\\.fields\\s*=\\s*[\\w$]+\\.proto3\\.util\\.newFieldList\\s*\\(`));
    if (!fl) continue;
    const callStart = e.idx + fl.index + fl[0].length;
    const arrowIdx = src.indexOf("=>", callStart);
    if (arrowIdx === -1 || arrowIdx - callStart > 100) continue;
    const openBracket = src.indexOf("[", arrowIdx);
    if (openBracket === -1) continue;
    const close = findBalanced(src, openBracket, "[", "]");
    if (close === -1) continue;
    messages[e.tn] = { kind: "message", name: e.tn, fields: parseFieldList(src.slice(openBracket + 1, close)) };
  }

  // pass 3: enums
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*[\w$]+\.makeEnum\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    const typeName = m[2];
    const openBracket = src.indexOf("[", m.index + m[0].length - 1);
    if (openBracket === -1) continue;
    const close = findBalanced(src, openBracket, "[", "]");
    if (close === -1) continue;
    const values = [];
    for (const vo of splitTop(src.slice(openBracket + 1, close))) {
      const t = vo.trim();
      if (!t.startsWith("{")) continue;
      const inner = t.slice(1, findBalanced(t, 0, "{", "}") ?? t.length - 1);
      const f = parseObjectBody(inner);
      values.push({ no: Number(f.no), name: str(f.name) });
    }
    enums[typeName] = { kind: "enum", name: typeName, values };
  }

  // pass 4: service literals { typeName: "...", methods: {...} }
  for (const m of src.matchAll(/\{\s*typeName:\s*["'`]([^"'`]+)["'`]\s*,\s*methods\s*:\s*\{/g)) {
    const typeName = m[1];
    const openBrace = m.index + m[0].length - 1;
    const close = findBalanced(src, openBrace, "{", "}");
    if (close === -1) continue;
    const methodsBody = src.slice(openBrace + 1, close);
    const methods = {};
    for (const mo of splitTop(methodsBody)) {
      const mm = mo.match(/^\s*([A-Za-z_$][\w$]*)\s*:\s*\{/);
      if (!mm) continue;
      const innerStart = mo.indexOf("{");
      const innerEnd = findBalanced(mo, innerStart, "{", "}");
      if (innerEnd === -1) continue;
      const f = parseObjectBody(mo.slice(innerStart + 1, innerEnd));
      const name = str(f.name) ?? mm[1];
      const iR = resolve(f.I), oR = resolve(f.O);
      const kindRaw = (f.kind ?? "").split(".").pop();
      methods[name] = {
        request: iR.resolved ?? `unresolved:${iR.ref}`,
        response: oR.resolved ?? `unresolved:${oR.ref}`,
        kind: METHOD_KIND[kindRaw] ?? kindRaw ?? "unary",
      };
    }
    services[typeName] = { kind: "service", name: typeName, methods };
  }

  // pass 5: makeService style (protobuf-es v1 fileGen or hand registrations)
  for (const m of src.matchAll(/\b[A-Za-z_$][\w$]*\s*=\s*[\w$]+\.makeService\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    if (!(m[1] in services)) {
      services[m[1]] = { kind: "service", name: m[1], methods: {}, note: "methods not statically decoded (makeService variant)" };
    }
  }

  // pass 6: Electron IPC surface ------------------------------------------------
  const ipc = { channels: {}, exposed_globals: [], call_sites: [] };
  {
    // 6a: call sites with literal channel names
    for (const m of src.matchAll(/\b(ipcRenderer|ipcMain|webContents|webFrame)\.(invoke|send|sendSync|sendTo|on|once|handle|handleOnce|postMessage)\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
      const [, target, op, ch] = m;
      const c = (ipc.channels[ch] ??= { sends: 0, invokes: 0, listeners: 0, handlers: 0, sites: [] });
      if (op === "invoke" || op === "send" || op === "sendSync" || op === "sendTo" || op === "postMessage") {
        if (op === "invoke") c.invokes++; else c.sends++;
      } else if (target === "ipcMain" || target === "webContents") {
        c.handlers++;
      } else c.listeners++;
      c.sites.push(`${target}.${op}`);
    }
    // 6b: channel-name vocabulary — namespace must appear in a real call site
    // (self-calibrating) or be a known app prefix; otherwise a:b strings
    // capture CSS selectors and string-literal noise.
    const knownNs = new Set(["vscode", "cursor", "agent", "sentry", "electron"]);
    const activeNs = new Set(
      Object.keys(ipc.channels).map((ch) => ch.split(":")[0])
    );
    for (const m of src.matchAll(/["'`]([a-zA-Z][\w-]*:[a-zA-Z][\w.:-]*)["'`]/g)) {
      const ch = m[1];
      if (/^(https?|wss?|file|data|blob|mailto|tel|urn|doi|node|npm|git|ssh|ftp|chrome|devtools|about):/.test(ch)) continue;
      const ns = ch.split(":")[0];
      if (!activeNs.has(ns) && !knownNs.has(ns)) continue;
      if (!(ch in ipc.channels))
        ipc.channels[ch] = { sends: 0, invokes: 0, listeners: 0, handlers: 0, sites: [], vocabulary_only: true };
    }
    // 6c: contextBridge globals
    for (const m of src.matchAll(/exposeInMainWorld\s*\(\s*["'`]([^"'`]+)["'`]/g))
      if (!ipc.exposed_globals.includes(m[1])) ipc.exposed_globals.push(m[1]);
  }

  // pass 7: endpoint vocabulary — literal https:// URLs and bare API host strings.
  // Filtered to hosts that look like app backends (no CDN/fonts/analytics noise
  // beyond recording them; classification is left to the catalog consumer).
  const urls = {};
  for (const m of src.matchAll(/["'`](https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)["'`]/g)) {
    let u = m[1];
    if (u.length > 300) continue;
    // strip trailing punctuation often glued to literals
    u = u.replace(/[).,;]+$/, "");
    urls[u] = (urls[u] ?? 0) + 1;
  }
  const endpoints = { urls, hosts: {} };
  for (const u of Object.keys(urls)) {
    try {
      const h = new URL(u).hostname;
      (endpoints.hosts[h] ??= []).push(u);
    } catch { /* malformed literal, keep in urls only */ }
  }

  if (unresolvedIdents.size) {
    notes.push(`${unresolvedIdents.size} identifier(s) could not be resolved to a typeName`);
  }

  return {
    source: fileLabel,
    counts: {
      services: Object.keys(services).length,
      messages: Object.keys(messages).length,
      enums: Object.keys(enums).length,
      methods: Object.values(services).reduce((n, s) => n + Object.keys(s.methods).length, 0),
      ipc_channels: Object.keys(ipc.channels).length,
    },
    services, messages, enums, ipc, endpoints,
    notes,
  };
}

// ---- CLI -------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("extract-bundle-protos.mjs")) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
  const lfIdx = args.indexOf("--files");
  const listFile = lfIdx >= 0 ? args.splice(lfIdx, 2)[1] : null;
  const files = args.filter((a) => !a.startsWith("--"));
  if (listFile) for (const l of readFileSync(listFile, "utf8").split("\n")) if (l.trim()) files.push(l.trim());

  const merged = { generated_by: "wirecat extract-bundle-protos", sources: [], counts: { services: 0, messages: 0, enums: 0, methods: 0, ipc_channels: 0 }, services: {}, messages: {}, enums: {}, ipc: { channels: {}, exposed_globals: [] }, endpoints: { urls: {}, hosts: {} }, notes: [] };
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const r = extractFromSource(src, basename(f));
    merged.sources.push(r.source);
    for (const [k, v] of Object.entries(r.services)) if (!merged.services[k]) merged.services[k] = v;
    for (const [k, v] of Object.entries(r.messages)) if (!merged.messages[k]) merged.messages[k] = v;
    for (const [k, v] of Object.entries(r.enums)) if (!merged.enums[k]) merged.enums[k] = v;
    if (r.ipc) {
      for (const [ch, info] of Object.entries(r.ipc.channels)) {
        const c = (merged.ipc.channels[ch] ??= { sends: 0, invokes: 0, listeners: 0, handlers: 0, sites: [] });
        for (const kk of ["sends", "invokes", "listeners", "handlers"]) c[kk] += info[kk] ?? 0;
        for (const s of info.sites ?? []) if (!c.sites.includes(s)) c.sites.push(s);
      }
      for (const g of r.ipc.exposed_globals) if (!merged.ipc.exposed_globals.includes(g)) merged.ipc.exposed_globals.push(g);
    }
    if (r.endpoints) {
      for (const [u, n] of Object.entries(r.endpoints.urls)) merged.endpoints.urls[u] = (merged.endpoints.urls[u] ?? 0) + n;
      for (const [h, us] of Object.entries(r.endpoints.hosts))
        for (const u of us) {
          (merged.endpoints.hosts[h] ??= []);
          if (!merged.endpoints.hosts[h].includes(u)) merged.endpoints.hosts[h].push(u);
        }
    }
    for (const k of ["services", "messages", "enums", "methods", "ipc_channels"]) merged.counts[k] += r.counts[k] ?? 0;
    merged.notes.push(...r.notes);
  }
  const json = JSON.stringify(merged, null, 1);
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
  console.error(`[wirecat] ${merged.counts.services} services, ${merged.counts.messages} messages, ${merged.counts.enums} enums, ${merged.counts.methods} methods`);
}
