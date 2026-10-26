#!/usr/bin/env node
// Wirecat auditor: HTTP route × authorization-guard inventory for Node services.
// Usage: node tools/audit-routes.mjs <src-or-dir> [...] --out audit.json [--md audit.md]
//
// Answers the question reviewers ask by hand:
//   "which registered HTTP routes reach a handler with no auth/scope guard
//    in the registration chain, and what do those handlers touch?"
//
// Two registration styles are recovered statically:
//   express/koa chains  — app.get(path, ...middleware, handler), app.use(prefix, router)
//   decorator classes   — @RestController(base) + @Get/@Post/... methods with
//                         guard decorators (@GlobalScope, @UseGuards, @Licensed, ...)
//
// Router→prefix joins are made same-file (observed) and across imports (derived).
// Findings carry the same confidence tiers as audit-electron:
// observed / derived / inferred / unknown. Unknowns stay unknown.
//
// NOT middleware-coverage proof. 'unguarded' means no guard token in the
// registration chain — a global app.use(auth) mounted elsewhere is only ever
// recorded as inferred coverage. Absence of a finding is not proof of safety.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

// ---- balanced-scan helpers (same model as audit-electron) --------------------
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
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === sep && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
  }
  const last = body.slice(start).trim();
  if (last) out.push(last);
  return out;
}

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") line++;
  return line;
}

// Walk backwards over contiguous decorator lines above a match — decorators
// stacked BEFORE the route decorator (@Licensed above @Put) count too.
function decoratorsAbove(src, matchIndex) {
  const names = [];
  let pos = matchIndex - 1;
  while (pos > 0) {
    const lineStart = src.lastIndexOf("\n", pos) + 1;
    const line = src.slice(lineStart, pos + 1);
    const trimmed = line.trim();
    if (trimmed === "") { pos = lineStart - 2; continue; }
    const dm = trimmed.match(/^@(\w+)\s*(\(([\s\S]*)\))?\s*$/);
    if (dm) {
      names.unshift(dm[1]);
      pos = lineStart - 2;
      continue;
    }
    break;
  }
  return names;
}

const CONF = { OBSERVED: "observed", DERIVED: "derived", INFERRED: "inferred", UNKNOWN: "unknown" };

// ---- vocabularies ------------------------------------------------------------
// Identifier fragments that mean "this middleware checks the caller". Kept loose
// — a false 'guarded' mark costs less than a missed hole; the route matrix still
// shows which token matched so a human can veto it.
const GUARD_RE =
  /auth|authenticat|guard|scope|permission|policy|rbac|jwt|passport|login|session|licensed|rate.?limit|throttl|csrf|mfa|verifytoken|requireauth|ensureauth|authorize|acl|secure|apikey|signature|hmac/i;

// Decorators that declare a route explicitly open (n8n/Nest idioms).
const OPEN_DECORATOR_RE =
  /^(public|skipauth|noauth|anonymous|allowskipmfa|unauthenticated|open)$/i;
// Option keys inside route-decorator options objects with the same meaning.
const OPEN_OPTION_RE = /\b(skipAuth|allowSkipAuth|allowSkipMFA|public|anonymous)\s*:\s*true\b/i;
// Decorator names that carry a protective scope/permission assertion.
const GUARD_DECORATOR_RE =
  /scope|guard|licensed|ratelimit|permission|role|policy|middleware|mfa|throttl|apikey/i;

