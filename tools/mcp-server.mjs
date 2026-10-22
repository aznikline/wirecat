#!/usr/bin/env node
// wirecat MCP adapter — stdio JSON-RPC exposing the audit/extract/diff
// tools to any MCP-capable agent (Claude Code, Devin, ARTEX mcphttp).
// Zero deps: hand-rolled JSON-RPC framing per MCP spec (newline-delimited
// JSON is NOT the spec — stdio transport uses headerless JSON-RPC 2.0
// messages, one per line, Content-Length framing optional; we accept both
// newline-delimited and Content-Length-framed input, emit newline-delimited).
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AUDIT = resolve(ROOT, "tools/audit-electron.mjs");
const EXTRACT = resolve(ROOT, "tools/extract-bundle-protos.mjs");
const DIFF = resolve(ROOT, "tools/diff-catalogs.mjs");
const EMIT = resolve(ROOT, "tools/emit-proto.mjs");

// ---- tool registry ---------------------------------------------------------
const TOOLS = [
  {
    name: "wirecat_audit",
    description: "Static attack-surface audit of an extracted Electron app directory (asar output or unpacked app/). Finds ungated contextBridge IPC passthroughs, bulk ipcMain service-registry registration, unvalidated handlers reaching file/exec sinks, weak webPreferences, dual-path guard inconsistencies. Returns a markdown findings report; full JSON is written to --out if given.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "directory containing extracted app bundle" },
        app: { type: "string", description: "app name label" },
        version: { type: "string", description: "app version label" },
        out: { type: "string", description: "optional path to write audit JSON" },
      },
      required: ["target", "app", "version"],
    },
    run(a) {
      const files = spawnSync("find", [a.target, "-type", "f", "(", "-name", "*.js", "-o", "-name", "*.cjs", ")", "!", "-path", "*node_modules*"], { encoding: "utf8" });
      if (files.status !== 0) return err(`find failed: ${files.stderr}`);
      const listFile = `/tmp/wc-${a.app}-files.txt`;
      writeFileSync(listFile, files.stdout);
      const args = [AUDIT, "--files", listFile, "--app", a.app, "--version", a.version];
      if (a.out) args.push("--out", a.out);
      const r = spawnSync("node", args, { encoding: "utf8", maxBuffer: 64 << 20 });
      if (r.status !== 0) return err(r.stderr || r.stdout);
      return ok(r.stdout + (r.stderr ? `\n${r.stderr}` : ""));
    },
  },
  {
    name: "wirecat_audit_diff",
    description: "Diff two wirecat audit JSON reports (findings added/removed/changed + service-channel delta) — answers 'what attack surface did this release add'.",
    inputSchema: {
      type: "object",
      properties: {
        old_audit: { type: "string", description: "path to older audit JSON" },
        new_audit: { type: "string", description: "path to newer audit JSON" },
      },
      required: ["old_audit", "new_audit"],
    },
    run(a) {
      const r = spawnSync("node", [AUDIT, "--diff", a.old_audit, a.new_audit], { encoding: "utf8", maxBuffer: 32 << 20 });
      if (r.status !== 0) return err(r.stderr || r.stdout);
      return ok(r.stdout);
    },
  },
  {
    name: "wirecat_extract_protos",
    description: "Extract protobuf service/message/enum descriptors embedded in JS bundles (protobuf-es/protobuf-ts/protobufjs codegen) plus IPC site and endpoint vocabulary into a catalog JSON.",
    inputSchema: {
      type: "object",
      properties: {
        files_list: { type: "string", description: "path to a file containing newline-separated JS file paths" },
        app: { type: "string" }, version: { type: "string" },
        out: { type: "string", description: "path to write catalog JSON" },
      },
      required: ["files_list", "app", "version", "out"],
    },
    run(a) {
      const r = spawnSync("node", [EXTRACT, "--files", a.files_list, "--app", a.app, "--version", a.version, "--out", a.out], { encoding: "utf8", maxBuffer: 64 << 20 });
      if (r.status !== 0) return err(r.stderr || r.stdout);
      return ok(r.stdout + (r.stderr ? `\n${r.stderr}` : ""));
    },
  },
  {
    name: "wirecat_catalog_diff",
    description: "Diff two protocol catalogs (service/method/field/IPC/endpoint-host changes between app versions).",
    inputSchema: {
      type: "object",
      properties: {
        old_catalog: { type: "string" }, new_catalog: { type: "string" },
      },
      required: ["old_catalog", "new_catalog"],
    },
    run(a) {
      const r = spawnSync("node", [DIFF, a.old_catalog, a.new_catalog], { encoding: "utf8", maxBuffer: 32 << 20 });
      if (r.status !== 0) return err(r.stderr || r.stdout);
      return ok(r.stdout);
    },
  },
  {
    name: "wirecat_emit_proto",
    description: "Emit compilable .proto3 files from a wirecat catalog JSON.",
    inputSchema: {
      type: "object",
      properties: {
        catalog: { type: "string" }, out_dir: { type: "string" },
      },
      required: ["catalog", "out_dir"],
    },
    run(a) {
      const r = spawnSync("node", [EMIT, a.catalog, "--out-dir", a.out_dir], { encoding: "utf8", maxBuffer: 32 << 20 });
      if (r.status !== 0) return err(r.stderr || r.stdout);
      return ok(r.stdout);
    },
  },
  {
    name: "wirecat_list_audits",
    description: "List committed audit reports in the repo (audits/<app>/<version>.json) — the running corpus.",
    inputSchema: { type: "object", properties: {} },
    run() {
      const dir = resolve(ROOT, "audits");
      if (!existsSync(dir)) return ok("no audits/ directory");
      const out = [];
      for (const app of readdirSync(dir)) {
        for (const f of readdirSync(resolve(dir, app)).filter((f) => f.endsWith(".json")))
          out.push(`${app}/${f}`);
      }
      return ok(out.join("\n") || "none");
    },
  },
];

