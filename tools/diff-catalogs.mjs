#!/usr/bin/env node
// Wirecat diff: two version catalogs -> added/removed/changed report.
// Usage: node tools/diff-catalogs.mjs old.json new.json [--md]

import { readFileSync } from "node:fs";

const [oldPath, newPath, ...flags] = process.argv.slice(2);
const old = JSON.parse(readFileSync(oldPath, "utf8"));
const cur = JSON.parse(readFileSync(newPath, "utf8"));
const md = flags.includes("--md");

function fieldSig(f) {
  return `${f.kind}:${f.type ?? ""}${f.repeated ? "[]" : ""}${f.optional ? "?" : ""}${f.required ? "!" : ""}`;
}
function methodSig(m) {
  return `${m.kind}:${m.request}->${m.response}`;
}

function diffTypeMap(a, b, sigFn) {
  const added = [], removed = [], changed = [];
  for (const k of Object.keys(b)) {
    if (!(k in a)) { added.push(k); continue; }
    const sA = sigFn(a[k]), sB = sigFn(b[k]);
    if (sA !== sB) changed.push(k);
  }
  for (const k of Object.keys(a)) if (!(k in b)) removed.push(k);
  return { added, removed, changed };
}

const svcSig = (s) => Object.entries(s.methods).map(([n, m]) => `${n}=${methodSig(m)}`).sort().join("|");
const msgSig = (m) => m.fields.map((f) => `${f.no}=${f.name}=${fieldSig(f)}`).join("|");
const enumSig = (e) => e.values.map((v) => `${v.no}=${v.name}`).join("|");

const svc = diffTypeMap(old.services, cur.services, svcSig);
const msg = diffTypeMap(old.messages, cur.messages, msgSig);
const enm = diffTypeMap(old.enums, cur.enums, enumSig);
const ipcA = old.ipc?.channels ?? {}, ipcB = cur.ipc?.channels ?? {};
const ipc = diffTypeMap(ipcA, ipcB, (c) => `${c.sends}/${c.invokes}/${c.listeners}/${c.handlers}`);
const ipcSig = { added: ipc.added, removed: ipc.removed, changed: ipc.changed };
// endpoint hosts only (URL-level churn is noise; host additions/removals are signal)
const hostsA = Object.keys(old.endpoints?.hosts ?? {}), hostsB = Object.keys(cur.endpoints?.hosts ?? {});
const ep = {
  added: hostsB.filter((h) => !hostsA.includes(h)),
  removed: hostsA.filter((h) => !hostsB.includes(h)),
};

// per-service method-level detail for changed services
const methodChanges = {};
for (const name of svc.changed) {
  const a = old.services[name].methods, b = cur.services[name].methods;
  const det = { added: [], removed: [], changed: [] };
  for (const k of Object.keys(b)) {
    if (!(k in a)) det.added.push(k);
    else if (methodSig(a[k]) !== methodSig(b[k])) det.changed.push(k);
  }
  for (const k of Object.keys(a)) if (!(k in b)) det.removed.push(k);
  methodChanges[name] = det;
}
// per-message field-level detail for changed messages
const fieldChanges = {};
for (const name of msg.changed) {
  const a = new Map(old.messages[name].fields.map((f) => [f.no, f]));
  const b = new Map(cur.messages[name].fields.map((f) => [f.no, f]));
  const det = { added: [], removed: [], changed: [] };
  for (const [no, f] of b) {
    if (!a.has(no)) det.added.push(`${no} ${f.name}`);
    else if (fieldSig(a.get(no)) !== fieldSig(f) || a.get(no).name !== f.name)
      det.changed.push(`${no} ${a.get(no).name} -> ${f.name}`);
  }
  for (const [no, f] of a) if (!b.has(no)) det.removed.push(`${no} ${f.name}`);
  fieldChanges[name] = det;
}

import { basename } from "node:path";
const report = {
  from: basename(oldPath).replace(/\.json$/, ""),
  to: basename(newPath).replace(/\.json$/, ""),
  summary: {
    services: { added: svc.added.length, removed: svc.removed.length, changed: svc.changed.length },
    messages: { added: msg.added.length, removed: msg.removed.length, changed: msg.changed.length },
    enums: { added: enm.added.length, removed: enm.removed.length, changed: enm.changed.length },
    ipc_channels: { added: ipc.added.length, removed: ipc.removed.length, changed: ipc.changed.length },
    endpoint_hosts: { added: ep.added.length, removed: ep.removed.length, changed: 0 },
  },
  services: svc,
  messages: msg,
  enums: enm,
  ipc_channels: ipcSig,
  endpoint_hosts: ep,
  method_changes: methodChanges,
  field_changes: fieldChanges,
};

if (md) {
  const out = [];
  out.push(`# Catalog diff: ${report.from} -> ${report.to}\n`);
  for (const [k, v] of Object.entries(report.summary))
    out.push(`- **${k}**: +${v.added} / -${v.removed} / ~${v.changed}`);
  const sect = (title, list, detail) => {
    if (!list.length) return;
    out.push(`\n## ${title} (${list.length})`);
    for (const n of list) {
      out.push(`- \`${n}\``);
      const d = detail?.[n];
      if (d) {
        for (const [kk, vv] of Object.entries(d))
          for (const x of vv) out.push(`  - ${kk}: \`${x}\``);
      }
    }
  };
  sect("Added services", svc.added);
  sect("Removed services", svc.removed);
  sect("Changed services", svc.changed, methodChanges);
  sect("Added messages", msg.added);
  sect("Removed messages", msg.removed);
  sect("Changed messages", msg.changed, fieldChanges);
  sect("Added enums", enm.added);
  sect("Removed enums", enm.removed);
  sect("Changed enums", enm.changed);
  sect("Added IPC channels", ipc.added);
  sect("Removed IPC channels", ipc.removed);
  sect("Changed IPC channels", ipc.changed);
  sect("Added endpoint hosts", ep.added);
  sect("Removed endpoint hosts", ep.removed);
  process.stdout.write(out.join("\n") + "\n");
} else {
  process.stdout.write(JSON.stringify(report, null, 1) + "\n");
}
