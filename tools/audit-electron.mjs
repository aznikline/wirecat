#!/usr/bin/env node
// Wirecat auditor: Electron attack-surface analysis on shipped JS bundles.
// Usage: node tools/audit-electron.mjs <bundle.js> [...] --out audit.json [--md audit.md]
//
// Answers the question bounty hunters ask by hand:
//   "is a privileged ipcMain handler reachable from untrusted content,
//    and does attacker-controlled input reach a dangerous sink?"
//
// The chain decomposes into literal-keyed edges that survive minification:
//   remote content -> webPreferences flags -> contextBridge exposure
//     -> IPC channel pairing -> handler body (sender validation + sinks)
// Every finding carries a confidence tier: observed / derived / inferred /
// unknown. Unknowns stay unknown — we never guess "safe".
//
// NOT whole-program taint analysis (infeasible on 47MB minified bundles).
// This is boundary-protocol reachability + bounded intra-handler scanning.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

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

// ---- vocabularies -----------------------------------------------------------
// webPreferences keys with security semantics. Value `!0`/`true` or
// `!1`/`false` in minified output; identifiers recorded raw as unresolved.
const WP_KEYS = [
  "contextIsolation", "nodeIntegration", "nodeIntegrationInWorker",
  "nodeIntegrationInSubFrames", "sandbox", "webSecurity", "webviewTag",
  "allowRunningInsecureContent", "experimentalFeatures", "enableRemoteModule",
  "preload", "partition", "session", "nativeWindowOpen", "disableBlinkFeatures",
  "enableBlinkFeatures", "safeDialogs", "navigateOnDragDrop", "autoplayPolicy",
  "backgroundThrottling", "offscreen", "transparent", "javascript",
];