function ok(text) { return { content: [{ type: "text", text }] }; }
function err(text) { return { content: [{ type: "text", text: `ERROR: ${text}` }], isError: true }; }

// ---- JSON-RPC over stdio ----------------------------------------------------
const SERVER_INFO = { name: "wirecat", version: "0.1.0" };
const CAPS = { tools: { listChanged: false } };

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { buf += chunk; drain(); });
process.stdin.on("end", () => process.exit(0));

function drain() {
  // Accept newline-delimited JSON-RPC and Content-Length framing.
  for (;;) {
    if (buf.startsWith("Content-Length:")) {
      const nl = buf.indexOf("\r\n\r\n");
      const nl2 = buf.indexOf("\n\n");
      const end = nl >= 0 ? nl : nl2;
      if (end < 0) return;
      const len = parseInt(buf.slice(15, end), 10);
      const start = end + (nl >= 0 ? 4 : 2);
      if (buf.length < start + len) return;
      const body = buf.slice(start, start + len);
      buf = buf.slice(start + len);
      handle(body);
    } else {
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handle(line);
    }
  }
}

function handle(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const { id, method, params } = msg;
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  const fail = (code, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");

  if (id === undefined || id === null) return; // notification — ignore (initialized, etc.)

  switch (method) {
    case "initialize":
      return reply({ protocolVersion: params?.protocolVersion ?? "2024-11-05", capabilities: CAPS, serverInfo: SERVER_INFO });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const t = TOOLS.find((x) => x.name === params?.name);
      if (!t) return fail(-32602, `unknown tool: ${params?.name}`);
      try { return reply(t.run(params?.arguments ?? {})); }
      catch (e) { return reply(err(String(e?.message ?? e))); }
    }
    case "resources/list": return reply({ resources: [] });
    case "prompts/list": return reply({ prompts: [] });
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}
