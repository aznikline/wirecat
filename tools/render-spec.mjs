#!/usr/bin/env node
// Wirecat render: catalog JSON -> spec markdown grouped by proto package.
// Usage: node tools/render-spec.mjs catalogs/cursor/3.24.12.json [--packages aiserver.v1,agent.v1] [--full]

import { readFileSync } from "node:fs";

const [path, ...rest] = process.argv.slice(2);
const cat = JSON.parse(readFileSync(path, "utf8"));
const pkgIdx = rest.indexOf("--packages");
const allow = pkgIdx >= 0 ? new Set(rest[pkgIdx + 1].split(",")) : null;
const full = rest.includes("--full");

const byPkg = {};
for (const [name, svc] of Object.entries(cat.services)) {
  const pkg = name.split(".").slice(0, -1).join(".");
  if (allow && ![...allow].some((p) => pkg === p || pkg.startsWith(p + "."))) continue;
  (byPkg[pkg] ??= []).push(svc);
}

const out = [];
out.push(`# Protocol spec — ${path.split("/").pop().replace(".json", "")}`);
out.push("");
out.push(`Extracted by Wirecat \`extract-bundle-protos\` from shipped application bundles.`);
out.push(`Scope: ${allow ? [...allow].join(", ") : "all packages"}.`);
out.push("");
for (const pkg of Object.keys(byPkg).sort()) {
  const svcs = byPkg[pkg].sort((a, b) => a.name.localeCompare(b.name));
  out.push(`## \`${pkg}\` (${svcs.length} services)`);
  for (const svc of svcs) {
    const ms = Object.entries(svc.methods);
    out.push(`\n### ${svc.name}`);
    if (!ms.length) { out.push(`- *(methods not statically decoded)*`); continue; }
    out.push(`| method | request | response | kind |`);
    out.push(`|---|---|---|---|`);
    for (const [n, m] of ms.sort((a, b) => a[0].localeCompare(b[0])))
      out.push(`| ${n} | \`${m.request}\` | \`${m.response}\` | ${m.kind} |`);
  }
}
if (full) {
  out.push(`\n# Messages\n`);
  for (const [name, m] of Object.entries(cat.messages).sort()) {
    const pkg = name.split(".").slice(0, -1).join(".");
    if (allow && ![...allow].some((p) => pkg === p || pkg.startsWith(p + "."))) continue;
    out.push(`\n## ${name}`);
    out.push(`| # | name | type | modifiers |`);
    out.push(`|---|---|---|---|`);
    for (const f of m.fields)
      out.push(`| ${f.no} | ${f.name} | \`${f.type}\` | ${f.repeated ? "repeated" : ""}${f.optional ? " optional" : ""}${f.required ? " required" : ""}${f.oneof ? " oneof:" + f.oneof : ""} |`);
  }
}
process.stdout.write(out.join("\n") + "\n");