// Sinks reachable inside an ipcMain handler = attacker-controllable effect.
const SINKS = {
  code_exec: [
    /\bchild_process\b/, /\bexecFile\s*\(/, /\bexecSync\s*\(/, /\bspawnSync\s*\(/,
    /\bspawn\s*\(/, /\bexec\s*\(/, /\beval\s*\(/, /\bnew Function\s*\(/,
    /\bexecuteJavaScript\s*\(/, /\brequire\s*\(\s*["'`](?!electron)/,
  ],
  navigation: [
    /\bopenExternal\s*\(/, /\.loadURL\s*\(/, /\.loadFile\s*\(/,
    /setWindowOpenHandler/, /\bnew-window\b/,
  ],
  file_write: [
    /\bwriteFile(Sync)?\s*\(/, /\bwriteFileAtomic\b/, /\.rm\s*\(/,
    /\.unlink(Sync)?\s*\(/, /\.rename(Sync)?\s*\(/, /\.mkdir(Sync)?\s*\(/,
    /\bdownloadURL\s*\(/, /\bsavePage\s*\(/,
  ],
  session_net: [
    /\.setProxy\s*\(/, /\.setCertificateVerifyProc\s*\(/,
    /setPermissionRequestHandler/, /setPermissionCheckHandler/,
    /\bprotocol\.(register|handle|intercept)/, /\bnet\.request\s*\(/,
    /\bWebSocket\s*\(/, /\.setDownloadPath\s*\(/,
  ],
  host_bridge: [
    /\.webContents\b/, /\.sendInputEvent\s*\(/, /\.setZoomFactor/,
    /\.openDevTools\s*\(/, /\.inspectElement/,
  ],
};

// Handler-body evidence that the sender was authenticated before acting.
const SENDER_CHECKS = [
  /\bsenderFrame\b/, /\bsender\.getURL\b/, /\.sender\.url\b/,
  /\.sender\.id\b/, /\bsender\.origin\b/, /\.origin\b/, /frameId/,
  /\bisTrusted\b/, /\bvalidateSender/i, /\ballowlist|whitelist/i,
  /new URL\([^)]*sender/i,
];

const CONF = { OBSERVED: "observed", DERIVED: "derived", INFERRED: "inferred", UNKNOWN: "unknown" };

function lit(v) {
  const t = v.trim();
  if (/^!0$|^true$/.test(t)) return true;
  if (/^!1$|^false$/.test(t)) return false;
  const m = t.match(/^["'`]([^"'`]*)["'`]$/);
  if (m) return m[1];
  return { unresolved: t.slice(0, 80) };
}

// ---- per-file extraction ----------------------------------------------------
function auditFile(src, label) {
  const r = {
    file: label,
    role: /preload/i.test(label) ? "preload"
        : /electron-main|electron-utility|ProcessMain|electron-sandbox\/(workbench|processExplorer)Main|(^|\/)main\.js$/i.test(label) ? "main"
        : "renderer",
    web_preferences: [],
    ipc_sites: [],
    handlers: [],
    exposures: [],
    remote_loads: [],
    nav_guards: [],
    misc_flags: [],
    service_channels: [],
    bulk_ipc: null,
  };

  // 0. bulk IPC registration (DI-registry style) ---------------------------------
  // Unity Hub / VS Code-adjacent apps: a services map is iterated and every
  // entry becomes ipcMain.handle(channel, (_event, ...args) => fn(...args)).
  // The event arg is discarded — sender validation is structurally impossible.
  {
    const shell = src.match(/ipcMain\.handle\s*\(\s*(\w+)\s*,\s*\(\s*(_\w*|e|_event)\s*,\s*\.\.\.\w+\s*\)\s*=>/);
    const entriesFeed = src.match(/Object\.entries\([\s\S]{0,120}?forEach/);
    if (shell && entriesFeed) {
      const computedHandlers = [...src.matchAll(/\[([A-Z][A-Z0-9_]{2,})\]\s*=\s*\(\.\.\.args\)\s*=>\s*this\./g)].length;
      r.bulk_ipc = {
        pattern: shell[0].slice(0, 160),
        event_discarded: /^_/.test(shell[2]),
        computed_handler_count: computedHandlers,
      };
    }
  }

  // 1. webPreferences object literals -----------------------------------------
  for (const m of src.matchAll(/\bwebPreferences\s*:\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = findBalanced(src, open, "{", "}");
    if (close < 0) continue;
    const body = src.slice(open + 1, close);
    const wp = { file: label, keys: {}, raw_bytes: body.length };
    for (const kv of splitTop(body)) {
      const km = kv.match(/^\s*(\w+)\s*:\s*([\s\S]+)$/);
      if (!km) continue;
      const [, k, v] = km;
      if (WP_KEYS.includes(k) || k === "preload" || k === "session") wp.keys[k] = lit(v);
      else wp.keys[k] = lit(v); // keep unknown keys too — may hold flags we miss
    }
    // nested session/partition objects get truncated; note the fact
    if (body.length > 4000) wp.note = "object truncated below 4KB capture";
    r.web_preferences.push(wp);
  }

  // 2. IPC call sites (all literal channels, all directions) -------------------
  for (const m of src.matchAll(/\b(ipcRenderer|ipcMain|webContents|webFrame)\.(invoke|send|sendSync|sendTo|on|once|handle|handleOnce|postMessage)\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    const [, target, op, ch] = m;
    const side = (target === "ipcMain" || target === "webContents") ? "main" : "renderer";
    const dir = (op === "invoke" || op === "send" || op === "sendSync" || op === "sendTo" || op === "postMessage") ? "send" : "listen";
    const site = { channel: ch, api: `${target}.${op}`, side, dir, file: label };
    r.ipc_sites.push(site);

    // 2a. main-side handlers: capture the handler argument verbatim via
    // balanced scan, then scan it for sender-validation and sinks.
    if (target === "ipcMain" && (op === "handle" || op === "handleOnce" || op === "on" || op === "once")) {
      const paren = src.indexOf("(", m.index); // the call paren of handle( itself
      if (paren < 0) continue;
      const close = findBalanced(src, paren, "(", ")");
      const args = close > 0 ? src.slice(paren + 1, close) : src.slice(paren + 1, paren + 3000);
      const parts = splitTop(args);
      const body = parts.slice(1).join(","); // everything after channel arg
      const truncated = close < 0 || body.length > 20000;
      const slice = body.slice(0, 20000);
      const senderHits = SENDER_CHECKS.filter((re) => re.test(slice)).map((re) => re.source);
      const sinks = [];
      for (const [cls, res] of Object.entries(SINKS))
        for (const re of res)
          if (re.test(slice)) { sinks.push({ class: cls, pattern: re.source.slice(0, 60) }); break; }
      r.handlers.push({
        channel: ch, op, file: label,
        body_bytes: body.length, truncated,
        sender_validation: senderHits.length ? { status: "observed", evidence: senderHits.slice(0, 4) }
          : truncated ? { status: "unknown", reason: "handler body exceeds capture bound" }
          : { status: "absent" },
        sinks,
      });
    }
  }

  // 3. contextBridge exposure ---------------------------------------------------
  // ipcRenderer is almost always destructured/aliased in real preloads:
  //   const{ipcRenderer:i}=require("electron") / i=require("e").ipcRenderer
  const ipcAliases = new Set();
  for (const m of src.matchAll(/ipcRenderer\s*:\s*(\w+)/g)) ipcAliases.add(m[1]);
  for (const m of src.matchAll(/(\w+)\s*=\s*require\s*\([^)]*\)\s*\.ipcRenderer\b/g)) ipcAliases.add(m[1]);
  const ipcRef = (b) => /ipcRenderer/.test(b) || [...ipcAliases].some((a) => new RegExp(`\\b${a}\\.(?:invoke|send|sendSync|on|once)\\b`).test(b));
  const ipcAliasesFound = [...ipcAliases];

  for (const m of src.matchAll(/exposeInMainWorld\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    const key = m[1];
    const paren = src.indexOf("(", m.index);
    const close = paren > 0 ? findBalanced(src, paren, "(", ")") : -1;
    let slice = close > 0 ? src.slice(paren + 1, close) : src.slice(m.index, m.index + 2000);
    // arg2 is usually an identifier bound to the exposed object literal —
    // resolve `c={...}`/`const c=...` in-file and scan the definition body.
    const arg2 = (splitTop(slice)[1] ?? "").trim();
    const identM = arg2.match(/^(\w+)$/);
    if (identM) {
      const def = src.match(new RegExp(`\\b${identM[1]}\\s*=\\s*\\{`)) ?? src.match(new RegExp(`\\b(?:const|let|var)\\s+${identM[1]}\\s*=\\s*`));
      if (def) {
        const b = src.indexOf("{", def.index);
        const bc = b > 0 ? findBalanced(src, b, "{", "}") : -1;
        if (bc > 0) slice = src.slice(b, bc);
      }
    }
    // wildcard pass-through: exposed object hands callers a raw channel arg or
    // an ipcRenderer reference (possibly via a destructured alias) — the
    // Discord-RCE exposure class.
    const forwarding = ipcRef(slice);
    // A first-arg identifier only counts as caller-controlled if it does NOT
    // resolve to a string literal in-file — invoke(SOME_CHANNEL_CONST, ...) is
    // a fixed-channel wrapper, not a wildcard.
    const fixedChannelWrap = (() => {
      for (const fm of slice.matchAll(/(?:invoke|send|sendSync)\s*\(\s*([A-Z][A-Z0-9_]{2,}|[a-z]\w+)\s*[,)]/g)) {
        const ident = fm[1];
        const def = src.match(new RegExp(`\\b(?:const|let|var)\\s+${ident}\\s*=\\s*["'\`][^"'\`]+["'\`]`)) ||
                    src.match(new RegExp(`\\b${ident}\\s*=\\s*["'\`][^"'\`]+["'\`]`));
        if (def) return true;
      }
      return false;
    })();
    const genericFwd = !fixedChannelWrap && (
      /\(\s*(?:\w+\s*,\s*)*\.{3}\w+\s*\)\s*=>[^}]{0,200}(invoke|send|sendSync)\s*\(/.test(slice)
      || /(invoke|send|sendSync)\s*\(\s*\w+\s*,/.test(slice) // first arg is a variable channel
      || /\w+\s*\(\s*\w+\s*(?:,\s*\.{3}\w+)?\s*\)\s*\{[^}]{0,200}(invoke|send|sendSync)\s*\(/.test(slice)); // method shorthand fwd
    // channel-name guard inside the bridge: e.g. t(e){if(!e.startsWith("vscode:"))throw}
    // turns an unbounded wildcard into a namespace-gated one.
    const guard = slice.match(/startsWith\s*\(\s*["'`]([^"'`]+)["'`]/);
    const guardThrows = guard && /throw/.test(slice.slice(0, Math.max(0, slice.indexOf(guard[0])) + 400));
    // guard may live in a sibling helper (e.g. t(e){...throw}) outside the
    // exposed object body — fall back to file-level detection, marked as such.
    let fileGuard = null;
    if (!guard && forwarding) {
      const fm = src.match(/startsWith\s*\(\s*["'`]([^"'`]+)["'`][\s\S]{0,200}throw/);
      if (fm) fileGuard = { allowlist_prefix: fm[1], scope: "file_helper" };
    }
    r.exposures.push({
      global: key, file: label,
      forwards_ipc: forwarding,
      channel_arg_forwarded: forwarding && genericFwd,
      channel_guard: guard ? { allowlist_prefix: guard[1], enforced_by_throw: !!guardThrows } : fileGuard,
      slice_bytes: slice.length,
    });
  }

  // 3b. VS Code-family service-channel registry ---------------------------------
  // registerChannel("name", <channel-instance>) multiplexes privileged service
  // calls over the transport. The channel class body holds the real method
  // surface (case "cmd" literals inside call()/callHandler()).
  for (const m of src.matchAll(/\bregisterChannel\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    const name = m[1];
    const paren = src.indexOf("(", m.index + m[0].length - 1);
    const close = paren > 0 ? findBalanced(src, paren, "(", ")") : -1;
    const args = close > 0 ? src.slice(paren + 1, close) : "";
    const refExpr = splitTop(args)[1] ?? "";
    const refM = refExpr.match(/\bnew\s+(\w+)|^\s*(\w+)\s*$|\.(\w+)\s*\(/);
    const refIdent = refM?.[1] ?? refM?.[2] ?? refM?.[3] ?? null;
    const svc = { name, file: label, ref: refIdent, methods: [], sinks: [], sender_validation: "n/a" };
    // resolve the channel class in-file. Minified locals are rebound per
    // registration (`registerChannel("a",i)` where i=X.fromService(s,n)) —
    // scan BACKWARD from this call site for the nearest binding, then unwrap
    // DI factories to the service token (the class with the real methods).
    if (refIdent) {
      let target = refIdent;
      const prior = src.slice(Math.max(0, m.index - 4000), m.index);
      const inds = [...prior.matchAll(new RegExp(`\\b${refIdent}\\s*=\\s*[^;]{0,160}`, "g"))];
      const bind = inds.at(-1)?.[0] ?? "";
      const fs = bind.match(/fromService\s*\(\s*(\w+)/) ?? bind.match(/new\s+(\w+)/) ?? bind.match(/=\s*(\w+)\s*\(/);
      if (fs && fs[1] !== refIdent) target = fs[1];
      svc.ref = target;
      svc.binding = bind.slice(bind.indexOf("=") + 1).trim().slice(0, 120);
      const cls = src.match(new RegExp(`\\bclass ${target}\\b`))
        ?? src.match(new RegExp(`\\b(?:var|let|const|function)\\s+${target}\\b`))
        ?? src.match(new RegExp(`\\b${target}\\s*=\\s*`));
      if (!cls) svc.resolved_ref = `unresolved:${target}`;
      if (cls) {
        const brace = src.indexOf("{", cls.index);
        const bClose = brace > 0 ? findBalanced(src, brace, "{", "}") : -1;
        const body = bClose > 0 ? src.slice(brace, bClose) : src.slice(cls.index, cls.index + 15000);
        svc.methods = [...new Set([...body.matchAll(/\bcase\s+["'`]([^"'`]+)["'`]/g)].map((x) => x[1]))].slice(0, 60);
        if (!svc.methods.length)
          svc.methods = [...new Set([...body.matchAll(/\b(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/g)].map((x) => x[1]).filter((n) => !/^(if|for|while|switch|catch|function|return|constructor)$/.test(n)))].slice(0, 60);
        for (const [cls2, res] of Object.entries(SINKS))
          for (const re of res)
            if (re.test(body)) { svc.sinks.push({ class: cls2 }); break; }
      }
    }
    r.service_channels.push(svc);
  }

  // 3c. dual-path guard inconsistency --------------------------------------------
  // WorkBuddy pattern: the same dangerous sink (shell.openExternal/openPath,
  // exec) is reachable through multiple registration paths, where ONE path
  // validates args (scheme allowlist, extension blocklist) and a sibling path
  // does not — the unguarded path bypasses the sibling's policy. Detect per
  // sink class: count call sites with/without a guard marker in the preceding
  // ~600 chars.
  if (r.role === "main" || /ipcMain|BrowserWindow/.test(src)) {
    const GUARD = /startsWith\s*\(|ALLOWED|BLOCKED|allowlist|blocklist|protocol|scheme|new Set\(|isAllowed|allowedSchemes|canOpen|validate/i;
    const site = (re, cls) => {
      let g = 0, u = 0;
      for (const m of src.matchAll(re)) {
        const ctx = src.slice(Math.max(0, m.index - 600), m.index);
        GUARD.test(ctx) ? g++ : u++;
      }
      if (g > 0 && u > 1) r.misc_flags.push({ flag: `dual-path:${cls}:${g}guarded+${u}unguarded`, file: label });
    };
    site(/shell\.openExternal\s*\(/g, "openExternal");
    site(/shell\.openPath\s*\(/g, "openPath");
    // child-process sites only — bare .exec( matches regex.exec() everywhere
    site(/\bchild_process\.exec(?:File|Sync)?\s*\(|\bcp\.exec(?:File|Sync)?\s*\(|\bchild_process\.spawn(?:Sync)?\s*\(|\bcp\.spawn(?:Sync)?\s*\(|\bexecFile(?:Sync)?\s*\(/g, "process_spawn");
  }

  // 4. remote-content loading ---------------------------------------------------
  for (const m of src.matchAll(/\.loadURL\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/g))
    r.remote_loads.push({ kind: "loadURL", url: m[1].slice(0, 160), file: label });
  for (const m of src.matchAll(/\.loadURL\s*\(\s*(?!["'`])/g))
    r.remote_loads.push({ kind: "loadURL", url: { unresolved: true }, file: label });
  for (const m of src.matchAll(/openExternal\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/g))
    r.remote_loads.push({ kind: "openExternal", url: m[1].slice(0, 160), file: label });

  // navigation guards — presence is a positive control
  for (const m of src.matchAll(/\b(setWindowOpenHandler|will-navigate|new-window)\b/g))
    if (!r.nav_guards.includes(m[1])) r.nav_guards.push(m[1]);

  // 5. security-relevant flags outside webPreferences literals -------------------
  for (const [k, re] of Object.entries({
    "webSecurity:false": /\bwebSecurity\s*:\s*(?:!1|false)/,
    "contextIsolation:false": /\bcontextIsolation\s*:\s*(?:!1|false)/,
    "nodeIntegration:true": /\bnodeIntegration\s*:\s*(?:!0|true)/,
    "sandbox:false": /\bsandbox\s*:\s*(?:!1|false)/,
    "webviewTag:true": /\bwebviewTag\s*:\s*(?:!0|true)/,
    // TLS rules are precision-critical — the naive patterns produce FPs on
    // every VS Code-family app (argv schema declares the flag; proper
    // certificate-error handlers also call preventDefault to take control).
    // Only flag ACTUAL enablement/decision sites:
    "cert-switch-enabled": /appendSwitch\s*\(\s*["'`](?:ignore-certificate-errors|allow-insecure-localhost)["'`]/,
    "cert-verifyproc": /\bsetCertificateVerifyProc\s*\(/,
  })) {
    if (re.test(src)) r.misc_flags.push({ flag: k, file: label });
  }
  // certificate-error event handler: classify by decision shape.
  //   blanket bypass: preventDefault + unconditional callback(true)
  //   custom pinning: decision depends on hostname/fingerprint/trust check
  for (const m of src.matchAll(/["'`]certificate-error["'`]\s*,\s*[(\w]/g)) {
    const win = src.slice(m.index, m.index + 800);
    const unconditional = /\w+\s*\(\s*!0\s*\)|\w+\s*\(\s*true\s*\)/.test(win);
    const pinning = /hostname|fingerprint|isCertificateTrusted|verifyProc|thumbprint|sha256/i.test(win);
    r.misc_flags.push({
      flag: unconditional && !pinning ? "cert-handler-blanket-bypass"
        : pinning ? "cert-handler-custom-pinning" : "cert-handler-unknown",
      file: label,
    });
    break; // first handler is representative; duplicates deduped downstream
  }

  return r;
}

// ---- cross-file scoring -----------------------------------------------------
function scoreApp(files) {
  const channels = {};   // ch -> {sends, handlers, files}
  const exposures = [];
  const handlers = [];
  const svcChannels = [];
  const bulkIpc = [];
  const wps = [];
  const remote = [];
  const navGuards = new Set();
  const flags = new Set();
  const flagFiles = {};
  const roles = new Set(files.map((f) => f.role));

  for (const f of files) {
    for (const s of f.ipc_sites) {
      const c = (channels[s.channel] ??= { sends: [], handlers: [], listeners: [] });
      if (s.dir === "send") c.sends.push(s.file);
      else if (s.side === "main") c.handlers.push(s.file);
      else c.listeners.push(s.file);
    }
    for (const h of f.handlers) handlers.push(h);
    for (const e of f.exposures) exposures.push(e);
    for (const s of f.service_channels) svcChannels.push(s);
    if (f.bulk_ipc) bulkIpc.push({ file: f.file, ...f.bulk_ipc });
    for (const w of f.web_preferences) wps.push(w);
    for (const rl of f.remote_loads) remote.push(rl);
    for (const g of f.nav_guards) navGuards.add(g);
    for (const fl of f.misc_flags) {
      const key = typeof fl === "string" ? fl : fl.flag;
      flags.add(key);
      (flagFiles[key] ??= new Set()).add(typeof fl === "string" ? f.file : fl.file);
    }
  }

  const findings = [];
  const add = (rule, severity, confidence, title, detail, evidence) =>
    findings.push({ rule, severity, confidence, title, detail, evidence });

  // R1: wildcard IPC exposure through contextBridge ---------------------------
  // same global exposed from multiple preload files = one finding, all files.
  const exposureGroups = new Map();
  for (const e of exposures) {
    const dk = `${e.global}|${e.channel_guard?.allowlist_prefix ?? ""}|${e.channel_arg_forwarded}`;
    if (!exposureGroups.has(dk)) exposureGroups.set(dk, { ...e, files: [e.file] });
    const g = exposureGroups.get(dk);
    if (g.files.at(-1) !== e.file) g.files.push(e.file);
  }
  for (const e of exposureGroups.values()) {
    e.file = e.files.join(",");
    if (e.channel_arg_forwarded && e.channel_guard)
      add("gated-wildcard-exposure", "medium", CONF.OBSERVED,
        `contextBridge global "${e.global}" forwards channel names gated to prefix "${e.channel_guard.allowlist_prefix}"`,
        `The bridge passes caller-controlled channel names to ipcRenderer but enforces a "${e.channel_guard.allowlist_prefix}" allowlist${e.channel_guard.enforced_by_throw ? " (throw on mismatch)" : " (enforcement mechanism unresolved)"}. Any compromised renderer can still reach every privileged handler under that namespace — including internal service channels not meant for untrusted input.`,
        { file: e.file, global: e.global, guard: e.channel_guard });
    else if (e.channel_arg_forwarded)
      add("wildcard-ipc-exposure", "critical", CONF.OBSERVED,
        `contextBridge global "${e.global}" forwards caller-controlled channel names to ipcRenderer`,
        "A renderer with any code execution can reach EVERY ipcMain handler — including internal ELECTRON_* channels — through this bridge. This is the exact Discord 2020 RCE exposure class.",
        { file: e.file, global: e.global });
    else if (e.forwards_ipc)
      add("ipc-forwarding-exposure", "high", CONF.OBSERVED,
        `contextBridge global "${e.global}" wraps ipcRenderer`,
        "Bridge exposes ipcRenderer functionality. Whether channels are caller-controlled is unresolved — audit the exposed member signatures.",
        { file: e.file, global: e.global });
  }

  // R1b: multiplexed service channels (VS Code-family registerChannel) --------
  for (const s of svcChannels) {
    if (s.sinks.length)
      add("service-channel-sink", "high", CONF.DERIVED,
        `service channel "${s.name}" resolves to ${s.sinks.map((x) => x.class).join("/")} sink(s)`,
        `registerChannel("${s.name}") is callable from any renderer connected to the transport. Its channel class touches ${s.sinks.map((x) => x.class).join(", ")}.${s.methods.length ? ` Callable commands: ${s.methods.slice(0, 12).join(", ")}${s.methods.length > 12 ? "…" : ""}` : " Command names unresolved."}`,
        { file: s.file, channel: s.name, ref: s.ref, methods: s.methods.slice(0, 20), sinks: s.sinks });
  }

  // R2: dangerous window flags -------------------------------------------------
  const wpFlags = (key) => {
    const hits = wps.filter((w) => w.keys[key] !== undefined);
    return { hits, anyTrue: hits.filter((w) => w.keys[key] === true), anyFalse: hits.filter((w) => w.keys[key] === false) };
  };
  const ci = wpFlags("contextIsolation");
  if (ci.anyFalse.length)
    add("contextIsolation-off", "high", CONF.OBSERVED,
      "contextIsolation explicitly disabled",
      `${ci.anyFalse.length} webPreferences block(s) set contextIsolation:false — preload and page share a world; any XSS reaches the full preload surface.`,
      { files: ci.anyFalse.map((w) => w.file) });
  const ni = wpFlags("nodeIntegration");
  if (ni.anyTrue.length)
    add("nodeIntegration-on", "high", CONF.OBSERVED,
      "nodeIntegration enabled",
      `${ni.anyTrue.length} window(s) run with nodeIntegration:true — XSS becomes RCE directly.`,
      { files: ni.anyTrue.map((w) => w.file) });
  const ws = wpFlags("webSecurity");
  if (ws.anyFalse.length)
    add("webSecurity-off", "high", CONF.OBSERVED,
      "webSecurity disabled",
      "webSecurity:false removes same-origin policy — remote content can read local files and cross-origin responses.",
      { files: ws.anyFalse.map((w) => w.file) });
  const wt = wpFlags("webviewTag");
  if (wt.anyTrue.length)
    add("webviewTag-on", "medium", CONF.OBSERVED,
      "webviewTag enabled", "webviewTag:true embeds second-class renderers with their own preload/security posture — historically a top Electron bug source.",
      { files: wt.anyTrue.map((w) => w.file) });
  const sb = wpFlags("sandbox");
  if (sb.anyFalse.length)
    add("sandbox-off", "medium", CONF.OBSERVED,
      "renderer sandbox disabled in some window(s)",
      "sandbox:false removes the OS-level containment on that renderer.",
      { files: sb.anyFalse.map((w) => w.file) });
  // file-level dangerous flags that never landed inside a parsed
  // webPreferences block (conditional/dynamic construction) still count.
  const flagToRule = {
    "contextIsolation:false": ["contextIsolation-off", "high", "contextIsolation:false observed outside a parsed webPreferences block"],
    "nodeIntegration:true": ["nodeIntegration-on", "high", "nodeIntegration:true observed outside a parsed webPreferences block"],
    "webSecurity:false": ["webSecurity-off", "high", "webSecurity:false observed outside a parsed webPreferences block"],
    "sandbox:false": ["sandbox-off", "medium", "sandbox:false observed outside a parsed webPreferences block"],
    "webviewTag:true": ["webviewTag-on", "medium", "webviewTag:true observed outside a parsed webPreferences block"],
  };
  for (const [fl, [rule, sev, title]] of Object.entries(flagToRule)) {
    if (!flags.has(fl)) continue;
    if (findings.some((x) => x.rule === rule)) continue;
    add(rule, sev, CONF.INFERRED, title,
      "The flag literal appears in the bundle but not inside any webPreferences object the parser bound — the window it applies to is unresolved.",
      { files: [...(flagFiles[fl] ?? [])] });
  }
  for (const fl of flags) {
    if (fl === "cert-switch-enabled")
      add("tls-validation-weakened", "high", CONF.OBSERVED,
        "certificate validation disabled via command-line switch",
        "The app calls appendSwitch(\"ignore-certificate-errors\"/\"allow-insecure-localhost\") — TLS verification is off for all webContents, enabling MITM of app traffic including update channels.",
        { files: [...(flagFiles[fl] ?? [])] });
    if (fl === "cert-handler-blanket-bypass")
      add("tls-validation-weakened", "high", CONF.OBSERVED,
        "certificate-error handler accepts all certificates unconditionally",
        "A certificate-error listener calls preventDefault and the allow callback without checking hostname/fingerprint — a blanket bypass.",
        { files: [...(flagFiles[fl] ?? [])] });
    if (fl === "cert-verifyproc")
      add("custom-cert-verifyproc", "medium", CONF.INFERRED,
        "setCertificateVerifyProc installed — decision logic needs manual review",
        "A custom certificate verifier exists. Whether it enforces pinning (correct) or rubber-stamps (bypass) is unresolved at this analysis depth.",
        { files: [...(flagFiles[fl] ?? [])] });
    if (fl === "cert-handler-custom-pinning")
      add("custom-cert-pinning-present", "info", CONF.OBSERVED,
        "certificate-error handler implements custom trust checks (possible pinning)",
        "Hostname/fingerprint-based decision logic observed — consistent with certificate pinning, not a bypass. Recorded as a positive control.",
        { files: [...(flagFiles[fl] ?? [])] });
    if (fl.startsWith("dual-path:")) {
      const [, cls, counts] = fl.split(":");
      const unguarded = Number(counts?.match(/(\d+)unguarded/)?.[1] ?? 0);
      add("inconsistent-sink-validation", unguarded >= 4 ? "high" : "medium", CONF.OBSERVED,
        `${cls} reachable via multiple paths with inconsistent argument validation (${counts})`,
        `The same ${cls} sink is invoked from several call sites; some are preceded by allowlist/blocklist checks and some are not. When a sibling path enforces a policy the unguarded path bypasses it entirely — a classic "two registration paths, one guarded" pattern (verified live on Tencent WorkBuddy: direct-IPC had scheme allowlist + executable blocklist, the RPC path had neither).`,
        { files: [...(flagFiles[fl] ?? [])] });
    }
  }

  // R3: unvalidated handlers that touch sinks ----------------------------------
  for (const h of handlers) {
    if (h.sender_validation.status === "observed") continue;
    if (!h.sinks.length) continue;
    const conf = h.sender_validation.status === "unknown" ? CONF.INFERRED : CONF.DERIVED;
    const pairedSend = channels[h.channel]?.sends?.length > 0;
    add("unvalidated-sink-handler", "high", conf,
      `ipcMain handler "${h.channel}" reaches ${h.sinks.map((s) => s.class).join("/")} sink(s) with no observed sender validation`,
      `Channel ${pairedSend ? "has a matching renderer call site" : "has NO observed renderer call site (may be internal-only or dynamically named)"}. Absence of senderFrame/sender.getURL checks means any compromised renderer can drive it.`,
      { file: h.file, channel: h.channel, sinks: h.sinks.slice(0, 4), sender_validation: h.sender_validation.status });
  }

  // R4: remote content + IPC surface coexistence --------------------------------
  const remoteLits = remote.filter((x) => typeof x.url === "string" && /^https?:/.test(x.url));
  const chCount = Object.keys(channels).length;
  if (remoteLits.length && chCount)
    add("remote-content-with-ipc", "medium", CONF.INFERRED,
      `app loads remote content (${remoteLits.length} literal remote URL(s)) while exposing ${chCount} IPC channel(s)`,
      "Remote-loadable content and a privileged IPC surface coexist in this build. Whether any remote-reachable window can reach the handlers is unresolved — that requires runtime window/process mapping.",
      { remote_urls: remoteLits.slice(0, 5).map((x) => x.url), channels: chCount });

  // R5: navigation guard presence -------------------------------------------------
  if (navGuards.size === 0 && chCount > 0)
    add("no-navigation-guards", "medium", CONF.INFERRED,
      "no setWindowOpenHandler / will-navigate handlers found",
      "Absence may be real (navigation unguarded) or hidden behind wrappers/framework code — minified Electron code often registers these via helpers. Treat as an audit lead, not a verdict.",
      {});

  // R6: channel pairing report (informational) -------------------------------------
  const unpairedSends = Object.entries(channels).filter(([, c]) => c.sends.length && !c.handlers.length).map(([ch]) => ch);
  const unpairedHandlers = Object.entries(channels).filter(([, c]) => c.handlers.length && !c.sends.length).map(([ch]) => ch);
  if (unpairedSends.length)
    add("unpaired-renderer-sends", "info", CONF.DERIVED,
      `${unpairedSends.length} channel(s) sent but no handler found`,
      "Either the handler lives in an unscanned file/native module, or the channel is registered dynamically.", { channels: unpairedSends.slice(0, 30) });
  if (unpairedHandlers.length)
    add("handler-without-observed-caller", "info", CONF.DERIVED,
      `${unpairedHandlers.length} handler(s) with no observed renderer send`,
      "Internal channels or dynamically-composed names — potentially reachable only via wildcard bridges (see wildcard-ipc-exposure).", { channels: unpairedHandlers.slice(0, 30) });

  // R6b: bulk IPC registration — whole service registry becomes handlers ----
  for (const b of bulkIpc) {
    add("bulk-ipc-registration", "high", CONF.OBSERVED,
      `entire service registry exposed as IPC handlers${b.event_discarded ? " with the event argument discarded" : ""}`,
      `${b.file} registers every entry of a services map via ipcMain.handle — sender validation is ${b.event_discarded ? "structurally absent (parameter ignored)" : "unverified"}. ${b.computed_handler_count} computed-name handler(s) found in-file; combined with any renderer compromise + an ungated invoke bridge, every service method is callable.`,
      { file: b.file, computed_handlers: b.computed_handler_count });
  }

  // R7: the synthesized reachability verdict — connect the gated bridge to
  // the privileged surface it gates. THIS is the reasoning layer: a gated
  // wildcard for prefix P + N service channels + M transport channels under
  // P = every one of them callable from any compromised renderer.
  const ungatedExposure = exposures.some((e) => e.channel_arg_forwarded && !e.channel_guard);
  const bulkTotal = bulkIpc.reduce((n, b) => n + b.computed_handler_count, 0);
  if (ungatedExposure && bulkTotal)
    add("renderer-to-full-service-registry", "critical", CONF.OBSERVED,
      `ungated invoke bridge + bulk-registered service registry = ${bulkTotal} privileged methods callable from any compromised renderer`,
      `An unguarded contextBridge passthrough (wildcard-ipc-exposure) meets a DI registry where every entry is ipcMain.handle()'d with the event argument discarded. A single XSS, hostile webview, or navigation escape in the window holding the bridge yields the entire privileged surface — file writes, installs, credential and license operations — with no per-channel checks possible.`,
      { computed_handlers: bulkTotal });
  const gatedPrefix = [...new Set(exposures.filter((e) => e.channel_arg_forwarded && e.channel_guard).map((e) => e.channel_guard.allowlist_prefix))];
  const vscodeNsChannels = Object.keys(channels).filter((c) => gatedPrefix.some((p) => c.startsWith(p)));
  const svcTotal = new Set(svcChannels.map((s) => s.name)).size;
  if ((gatedPrefix.length || ungatedExposure) && (svcTotal || vscodeNsChannels.length)) {
    const resolved = svcChannels.filter((s) => !s.resolved_ref || !String(s.resolved_ref).startsWith("unresolved:")).length;
    add("bridgeable-privileged-surface", "high", CONF.DERIVED,
      `compromised renderer can reach ${svcTotal} registered service channel(s) + ${vscodeNsChannels.length} literal transport channel(s) via the exposed bridge`,
      `The preload forwards caller-controlled channel names${gatedPrefix.length ? ` gated to ${gatedPrefix.map((p) => `"${p}"`).join(", ")}` : " ungated"}. ` +
      `All ${svcTotal} registerChannel service(s) and ${vscodeNsChannels.length} literal channel(s) in that namespace are callable: a single XSS/navigation bug in any remote-loading window yields the full privileged surface. ` +
      `Channel-class resolution: ${resolved}/${svcChannels.length} resolved in-file (rest are DI tokens behind cross-module bindings — method-level sink analysis unresolved, not absent).`,
      { gated_prefixes: gatedPrefix, service_channels: [...new Set(svcChannels.map((s) => s.name))].slice(0, 40), literal_channels_in_scope: vscodeNsChannels.slice(0, 40) });
  }

  // R8: preload↔window wiring unresolved ------------------------------------------
  const preloadPaths = wps.flatMap((w) => typeof w.keys.preload === "string" ? [w.keys.preload] : []);
  const scannedPreloads = files.filter((f) => f.role === "preload").map((f) => f.file);
  if (preloadPaths.length && !scannedPreloads.length)
    add("preload-not-scanned", "info", CONF.DERIVED,
      "webPreferences reference preload scripts not in scan set",
      `Wiring: ${[...new Set(preloadPaths)].slice(0, 8).join(", ")} — rescan including those files to close the exposure edge.`,
      { preload_paths: [...new Set(preloadPaths)].slice(0, 8) });

  return {
    findings,
    service_channels: svcChannels.map((s) => ({ name: s.name, file: s.file, resolved_ref: s.resolved_ref ?? s.ref, binding: s.binding ?? null, methods: s.methods, sinks: s.sinks })),
    stats: {
      files_scanned: files.length,
      roles_seen: [...roles],
      web_preferences_blocks: wps.length,
      ipc_channels: chCount,
      main_handlers: handlers.length,
      service_channels: svcChannels.length,
      exposed_globals: exposures.length,
      remote_url_literals: remoteLits.length,
      nav_guard_tokens: [...navGuards],
      misc_flags: [...flags],
    },
  };
}

// ---- markdown render ---------------------------------------------------------
const SEV_ORDER = { critical: 0, high: 1, medium: 2, info: 3 };
function renderMd(audit) {
  const f = [...audit.findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const lines = [
    "# Attack surface audit",
    "",
    `Files scanned: ${audit.stats.files_scanned} · IPC channels: ${audit.stats.ipc_channels} · main handlers: ${audit.stats.main_handlers} · exposed globals: ${audit.stats.exposed_globals} · remote URL literals: ${audit.stats.remote_url_literals}`,
    "",
    `Findings: ${f.filter((x) => x.severity === "critical").length} critical / ${f.filter((x) => x.severity === "high").length} high / ${f.filter((x) => x.severity === "medium").length} medium / ${f.filter((x) => x.severity === "info").length} info`,
    "",
  ];
  for (const x of f) {
    lines.push(`## [${x.severity.toUpperCase()}] ${x.title}`);
    lines.push(`_rule: ${x.rule} · confidence: ${x.confidence}_`);
    lines.push("");
    lines.push(x.detail);
    if (x.evidence && Object.keys(x.evidence).length)
      lines.push("", "```json", JSON.stringify(x.evidence, null, 1).slice(0, 1200), "```");
    lines.push("");
  }
  lines.push("---");
  lines.push("_Confidence tiers: observed = direct literal evidence; derived = cross-file join; inferred = heuristic, audit lead only; unknown = explicitly unresolved._");
  return lines.join("\n");
}

// ---- diff mode ----------------------------------------------------------------
// Findings keyed by (rule, subject) — subject = channel/global/flag so the
// same class on a different channel is a distinct finding.
function findingKey(f) {
  const subj = f.evidence?.channel ?? f.evidence?.global ?? f.title.match(/"([^"]+)"/)?.[1] ?? f.title;
  return `${f.rule}|${subj}`;
}
export function diffAudits(oldA, newA) {
  const o = new Map(oldA.findings.map((f) => [findingKey(f), f]));
  const n = new Map(newA.findings.map((f) => [findingKey(f), f]));
  const added = [...n.keys()].filter((k) => !o.has(k)).map((k) => n.get(k));
  const removed = [...o.keys()].filter((k) => !n.has(k)).map((k) => o.get(k));
  const changed = [...n.keys()].filter((k) => o.has(k) && (o.get(k).severity !== n.get(k).severity || o.get(k).confidence !== n.get(k).confidence)).map((k) => ({ before: o.get(k), after: n.get(k) }));
  // privileged surface delta: service channels added/removed between releases —
  // "new callable surface this release" is the security-meaningful diff.
  const svcO = new Map((oldA.service_channels ?? []).map((s) => [s.name, s]));
  const svcN = new Map((newA.service_channels ?? []).map((s) => [s.name, s]));
  const svcAdded = [...svcN.keys()].filter((k) => !svcO.has(k));
  const svcRemoved = [...svcO.keys()].filter((k) => !svcN.has(k));
  return { added, removed, changed, svc_added: svcAdded, svc_removed: svcRemoved,
    summary: `+${added.length} / -${removed.length} / ~${changed.length} findings; service channels +${svcAdded.length}/-${svcRemoved.length} (${oldA.version} -> ${newA.version})` };
}

// ---- CLI ---------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("audit-electron.mjs")) {
  const argv = process.argv.slice(2);
  const dIdx = argv.indexOf("--diff");
  if (dIdx >= 0) {
    const [a, b] = argv.slice(dIdx + 1, dIdx + 3).map((f) => JSON.parse(readFileSync(f, "utf8")));
    const d = diffAudits(a, b);
    const sev = (x) => `[${x.severity.toUpperCase()}]`;
    console.log(`# attack surface diff ${a.version} -> ${b.version}\n`);
    console.log(d.summary, "\n");
    for (const f of d.added) console.log(`+ ${sev(f)} ${f.title}`);
    for (const f of d.removed) console.log(`- ${sev(f)} ${f.title}`);
    for (const c of d.changed) console.log(`~ ${sev(c.after)} ${c.after.title} (${c.before.severity}/${c.before.confidence} -> ${c.after.severity}/${c.after.confidence})`);
    if (d.svc_added.length) console.log(`\n## new service channels\n${d.svc_added.map((s) => `+ ${s}`).join("\n")}`);
    if (d.svc_removed.length) console.log(`\n## removed service channels\n${d.svc_removed.map((s) => `- ${s}`).join("\n")}`);
    process.exit(0);
  }
  const args = argv;
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
  const mdIdx = args.indexOf("--md");
  const mdOut = mdIdx >= 0 ? args.splice(mdIdx, 2)[1] : null;
  const appIdx = args.indexOf("--app");
  const app = appIdx >= 0 ? args.splice(appIdx, 2)[1] : "unknown";
  const verIdx = args.indexOf("--version");
  const version = verIdx >= 0 ? args.splice(verIdx, 2)[1] : "unknown";
  const lfIdx = args.indexOf("--files");
  const listFile = lfIdx >= 0 ? args.splice(lfIdx, 2)[1] : null;
  const files = args.filter((a) => !a.startsWith("--"));
  if (listFile) for (const l of readFileSync(listFile, "utf8").split("\n")) if (l.trim()) files.push(l.trim());

  const results = files.map((f) => auditFile(readFileSync(f, "utf8"), basename(dirname(f)) + "/" + basename(f)));
  const audit = {
    generated_by: "wirecat audit-electron", app, version,
    scope_note: "boundary-protocol reachability + bounded intra-handler scan; NOT whole-program taint. Absence of a finding is not proof of safety.",
    ...scoreApp(results),
    per_file: results.map((f) => ({
      file: f.file, role: f.role,
      web_preferences_blocks: f.web_preferences.length,
      ipc_sites: f.ipc_sites.length, handlers: f.handlers.length,
      exposures: f.exposures.length, remote_loads: f.remote_loads.length,
      misc_flags: f.misc_flags,
    })),
  };
  const json = JSON.stringify(audit, null, 1);
  if (out) writeFileSync(out, json); else process.stdout.write(json);
  if (mdOut) writeFileSync(mdOut, renderMd(audit));
  const sev = {};
  for (const x of audit.findings) sev[x.severity] = (sev[x.severity] ?? 0) + 1;
  console.error(`[audit] ${audit.stats.ipc_channels} channels, ${audit.stats.main_handlers} handlers, findings: ${JSON.stringify(sev)}`);
}
