#!/usr/bin/env node
// wirecat emit-proto: catalog.json -> .proto3 files
// Usage: node tools/emit-proto.mjs catalog.json --out proto/ [--packages aiserver.v1,agent.v1]
//
// Emits one .proto per package. Nested messages (pkg.Parent.Child) are nested.
// Unresolved refs become `Unresolved_<ref>` placeholder messages + comments —
// honest about the gap while keeping the file parseable.
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, basename } from "path";

const SCALARS = new Set(["double","float","int64","uint64","int32","fixed64","fixed32","bool","string","bytes","uint32","sfixed32","sfixed64","sint32","sint64"]);
const WKT_IMPORT = {
  "google.protobuf.Timestamp": "google/protobuf/timestamp.proto",
  "google.protobuf.Duration": "google/protobuf/duration.proto",
  "google.protobuf.Any": "google/protobuf/any.proto",
  "google.protobuf.Empty": "google/protobuf/empty.proto",
  "google.protobuf.Struct": "google/protobuf/struct.proto",
  "google.protobuf.Value": "google/protobuf/struct.proto",
  "google.protobuf.ListValue": "google/protobuf/struct.proto",
  "google.protobuf.NullValue": "google/protobuf/struct.proto",
  "google.protobuf.BoolValue": "google/protobuf/wrappers.proto",
  "google.protobuf.Int32Value": "google/protobuf/wrappers.proto",
  "google.protobuf.Int64Value": "google/protobuf/wrappers.proto",
  "google.protobuf.UInt32Value": "google/protobuf/wrappers.proto",
  "google.protobuf.UInt64Value": "google/protobuf/wrappers.proto",
  "google.protobuf.StringValue": "google/protobuf/wrappers.proto",
  "google.protobuf.BytesValue": "google/protobuf/wrappers.proto",
  "google.protobuf.DoubleValue": "google/protobuf/wrappers.proto",
  "google.protobuf.FloatValue": "google/protobuf/wrappers.proto",
  "google.protobuf.FieldMask": "google/protobuf/field_mask.proto",
};

const pkgOf = (tn) => tn.slice(0, tn.lastIndexOf("."));
// Real package = longest dotted prefix that is NOT itself a type name.
// A prefix that is a registered type means the tn is nested inside that type,
// so its package is the next shorter prefix.
const pkgOfReal = (tn, allTypes) => {
  let p = tn.lastIndexOf(".");
  while (p > 0) {
    const cand = tn.slice(0, p);
    if (!allTypes.has(cand)) return cand;
    p = tn.lastIndexOf(".", p - 1);
  }
  return tn.slice(0, tn.lastIndexOf("."));
};
const shortOf = (tn) => tn.slice(tn.lastIndexOf(".") + 1);
const sanitize = (s) => s.replace(/[^A-Za-z0-9_.]/g, "_");

