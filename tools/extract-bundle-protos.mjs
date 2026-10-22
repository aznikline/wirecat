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

  const resolve = (raw) => {
    const id = ident(raw);
    if (!id) return { ref: raw, resolved: null };
    if (id in bindings) return { ref: id, resolved: bindings[id] };
    unresolvedIdents.add(id);
    return { ref: id, resolved: null };
  };

  // pass 2: message definitions with fields
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*[\w$]+\.makeMessageType\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    const typeName = m[2];
    const arrow = src.indexOf("=>", m.index + m[0].length);
    if (arrow === -1) continue;
    const openBracket = src.indexOf("[", arrow);
    if (openBracket === -1) continue;
    const close = findBalanced(src, openBracket, "[", "]");
    if (close === -1) continue;
    const fieldsBody = src.slice(openBracket + 1, close);
    const fields = [];
    for (const fo of splitTop(fieldsBody)) {
      const t = fo.trim();
      if (!t.startsWith("{")) continue;
      const inner = t.slice(1, findBalanced(t, 0, "{", "}") ?? t.length - 1);
      const f = parseObjectBody(inner);
      const field = {
        no: Number(f.no), name: str(f.name), kind: str(f.kind),
      };
      if (f.T !== undefined) {
        if (field.kind === "scalar") {
          const tn = Number(f.T);
          field.type = SCALAR[tn] ?? `scalar#${tn}`;
        } else {
          // T may be a bare ident or a call like ns.getEnumType(ident)
          const inner = f.T.match(/getEnumType\(\s*([A-Za-z_$][\w$]*)\s*\)/);
          const r = resolve(inner ? inner[1] : f.T);
          field.type = r.resolved ?? `unresolved:${r.ref}`;
        }
      }
      if (f.repeated === "!0") field.repeated = true;
      if (f.opt === "!0") field.optional = true;
      if (f.req === "!0") field.required = true;
      if (f.packed === "!0") field.packed = true;
      if (f.jsonName) field.json_name = str(f.jsonName);
      if (f.oneof) field.oneof = str(f.oneof);
      if (f.L) field.list_kind = f.L; // presence tracking
      fields.push(field);
    }
    fields.sort((a, b) => a.no - b.no);
    messages[typeName] = { kind: "message", name: typeName, fields };
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
    },
    services, messages, enums,
    notes,
  };
}

// ---- CLI -------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("extract-bundle-protos.mjs")) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
  const files = args.filter((a) => !a.startsWith("--"));

  const merged = { generated_by: "wirecat extract-bundle-protos", sources: [], counts: { services: 0, messages: 0, enums: 0, methods: 0 }, services: {}, messages: {}, enums: {}, notes: [] };
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const r = extractFromSource(src, basename(f));
    merged.sources.push(r.source);
    for (const [k, v] of Object.entries(r.services)) if (!merged.services[k]) merged.services[k] = v;
    for (const [k, v] of Object.entries(r.messages)) if (!merged.messages[k]) merged.messages[k] = v;
    for (const [k, v] of Object.entries(r.enums)) if (!merged.enums[k]) merged.enums[k] = v;
    for (const k of ["services", "messages", "enums", "methods"]) merged.counts[k] += r.counts[k];
    merged.notes.push(...r.notes);
  }
  const json = JSON.stringify(merged, null, 1);
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
  console.error(`[wirecat] ${merged.counts.services} services, ${merged.counts.messages} messages, ${merged.counts.enums} enums, ${merged.counts.methods} methods`);
}