// Sinks reachable inside a handler body = requester-controllable effect.
const HANDLER_SINKS = {
  code_exec: [
    /\bchild_process\b/, /\bexecFile\s*\(/, /\bexecSync\s*\(/, /\bspawnSync\s*\(/,
    /\bspawn\s*\(/, /\bexec\s*\(/, /\beval\s*\(/, /\bnew Function\s*\(/,
    /\bvm\.(?:runInNewContext|runInContext|runInThisContext)\s*\(/,
    /\brequire\s*\(\s*req\./,
  ],
  file_rw: [
    /\breadFile(Sync)?\s*\(/, /\bwriteFile(Sync)?\s*\(/, /\bcreateReadStream\s*\(/,
    /\bcreateWriteStream\s*\(/, /\.unlink(Sync)?\s*\(/, /\.rm\s*\(/,
    /\.rename(Sync)?\s*\(/, /\.mkdir(Sync)?\s*\(/,
  ],
  sql_template: [
    /(?:query|execute|raw)\s*\(\s*`[^`]*\$\{/,
    /(?:query|execute|raw)\s*\(\s*["'`][^"'`]*\+\s*req\./,
  ],
  redirect: [/\bres\.redirect\s*\(/, /\bctx\.redirect\s*\(/, /\.setHeader\s*\(\s*["'`]location/i],
  ssrf: [
    /\bfetch\s*\(/, /\baxios\.\w+\s*\(/, /\bgot\s*\(/, /\brequest\s*\(/,
    /\bhttp\.request\s*\(/, /\bhttps\.request\s*\(/,
  ],
  render: [
    /\bres\.render\s*\(/, /\bres\.send\s*\(\s*req\./, /\binnerHTML\b/,
  ],
};

const MUTATION_METHODS = new Set(["post", "put", "patch", "delete"]);
const HTTP_METHODS = "(get|post|put|patch|delete|all|options|head)";

// Dynamic method dispatch keyed by request input: methods[req.body.x](),
// obj[req.query.fn].call(...) — the classic loadOptions-confusion class.
const DYNAMIC_DISPATCH_RE =
  /\[[^\]]*\b(?:req|ctx)\.(?:body|query|params)[^\]]*\]\s*(?:\(|\.call|\.apply|\.bind)/;
// Greedy path params that change route matching semantics: /team/{id:path}, /x/*
const GREEDY_PARAM_RE = /[:{][\w]+:path\b|\{[\w]+\.\.\.\}|\*+/;

// ---- file collection ---------------------------------------------------------
function collectFiles(inputs) {
  const out = [];
  const seen = new Set();
  const walk = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      const name = basename(p);
      if (name === "node_modules" || name === ".git" || name === "dist" || name === ".next") return;
      for (const e of readdirSync(p)) walk(join(p, e));
      return;
    }
    const ext = extname(p);
    if (![".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(ext)) return;
    if (p.endsWith(".d.ts")) return;
    const abs = resolve(p);
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  };
  for (const i of inputs) walk(i);
  return out;
}

// ---- decorator-style extraction (NestJS / n8n @RestController) ---------------
function extractDecorated(src) {
  const classes = [];
  const routes = [];

  // Class-level: @RestController('/base') [, options] followed by stacked
  // decorators up to `class` — those guards apply to every method.
  const classRe = /@(?:RestController|Controller|PublicApiController)\s*\(\s*(['"`])([^'"`]*)\1/g;
  let m;
  while ((m = classRe.exec(src))) {
    const clsStart = src.indexOf("class", m.index + m[0].length);
    const windowEnd = clsStart >= 0 ? clsStart : m.index + m[0].length + 400;
    const decoWindow = src.slice(m.index + m[0].length, windowEnd);
    const decoNames = [
      ...decoratorsAbove(src, m.index),
      ...[...decoWindow.matchAll(/@(\w+)\s*(?:\([^)]*\))?/g)].map((d) => d[1]),
    ];
    classes.push({ base: m[2], decorators: decoNames, index: m.index });
  }
  if (!classes.length) return routes;
  const cls = classes[classes.length - 1]; // one controller class per file is the norm
  const classGuarded = cls.decorators.some((d) => GUARD_DECORATOR_RE.test(d));
  const classOpen = cls.decorators.some((d) => OPEN_DECORATOR_RE.test(d));

  // Method-level: @Get('/x') [, {opts}] then an explicit run of stacked
  // decorators (@ProjectScope(...), @Licensed(...), ...) up to the signature.
  // The decorator run is consumed literally so \w+\( cannot stop early on a
  // decorator name.
  const methRe =
    /@(Get|Post|Put|Patch|Delete|All|Options|Head)\s*\(\s*(['"`])([^'"]*)\2(\s*,\s*([\s\S]{0,300}?))?\)((?:\s*@\w+\s*(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?)*)\s*(?:(?:public|private|protected)\s+)?(?:async\s+)?(\w+)\s*\(/g;
  while ((m = methRe.exec(src))) {
    const [, httpMethod, , path, , optText, decoWindow, methodName] = m;
    const decoNames = [
      ...decoratorsAbove(src, m.index),
      ...[...decoWindow.matchAll(/@(\w+)\s*(?:\([^)]*\))?/g)].map((d) => d[1]),
    ];
    const optOpen = optText ? OPEN_OPTION_RE.test(optText) : false;
    const openDeco = decoNames.some((d) => OPEN_DECORATOR_RE.test(d));
    const guards = [
      ...decoNames.filter((d) => GUARD_DECORATOR_RE.test(d)),
      ...(classGuarded ? ["<class-level>"] : []),
    ];
    // Slice the method body: balanced parens for the signature, then the
    // balanced { } block — bounded slice for the intra-handler sink scan.
    let body = null;
    const sigOpen = m.index + m[0].length - 1;
    const sigClose = findBalanced(src, sigOpen, "(", ")");
    if (sigClose >= 0) {
      const brace = src.indexOf("{", sigClose);
      // tolerate a return-type annotation between `)` and `{` (≤120 chars)
      if (brace > 0 && brace - sigClose < 120) {
        const bodyClose = findBalanced(src, brace, "{", "}");
        if (bodyClose > 0) body = src.slice(brace, bodyClose);
      }
    }

    routes.push({
      style: "decorator",
      method: httpMethod.toLowerCase(),
      path: cls.base + (path || ""),
      handler: methodName,
      guards,
      explicitPublic: openDeco || optOpen || classOpen,
      file: null,
      line: lineOf(src, m.index),
      body,
      confidence: CONF.OBSERVED,
    });
  }
  return routes;
}

// ---- express-style extraction --------------------------------------------------
function extractExpress(src, fileVarRouters) {
  const routes = [];
  const mounts = [];
  const globalGuards = []; // file-level app.use(auth-ish) evidence

  // find call sites, then slice balanced parens.
  const siteRe =
    /(?:^|[^\w$])((?:\w+))\s*\.\s*(get|post|put|patch|delete|all|options|head|use)\s*\(/gm;
  let m;
  while ((m = siteRe.exec(src))) {
    const receiver = m[1];
    const verb = m[2];
    const openParen = m.index + m[0].length - 1;
    const close = findBalanced(src, openParen, "(", ")");
    if (close < 0) continue;
    const argsText = src.slice(openParen + 1, close);
    const args = splitTop(argsText).map((a) => a.trim()).filter(Boolean);
    if (!args.length) continue;
    const first = args[0];
    const pathLit = first.match(/^(['"`])([^'"`]*)\1/);
    // Route paths always start with '/' — kills CDP/RPC calls like
    // conn.post('Profiler.enable') that share the receiver.method('x') shape.
    const argIsPath = !!pathLit && pathLit[2].startsWith("/");

    if (verb === "use") {
      const prefix = argIsPath ? pathLit[2] : "";
      const targets = args.slice(argIsPath ? 1 : 0);
      for (const t of targets) {
        if (GUARD_RE.test(t)) {
          globalGuards.push({ token: t.slice(0, 80), line: lineOf(src, m.index) });
        } else {
          mounts.push({ receiver, prefix, target: t.replace(/\s+/g, ""), line: lineOf(src, m.index) });
        }
      }
      continue;
    }

    if (!argIsPath) continue; // app.get(settingName) getters — not routes
    const path = pathLit[2];
    const middle = args.slice(1, -1);
    const lastArg = args[args.length - 1];
    const guards = middle.filter((a) => GUARD_RE.test(a)).map((a) => a.slice(0, 80));

    // Inline handler body slice for sink scan — last arg only.
    let body = null;
    if (lastArg) {
      const bodyStart = lastArg.indexOf("{");
      if (bodyStart >= 0) {
        const end = findBalanced(lastArg, bodyStart, "{", "}");
        if (end > 0) body = lastArg.slice(bodyStart, end + 1);
      }
    }

    routes.push({
      style: "express",
      method: verb,
      path,
      receiver,
      handler: lastArg ? lastArg.slice(0, 120) : null,
      guards,
      explicitPublic: false,
      file: null,
      line: lineOf(src, m.index),
      body,
      confidence: CONF.OBSERVED,
      middlewareArgs: middle.length,
    });
  }
  return { routes, mounts, globalGuards };
}

// ---- sink scan ---------------------------------------------------------------
function scanSinks(body) {
  if (!body) return [];
  const hits = [];
  const usesReq = /\b(req|ctx)\.(body|query|params|headers|param)\b/.test(body);
  for (const [kind, res] of Object.entries(HANDLER_SINKS)) {
    for (const re of res) {
      const mm = body.match(re);
      if (mm) hits.push({ kind, token: mm[0].slice(0, 60), req_driven: usesReq });
    }
  }
  return hits;
}

// ---- per-file audit ------------------------------------------------------------
function auditFile(src, relName) {
  const decoRoutes = extractDecorated(src);
  const routerVars = new Set(
    [...src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:express\.|Router\(\s*\)|new Router)/g)].map(
      (x) => x[1],
    ),
  );
  const ex = extractExpress(src, routerVars);
  const imports = {};
  for (const im of src.matchAll(
    /import\s+(\w+)[\s,{}*\w]*from\s+['"]([^'"]+)['"]|const\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]/g,
  )) {
    const varName = im[1] ?? im[3];
    const spec = im[2] ?? im[4];
    if (varName && spec.startsWith(".")) imports[varName] = spec;
  }
  return { file: relName, decoRoutes, exRoutes: ex.routes, mounts: ex.mounts, globalGuards: ex.globalGuards, imports, routerVars };
}

// ---- cross-file join + scoring -------------------------------------------------
function joinAndScore(perFile, files) {
  const fileByImport = new Map();
  for (const f of perFile) {
    const dir = dirname(f.absPath);
    for (const [varName, spec] of Object.entries(f.imports)) {
      const resolved = resolve(dir, spec);
      fileByImport.set(`${f.absPath}::${varName}`, resolved);
    }
  }
  const findings = [];
  const routes = [];
  const add = (rule, severity, confidence, title, detail, evidence) =>
    findings.push({ rule, severity, confidence, title, detail, evidence });

  // Map file → global guard evidence so route verdicts can cite it.
  const fileGlobalGuards = new Map(perFile.map((f) => [f.absPath, f.globalGuards]));

  // Build prefix map: which files are mounted under which prefix (derived join).
  const mountedPrefix = new Map(); // absPath -> [{prefix, via}]
  for (const f of perFile) {
    for (const mnt of f.mounts) {
      const target = mnt.target.replace(/[();]+$/, "");
      const imported = fileByImport.get(`${f.absPath}::${target}`);
      if (imported) {
        // Try resolving to a real scanned file
        for (const candidate of [imported, imported + ".ts", imported + ".js", join(imported, "index.ts"), join(imported, "index.js")]) {
          const hit = perFile.find((x) => x.absPath === resolve(candidate));
          if (hit) {
            const list = mountedPrefix.get(hit.absPath) ?? [];
            list.push({ prefix: mnt.prefix, via: `${f.file}:${mnt.line}` });
            mountedPrefix.set(hit.absPath, list);
            break;
          }
        }
      } else if (mnt.receiver && fileGlobalGuards.get(f.absPath)) {
        // same-file mount: app.use('/x', router) where router is a local Router()
        if (f.routerVars.has(target) || target === "router") {
          const list = mountedPrefix.get(f.absPath) ?? [];
          list.push({ prefix: mnt.prefix, via: `${f.file}:${mnt.line}` });
          mountedPrefix.set(f.absPath, list);
        }
      }
    }
  }

  for (const f of perFile) {
    const globals = fileGlobalGuards.get(f.absPath) ?? [];
    const prefixes = mountedPrefix.get(f.absPath) ?? [];
    const hasGlobalGuard = globals.length > 0;

    const allRoutes = [
      ...f.decoRoutes,
      ...f.exRoutes.map((r) => ({ ...r, body: r.body })),
    ];
    for (const r of allRoutes) {
      r.file = f.file;
      const fullPath = (prefixes[0]?.prefix ?? "") + r.path;
      const sinkHits = scanSinks(r.body);
      const dyn = r.body && DYNAMIC_DISPATCH_RE.test(r.body);
      const greedy = GREEDY_PARAM_RE.test(r.path);

      let status;
      if (r.explicitPublic) status = "explicit-public";
      else if (r.guards.length) status = "guarded";
      else if (hasGlobalGuard) status = "guarded-inferred";
      else status = "unguarded";

      const routeRec = {
        method: r.method.toUpperCase(),
        path: fullPath,
        handler: r.handler,
        status,
        guards: r.guards,
        file: r.file,
        line: r.line,
        ...(prefixes.length ? { mounted_via: prefixes.map((p) => p.via) } : {}),
        ...(sinkHits.length ? { sinks: sinkHits.map((s) => `${s.kind}${s.req_driven ? "(req)" : ""}`) } : {}),
      };
      routes.push(routeRec);

      const subject = `${routeRec.method} ${fullPath}`;
      const ev = { file: `${r.file}:${r.line}`, route: subject };

      if (r.explicitPublic) {
        add(
          "explicit-unauthenticated-route",
          MUTATION_METHODS.has(r.method) ? "medium" : "info",
          CONF.OBSERVED,
          `${subject} declared unauthenticated`,
          "Route carries an explicit skip-auth/public annotation. Verify the handler performs its own caller check or the surface is intentionally public.",
          { ...ev, decorators: r.guards },
        );
        continue;
      }

      if (status === "unguarded") {
        const isMutation = MUTATION_METHODS.has(r.method);
        add(
          isMutation ? "unguarded-mutation" : "unguarded-route",
          isMutation ? "high" : "medium",
          CONF.INFERRED,
          `${subject} has no guard token in the registration chain`,
          `No scope/auth middleware on the route or its controller class, and no file-level app.use(auth*) evidence. ` +
            (hasGlobalGuard ? "" : "A global middleware mounted in another file may still cover it — verify before reporting.") +
            (r.style === "decorator" ? " In-framework scope decorators are the expected guard site; their absence is itself an audit lead." : ""),
          ev,
        );
      } else if (status === "guarded-inferred") {
        // Recorded in the matrix only — not a finding; global coverage is plausible.
      }

      if (sinkHits.length) {
        const worst = sinkHits.some((s) => s.kind === "code_exec") ? "critical"
          : sinkHits.some((s) => ["file_rw", "sql_template"].includes(s.kind)) ? "high" : "medium";
        add(
          status === "unguarded" ? "unauthed-sink" : "sink-in-handler",
          status === "unguarded" ? worst : worst === "critical" ? "high" : "medium",
          status === "unguarded" ? CONF.INFERRED : CONF.OBSERVED,
          `${subject} handler reaches ${sinkHits[0].kind}${sinkHits[0].req_driven ? " with req-derived input" : ""}`,
          `Handler body contains ${[...new Set(sinkHits.map((s) => s.kind))].join(", ")} sink tokens${sinkHits[0].req_driven ? " and reads req.* — bounded slice, confirm reachability and sanitization before reporting" : ""}.`,
          { ...ev, sinks: sinkHits.slice(0, 6), guard_status: status },
        );
      }

      if (dyn) {
        add("dynamic-method-dispatch", "high", CONF.OBSERVED,
          `${subject} dispatches a method named by request input`,
          "Handler indexes into an object with req.body/query/params to pick a callable — the confused-deputy class (arbitrary method invocation). Require a literal allowlist.",
          ev);
      }
      if (greedy) {
        add("greedy-path-param", "medium", CONF.OBSERVED,
          `${subject} uses a greedy/path-converter parameter`,
          "Greedy params swallow slashes — route-confusion and path-normalization class: downstream ACL checks that match on literal path can disagree with the router.",
          { ...ev, path: r.path });
      }
    }

    if (globals.length) {
      add("global-auth-middleware", "info", CONF.OBSERVED,
        `${f.file} mounts auth-looking middleware via .use()`,
        "Routes in this file marked unguarded may still be covered by this middleware — treat those leads as guarded-inferred.",
        { file: f.file, tokens: globals.map((g) => g.token).slice(0, 6) });
    }
  }

  return { findings, routes };
}

// ---- markdown render -----------------------------------------------------------
const SEV_ORDER = { critical: 0, high: 1, medium: 2, info: 3 };
function renderMd(audit) {
  const f = [...audit.findings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const lines = [
    "# Route × guard audit",
    "",
    `Files scanned: ${audit.stats.files_scanned} · routes: ${audit.stats.routes} · unguarded: ${audit.stats.unguarded} (mutations: ${audit.stats.unguarded_mutations}) · explicit-public: ${audit.stats.explicit_public}`,
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

// ---- CLI -----------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("audit-routes.mjs")) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const out = outIdx >= 0 ? argv.splice(outIdx, 2)[1] : null;
  const mdIdx = argv.indexOf("--md");
  const mdOut = mdIdx >= 0 ? argv.splice(mdIdx, 2)[1] : null;
  const appIdx = argv.indexOf("--app");
  const app = appIdx >= 0 ? argv.splice(appIdx, 2)[1] : "unknown";
  const verIdx = argv.indexOf("--version");
  const version = verIdx >= 0 ? argv.splice(verIdx, 2)[1] : "unknown";
  const lfIdx = argv.indexOf("--files");
  const listFile = lfIdx >= 0 ? argv.splice(lfIdx, 2)[1] : null;
  const inputs = argv.filter((a) => !a.startsWith("--"));
  if (listFile) for (const l of readFileSync(listFile, "utf8").split("\n")) if (l.trim()) inputs.push(l.trim());
  if (!inputs.length) {
    console.error("usage: node tools/audit-routes.mjs <src-file-or-dir> [...] [--out a.json] [--md a.md] [--app name] [--version v]");
    process.exit(1);
  }

  const files = collectFiles(inputs);
  const perFile = files.map((f) => ({
    absPath: f,
    ...auditFile(readFileSync(f, "utf8"), basename(dirname(f)) + "/" + basename(f)),
  }));
  const { findings, routes } = joinAndScore(perFile, files);

  const unguarded = routes.filter((r) => r.status === "unguarded");
  const audit = {
    generated_by: "wirecat audit-routes",
    app, version,
    scope_note:
      "literal-pattern route×guard inventory + bounded intra-handler scan; middleware applied in unscanned files is NOT modeled — 'unguarded' means no guard token in the registration chain, not proof of unauthenticated reachability. Absence of a finding is not proof of safety.",
    findings,
    routes,
    stats: {
      files_scanned: files.length,
      routes: routes.length,
      guarded: routes.filter((r) => r.status === "guarded").length,
      guarded_inferred: routes.filter((r) => r.status === "guarded-inferred").length,
      unguarded: unguarded.length,
      unguarded_mutations: unguarded.filter((r) => ["POST", "PUT", "PATCH", "DELETE"].includes(r.method)).length,
      explicit_public: routes.filter((r) => r.status === "explicit-public").length,
      mounts_joined: routes.filter((r) => r.mounted_via).length,
    },
    per_file: perFile.map((f) => ({
      file: f.file,
      decorator_routes: f.decoRoutes.length,
      express_routes: f.exRoutes.length,
      mounts: f.mounts.length,
      global_guard_tokens: f.globalGuards.length,
    })),
  };
  const json = JSON.stringify(audit, null, 1);
  if (out) writeFileSync(out, json); else process.stdout.write(json);
  if (mdOut) writeFileSync(mdOut, renderMd(audit));
  const sev = {};
  for (const x of audit.findings) sev[x.severity] = (sev[x.severity] ?? 0) + 1;
  console.error(`[audit-routes] ${audit.stats.routes} routes (${audit.stats.unguarded} unguarded, ${audit.stats.explicit_public} explicit-public), findings: ${JSON.stringify(sev)}`);
}