function emit(catalog, packages) {
  // group types by package — package = longest prefix that is not itself a type
  const allTypes = new Set([
    ...Object.keys(catalog.messages ?? {}),
    ...Object.keys(catalog.enums ?? {}),
    ...Object.keys(catalog.services ?? {}),
  ]);
  const pkgFor = (tn) => pkgOfReal(tn, allTypes);
  const byPkg = {};
  const add = (pkg, kind, tn, def) => ((byPkg[pkg] ??= { messages: {}, enums: {}, services: {} })[kind][tn] = def);
  for (const [tn, def] of Object.entries(catalog.messages ?? {})) {
    if (packages && !packages.includes(pkgFor(tn))) continue;
    add(pkgFor(tn), "messages", tn, def);
  }
  for (const [tn, def] of Object.entries(catalog.enums ?? {})) {
    if (packages && !packages.includes(pkgFor(tn))) continue;
    add(pkgFor(tn), "enums", tn, def);
  }
  for (const [tn, def] of Object.entries(catalog.services ?? {})) {
    if (packages && !packages.includes(pkgFor(tn))) continue;
    add(pkgFor(tn), "services", tn, def);
  }

  // nested-type tree: pkg.A.B where pkg.A is also a message -> child of A
  const files = {};
  for (const [pkg, g] of Object.entries(byPkg)) {
    const known = new Set([...Object.keys(g.messages), ...Object.keys(g.enums)]);
    const roots = [];
    const children = {}; // parent tn -> [child tn]
    for (const tn of Object.keys(g.messages)) {
      let parent = null;
      let p = tn.lastIndexOf(".");
      while (p > pkg.length) {
        const cand = tn.slice(0, p);
        if (g.messages[cand] || g.enums[cand]) { parent = cand; break; }
        p = tn.lastIndexOf(".", p - 1);
      }
      if (parent) (children[parent] ??= []).push(tn);
      else roots.push(tn);
    }
    for (const tn of [...Object.keys(g.enums)]) {
      let parent = null;
      let p = tn.lastIndexOf(".");
      while (p > pkg.length) {
        const cand = tn.slice(0, p);
        if (g.messages[cand]) { parent = cand; break; }
        p = tn.lastIndexOf(".", p - 1);
      }
      if (parent) (children[parent] ??= []).push(tn);
      else roots.push(tn);
    }

    const imports = new Set();
    const unresolved = new Set();

    const typeRef = (tn, curPkg) => {
      if (SCALARS.has(tn)) return tn;
      if (tn.startsWith("unresolved:")) {
        const name = "Unresolved_" + sanitize(tn.slice(11));
        unresolved.add(`${name}  // unresolved: ${tn.slice(11)}`);
        return name;
      }
      if (WKT_IMPORT[tn]) { imports.add(WKT_IMPORT[tn]); return tn; }
      const rp = pkgFor(tn);
      // same package (incl. nested pkg.Parent.Child): resolve relative
      if (tn.startsWith(curPkg + ".")) {
        const rel = tn.slice(curPkg.length + 1);
        if (known.has(tn)) return rel;
        // nested under a known type in this package?
        const segs = rel.split(".");
        for (let i = segs.length - 1; i > 0; i--) {
          if (known.has(`${curPkg}.${segs.slice(0, i).join(".")}`)) return rel;
        }
      }
      if (rp === curPkg) return tn.slice(curPkg.length + 1);
      if (byPkg[rp]) { imports.add(`${rp}.proto`); return tn; }
      // external package not in catalog: emit as fully-qualified comment-safe ref
      imports.add(`${rp}.proto`);
      return tn;
    };

    const emitEnum = (tn, indent) => {
      const e = g.enums[tn];
      const lines = [`${indent}enum ${shortOf(tn)} {`];
      for (const v of e.values ?? []) lines.push(`${indent}  ${v.name} = ${v.no};`);
      lines.push(`${indent}}`);
      return lines;
    };

    const emitMsg = (tn, indent) => {
      const m = g.messages[tn];
      const lines = [`${indent}message ${shortOf(tn)} {`];
      // group oneofs
      const oneofs = {};
      const plain = [];
      for (const f of m.fields ?? []) {
        if (f.oneof) (oneofs[f.oneof] ??= []).push(f);
        else plain.push(f);
      }
      for (const f of plain) {
        let decl;
        if (f.kind === "map") {
          decl = `map<${typeRef(f.key_type ?? "string", pkg)}, ${typeRef(f.value_type ?? "google.protobuf.Any", pkg)}> ${f.name} = ${f.no};`;
        } else {
          const t = typeRef(f.type ?? "bytes", pkg);
          const label = f.repeated ? "repeated " : f.optional ? "optional " : "";
          decl = `${label}${t} ${f.name} = ${f.no};`;
        }
        const cmt = f.required ? " // required in source" : "";
        lines.push(`${indent}  ${decl}${cmt}`);
      }
      for (const [name, fs] of Object.entries(oneofs)) {
        lines.push(`${indent}  oneof ${name} {`);
        for (const f of fs) lines.push(`${indent}    ${typeRef(f.type ?? "bytes", pkg)} ${f.name} = ${f.no};`);
        lines.push(`${indent}  }`);
      }
      for (const child of children[tn] ?? []) {
        if (g.messages[child]) lines.push(...emitMsg(child, indent + "  "));
        else if (g.enums[child]) lines.push(...emitEnum(child, indent + "  "));
      }
      lines.push(`${indent}}`);
      return lines;
    };

    const body = [];
    for (const tn of roots.filter((t) => g.enums[t])) body.push(...emitEnum(tn, ""), "");
    for (const tn of roots.filter((t) => g.messages[t])) body.push(...emitMsg(tn, ""), "");
    for (const [tn, s] of Object.entries(g.services)) {
      body.push(`service ${shortOf(tn)} {`);
      for (const [mn, mm] of Object.entries(s.methods ?? {})) {
        const req = typeRef(mm.request ?? "google.protobuf.Empty", pkg);
        const res = typeRef(mm.response ?? "google.protobuf.Empty", pkg);
        const cs = mm.kind === "client_streaming" || mm.kind === "bidi_streaming" ? "stream " : "";
        const ss = mm.kind === "server_streaming" || mm.kind === "bidi_streaming" ? "stream " : "";
        body.push(`  rpc ${mn}(${cs}${req}) returns (${ss}${res});`);
      }
      body.push("}", "");
    }
    for (const u of [...unresolved].sort()) body.push(`message ${u.split("  ")[0]} {} ${u.split("  ")[1]}`);

    const head = [`// Generated by wirecat emit-proto from a shipped-client catalog.`, `// Do not edit by hand; regenerate.`, `syntax = "proto3";`, ``, `package ${pkg};`, ``];
    for (const i of [...imports].sort()) head.push(`import "${i}";`);
    if (imports.size) head.push("");
    files[`${pkg}.proto`] = head.concat(body).join("\n");
  }
  return files;
}

// ---- CLI ----
if (process.argv[1] && process.argv[1].endsWith("emit-proto.mjs")) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
  const pkIdx = args.indexOf("--packages");
  const packages = pkIdx >= 0 ? args.splice(pkIdx, 2)[1].split(",") : null;
  const cat = JSON.parse(readFileSync(args[0], "utf8"));
  const files = emit(cat, packages);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(outDir, name), content);
    console.error(`[wirecat] wrote ${Object.keys(files).length} proto files to ${outDir}`);
  } else {
    for (const [name, content] of Object.entries(files)) {
      console.log(`// ==== ${name} ====`);
      console.log(content);
    }
  }
}
