#!/usr/bin/env node
/**
 * 波妞工作台 · 本地数据服务（零依赖，只监听 127.0.0.1）
 *
 * 只读数据源：
 *   - AGY 窗口：~/.gemini/antigravity/brain/<cid>/.system_generated/logs/transcript.jsonl
 *   - Claude CLI 会话：~/.claude-cli/projects/<项目>/<session>.jsonl（只读会话记录，不碰任何凭据文件）
 *   - Codex 线程：~/.codex/sqlite/codex.db（只读）
 *   - 微信桥：.agents/clawbot/bridge.log、events.jsonl、router_state.json（不读 latest_peer.json，里面有 token）
 * 唯一写入：workbench/projects.json（页面上改项目状态时）
 *
 * 启动：node /Users/eru/Desktop/agy工作站/workbench/server.mjs   → http://127.0.0.1:4800
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WORKBENCH_PORT || 4800);
const HOME = os.homedir();
const HUB = "/Users/eru/Desktop/agy工作站";
const CLAWBOT = path.join(HUB, ".agents/clawbot");
const BRAIN_DIR = path.join(HOME, ".gemini/antigravity/brain");
const CLAUDE_PROJECTS = path.join(HOME, ".claude-cli/projects");
const CODEX_DB = path.join(HOME, ".codex/sqlite/codex.db");
const PROJECTS_FILE = path.join(__dirname, "projects.json");
const KNOWN_ROUTERS = ["df666dc1-4b27-4fe4-ae54-5911bf805f99", "f9055825-52b3-4d6c-9023-331ac6f68543"];

// ---------- 小工具 ----------
const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};
const statSafe = (p) => {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
};
const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};
const hourKey = (iso) => (iso ? String(iso).slice(0, 13) : null); // UTC 小时桶，前端换成本地时间

const fileCache = new Map(); // path -> { sig, data }
function cached(p, parser) {
  const st = statSafe(p);
  if (!st) return null;
  const sig = `${st.size}:${st.mtimeMs}`;
  const hit = fileCache.get(p);
  if (hit && hit.sig === sig) return hit.data;
  let data = null;
  try {
    data = parser(p, st);
  } catch (e) {
    data = null;
  }
  fileCache.set(p, { sig, data });
  return data;
}

function routerCids() {
  const st = readJson(path.join(CLAWBOT, "router_state.json"), {});
  return new Set([st.routerCid, st.previousRouterCid, ...KNOWN_ROUTERS].filter(Boolean));
}

// ---------- AGY 窗口 ----------
// 路由转发时，eru 原话以外又被加进去多少字（不算 agy-route 固定的铁律尾巴）
function routerAddition(raw) {
  const s = String(raw || "");
  const quoted = s.match(/(?:原话|硬指令|指令)[^「\n]{0,60}「([\s\S]*?)」/);
  if (!quoted) return null;
  const body = (s.match(/content=([\s\S]*)/)?.[1] || s).split(/\n---\n(?:🟠|⚠️|✂️)/)[0];
  const rest = body
    .replace(quoted[0], "")
    .replace(/📱\s*\[eru[^\]]*\]/g, "")
    .replace(/\[接力原旧工作区会话[^\]]*\]/g, "")
    .replace(/[\s【】（）()：:「」]/g, "");
  return { eru: quoted[1], extra: rest.length, extraText: body.replace(quoted[0], "「…你的原话…」").trim().slice(0, 900) };
}

function extractEruText(raw) {
  const s = String(raw || "");
  const quoted = s.match(/(?:原话|硬指令|指令)[^「\n]{0,60}「([\s\S]*?)」/);
  if (quoted) return quoted[1];
  const ur = s.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (ur) return ur[1].replace(/<ADDITIONAL_METADATA>[\s\S]*$/, "");
  const sm = s.match(/content=([\s\S]*)/);
  if (sm) return sm[1].split(/\n---\n|⚠️ 【微信同步回复指令】|🟠 【工作站最高/)[0];
  return s;
}

function extractWeixinText(cmd) {
  const s = String(cmd || "");
  const m = s.match(/weixin-send\.mjs\s+(?:--[a-z-]+(?:=\S+)?\s+)*(['"])([\s\S]*?)\1(?=\s|$)/);
  if (!m) return null;
  return m[2].replace(/\\n/g, "\n").replace(/'\\''/g, "'").trim();
}

function parseAgyTranscript(p) {
  const lines = fs.readFileSync(p, "utf8").split("\n");
  const r = {
    steps: 0,
    tokIn: 0,
    tokCache: 0,
    tokOut: 0,
    errors: 0,
    firstAt: null,
    lastAt: null,
    lastState: "",
    lastAi: "",
    firstUser: "",
    senderSession: null,
    eruMsgs: [],
    reports: [],
    claudeCalls: 0,
    codexCalls: 0,
    hourly: {},
  };
  for (const line of lines) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const at = o.created_at || null;
    if (at) {
      r.firstAt = r.firstAt || at;
      r.lastAt = at;
    }
    r.lastState = `${o.type || ""}${o.status ? "·" + o.status : ""}`;
    if (o.type === "PLANNER_RESPONSE") {
      r.steps++;
      const a = o.input_tokens || 0;
      const c = o.cache_read_tokens || 0;
      const b = o.output_tokens || 0;
      r.tokIn += a;
      r.tokCache += c;
      r.tokOut += b;
      const hk = hourKey(at);
      if (hk) r.hourly[hk] = (r.hourly[hk] || 0) + a + c + b;
      if (typeof o.content === "string" && o.content.trim()) r.lastAi = o.content;
      for (const tc of o.tool_calls || []) {
        if (tc.name !== "run_command") continue;
        let cmd = tc.args?.CommandLine;
        try {
          cmd = JSON.parse(cmd);
        } catch {}
        cmd = String(cmd || "");
        if (cmd.includes(".claude-cli") && /\/bin\/claude\b/.test(cmd)) r.claudeCalls++;
        if (/codex\s+exec|codex"?\s+exec/.test(cmd)) r.codexCalls++;
        if (cmd.includes("weixin-send.mjs") && !cmd.includes("--tool-")) {
          const t = extractWeixinText(cmd);
          if (t) r.reports.push({ at, text: t.slice(0, 1200) });
        }
      }
    } else if (o.type === "ERROR_MESSAGE") {
      r.errors++;
    } else if (o.type === "USER_INPUT") {
      const t = extractEruText(o.content).trim();
      if (!r.firstUser) r.firstUser = t;
      if (t) r.eruMsgs.push({ at, text: t.slice(0, 600), via: "直接输入" });
    } else if (o.type === "SYSTEM_MESSAGE") {
      const s = String(o.content || "");
      const sender = s.match(/sender=([0-9a-f-]{36})/);
      if (!r.firstUser && sender) r.senderSession = sender[1];
      if (/原话|eru 从微信|来自 eru 手机微信|sender=user/.test(s)) {
        const t = extractEruText(s).trim();
        if (!r.firstUser) r.firstUser = t;
        const add = routerAddition(s);
        if (add) {
          r.forwards = (r.forwards || 0) + 1;
          if (add.extra > 80) {
            r.padded = (r.padded || 0) + 1;
            r.paddedChars = (r.paddedChars || 0) + add.extra;
          }
        }
        if (t)
          r.eruMsgs.push({
            at,
            text: t.slice(0, 600),
            via: "微信转发",
            added: add && add.extra > 80 ? add.extra : 0,
            addedText: add && add.extra > 80 ? add.extraText : "",
          });
      }
    }
  }
  r.eruMsgs = r.eruMsgs.slice(-12);
  r.reports = r.reports.slice(-10);
  r.lastAi = r.lastAi.slice(0, 1500);
  return r;
}

function scanAgy() {
  const st = readJson(path.join(CLAWBOT, "router_state.json"), {});
  const aliases = st.sessionAliases || {};
  const mirrors = st.legacyMirrors || {};
  const routers = routerCids();
  let dirs = [];
  try {
    dirs = fs.readdirSync(BRAIN_DIR).filter((d) => /^[0-9a-f-]{36}$/i.test(d));
  } catch {}
  const out = [];
  for (const cid of dirs) {
    const tp = path.join(BRAIN_DIR, cid, ".system_generated/logs/transcript.jsonl");
    const d = cached(tp, parseAgyTranscript);
    if (!d) continue;
    out.push({
      engine: "agy",
      id: cid,
      title: aliases[cid] || clip(d.firstUser, 40) || cid.slice(0, 8),
      isRouter: routers.has(cid),
      replacedBy: mirrors[cid] || null,
      ...d,
    });
  }
  return out;
}

// ---------- Claude CLI 会话 ----------
function parseClaudeSession(p) {
  const r = {
    tokIn: 0,
    tokCache: 0,
    tokOut: 0,
    turns: 0,
    firstAt: null,
    lastAt: null,
    cwd: null,
    model: null,
    firstUser: "",
    lastAi: "",
    hourly: {},
  };
  const seen = new Set();
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.timestamp) {
      r.firstAt = r.firstAt || o.timestamp;
      r.lastAt = o.timestamp;
    }
    if (o.cwd && !r.cwd) r.cwd = o.cwd;
    if (o.type === "queue-operation" && o.content && !r.firstUser) r.firstUser = String(o.content);
    if (o.type === "user" && !r.firstUser && !o.isSidechain) {
      const c = o.message?.content;
      if (typeof c === "string") r.firstUser = c;
    }
    if (o.type === "assistant" && o.message) {
      const m = o.message;
      if (Array.isArray(m.content)) {
        const txt = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
        if (txt) r.lastAi = txt;
      }
      const key = m.id || o.requestId || o.uuid;
      if (seen.has(key)) continue;
      seen.add(key);
      r.turns++;
      r.model = m.model || r.model;
      const u = m.usage || {};
      const a = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const c = u.cache_read_input_tokens || 0;
      const b = u.output_tokens || 0;
      r.tokIn += a;
      r.tokCache += c;
      r.tokOut += b;
      const hk = hourKey(o.timestamp);
      if (hk) r.hourly[hk] = (r.hourly[hk] || 0) + a + c + b;
    }
  }
  r.lastAi = r.lastAi.slice(0, 1500);
  return r;
}

function scanClaude() {
  const out = [];
  let projDirs = [];
  try {
    projDirs = fs.readdirSync(CLAUDE_PROJECTS);
  } catch {
    return out;
  }
  for (const pd of projDirs) {
    const dir = path.join(CLAUDE_PROJECTS, pd);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const d = cached(path.join(dir, f), parseClaudeSession);
      if (!d || !d.turns) continue;
      out.push({
        engine: "claude",
        id: f.replace(/\.jsonl$/, ""),
        title: clip(d.firstUser, 40) || pd,
        steps: d.turns,
        ...d,
      });
    }
  }
  return out;
}

// ---------- Codex ----------
async function scanCodex() {
  if (!statSafe(CODEX_DB)) return [];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(CODEX_DB, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT thread_id, display_title, cwd, source_updated_at FROM local_thread_catalog WHERE missing_candidate = 0 ORDER BY source_updated_at DESC LIMIT 30"
      )
      .all();
    db.close();
    return rows.map((r) => ({
      engine: "codex",
      id: r.thread_id,
      title: r.display_title || "Codex 线程",
      cwd: r.cwd || null,
      lastAt: r.source_updated_at ? new Date(r.source_updated_at * 1000).toISOString() : null,
    }));
  } catch {
    return [];
  }
}

// ---------- 微信流 ----------
function parseWechat() {
  const logPath = [path.join(CLAWBOT, "bridge.log"), path.join(CLAWBOT, "bridge_v2.log")]
    .map((p) => ({ p, st: statSafe(p) }))
    .filter((x) => x.st)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0];
  const events = [];
  try {
    for (const l of fs.readFileSync(path.join(CLAWBOT, "events.jsonl"), "utf8").split("\n")) {
      if (!l) continue;
      try {
        events.push(JSON.parse(l));
      } catch {}
    }
  } catch {}
  const routers = routerCids();
  const msgs = [];
  const fwdTimes = [];
  const directs = [];
  const asks = [];
  if (logPath) {
    const buf = fs.readFileSync(logPath.p, "utf8");
    const tail = buf.slice(-600_000);
    // V2：Forwarded to AGY V2.0 Smart Router；V3：Forwarded msg=… to AGY Router
    const fre = /\[(\d{4}-\d\d-\d\dT[^\]]+)\] \[AGY-ClawBot-V\d\] Forwarded (?:msg=\S+ )?to AGY (?:V2\.0 Smart )?Router/g;
    let f;
    while ((f = fre.exec(tail))) fwdTimes.push(Date.parse(f[1]));
    // V3 确定性路由：Direct-routed msg=… via 规则 → 目标 (engine)
    const dre = /\[(\d{4}-\d\d-\d\dT[^\]]+)\] \[AGY-ClawBot-V\d\] Direct-routed msg=\S+ via (\S+) → (\S+) \((\w+)\)/g;
    let dr;
    while ((dr = dre.exec(tail))) directs.push({ t: Date.parse(dr[1]), via: dr[2], target: dr[3], engine: dr[4] });
    const are = /\[(\d{4}-\d\d-\d\dT[^\]]+)\] \[AGY-ClawBot-V\d\] Ask-choice msg=/g;
    let ac;
    while ((ac = are.exec(tail))) asks.push(Date.parse(ac[1]));
    const re = /\[(\d{4}-\d\d-\d\dT[^\]]+)\] \[AGY-ClawBot-V\d\] Inbound WeChat message from [^:]+: text="([\s\S]*?)" media=\[([^\]]*)\] quote=([^\n]*)/g;
    let m;
    while ((m = re.exec(tail))) {
      const text = m[2].trim();
      msgs.push({
        at: m[1],
        text: text.slice(0, 400),
        hasMedia: Boolean(m[3].trim()),
        quoted: !m[4].startsWith("none"),
        slash: text.startsWith("/"),
      });
    }
  }
  // 推断去向：消息之后 6 分钟内第一个非路由窗口的投递
  const sends = events
    .filter((e) => e.action === "send-message" || e.action === "new-conversation")
    .map((e) => ({ t: Date.parse(e.ts), target: e.target, router: routers.has(e.target), action: e.action }));
  for (const msg of msgs) {
    const t0 = Date.parse(msg.at);
    msg.viaRouter = fwdTimes.some((t) => t >= t0 && t <= t0 + 30_000);
    const direct = directs.find((d) => d.t >= t0 && d.t <= t0 + 30_000);
    if (direct) {
      msg.direct = direct.via;
      msg.routedTo = direct.target;
      continue;
    }
    const hit = sends.find((s) => !s.router && s.t >= t0 && s.t <= t0 + 360_000);
    msg.routedTo = hit ? hit.target : null;
  }
  // 重复投递：同一窗口 5 分钟内被投递 ≥3 次
  const bursts = {};
  const byTarget = {};
  for (const s of sends) {
    if (s.router) continue;
    (byTarget[s.target] ||= []).push(s.t);
  }
  for (const [target, ts] of Object.entries(byTarget)) {
    ts.sort((a, b) => a - b);
    let n = 0;
    for (let i = 0; i < ts.length; i++) {
      let j = i;
      while (j + 1 < ts.length && ts[j + 1] - ts[i] <= 300_000) j++;
      if (j - i + 1 >= 3) {
        n++;
        i = j;
      }
    }
    if (n) bursts[target] = n;
  }
  return {
    messages: msgs.slice(-60).reverse(),
    totalInbound: msgs.length,
    routerForwards: fwdTimes.length,
    directRouted: directs.length,
    // V3 上线（20:55）之后的路由去向
    since: "2026-11-06T12:55:00Z",
    routeMix: (() => {
      const t0 = Date.parse("2026-11-06T12:55:00Z");
      return {
        direct: directs.filter((d) => d.t >= t0).length,
        llm: fwdTimes.filter((t) => t >= t0).length,
        ask: asks.filter((t) => t >= t0).length,
      };
    })(),
    directDispatches: sends.filter((s) => !s.router).length,
    bursts,
    lastInboundAt: msgs.length ? msgs[msgs.length - 1].at : null,
  };
}

// ---------- 健康 ----------
function portOpen(port, host = "127.0.0.1", timeout = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeout, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

async function health() {
  let bridgePid = null;
  try {
    bridgePid = execFileSync("/usr/bin/pgrep", ["-f", "clawbot/bridge.mjs"], { encoding: "utf8" }).trim().split("\n")[0] || null;
  } catch {}
  let diskFreeGB = null;
  let diskPct = null;
  try {
    const s = fs.statfsSync("/System/Volumes/Data");
    diskFreeGB = (s.bavail * s.bsize) / 1e9;
    diskPct = 1 - s.bavail / s.blocks;
  } catch {}
  const [proxy, ollama, portal] = await Promise.all([portOpen(7897), portOpen(11434), portOpen(4318)]);
  return {
    bridge: { ok: Boolean(bridgePid), pid: bridgePid },
    proxy: { ok: proxy, label: "mihomo 7897" },
    ollama: { ok: ollama, label: "Ollama 11434" },
    portal: { ok: portal, label: "Task Portal 4318" },
    disk: { freeGB: diskFreeGB, usedPct: diskPct },
    loadavg: os.loadavg()[0],
    memFreeGB: os.freemem() / 1e9,
  };
}

// ---------- 汇总 ----------
const tot = (s) => (s.tokIn || 0) + (s.tokCache || 0) + (s.tokOut || 0);

function burnSeries(agy, claude, hours = 48) {
  const now = new Date();
  const keys = [];
  for (let i = hours - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600_000);
    keys.push(d.toISOString().slice(0, 13));
  }
  const series = keys.map((k) => ({ hour: k, router: 0, agy: 0, claude: 0 }));
  const idx = Object.fromEntries(keys.map((k, i) => [k, i]));
  for (const s of agy) {
    for (const [k, v] of Object.entries(s.hourly || {})) {
      if (idx[k] === undefined) continue;
      series[idx[k]][s.isRouter ? "router" : "agy"] += v;
    }
  }
  for (const s of claude) {
    for (const [k, v] of Object.entries(s.hourly || {})) {
      if (idx[k] !== undefined) series[idx[k]].claude += v;
    }
  }
  return series;
}

function sumWindow(list, sinceMs, routerFilter) {
  let n = 0;
  for (const s of list) {
    if (routerFilter !== undefined && Boolean(s.isRouter) !== routerFilter) continue;
    for (const [k, v] of Object.entries(s.hourly || {})) {
      if (Date.parse(k + ":00:00Z") >= sinceMs) n += v;
    }
  }
  return n;
}

function slimSession(s) {
  return {
    engine: s.engine,
    id: s.id,
    title: s.title,
    isRouter: Boolean(s.isRouter),
    replacedBy: s.replacedBy || null,
    steps: s.steps || 0,
    tokens: tot(s),
    tokOut: s.tokOut || 0,
    errors: s.errors || 0,
    firstAt: s.firstAt || null,
    lastAt: s.lastAt || null,
    lastState: s.lastState || "",
    claudeCalls: s.claudeCalls || 0,
    codexCalls: s.codexCalls || 0,
    cwd: s.cwd || null,
    model: s.model || null,
    isSub: Boolean(s.senderSession),
  };
}


function resolveMirror(cid) {
  const mirrors = readJson(path.join(CLAWBOT, "router_state.json"), {}).legacyMirrors || {};
  let cur = cid;
  const seen = new Set([cur]);
  while (mirrors[cur] && !seen.has(mirrors[cur])) {
    cur = mirrors[cur];
    seen.add(cur);
  }
  return cur;
}

// ---------- 强约束运行数据（承诺 / 验收判定 / Claude 审查） ----------
function readJsonl(p, max = 400) {
  try {
    return fs
      .readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .slice(-max)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readConstraints(titleOf) {
  const cm = readJson(path.join(CLAWBOT, "commitments.json"), { items: {} });
  const items = Object.values(cm.items || {}).sort((a, b) => b.createdAt - a.createdAt);
  const verdicts = readJsonl(path.join(CLAWBOT, "proofs.jsonl"))
    .filter((x) => x.verdict && x.verdict !== "none")
    .reverse()
    .slice(0, 40)
    .map((x) => ({ at: x.ts, routeKey: x.routeKey, verdict: x.verdict, text: x.textHead, session: x.session, title: titleOf(x.session), tags: x.tags || [] }));
  const reviews = readJsonl(path.join(CLAWBOT, "delegations.jsonl"))
    .filter((x) => x.role === "review" && x.status === "finished" && !x.test)
    .reverse()
    .slice(0, 30)
    .map((x) => ({ at: x.ts, project: x.project, verdict: x.verdict, costUsd: x.costUsd, durationMs: x.durationMs }));
  const work = readJsonl(path.join(CLAWBOT, "delegations.jsonl"))
    .filter((x) => x.status === "finished" && !x.test && x.role !== "review")
    .reverse()
    .slice(0, 20)
    .map((x) => ({ at: x.ts, engine: x.engine, project: x.project, isError: x.isError, costUsd: x.costUsd, durationMs: x.durationMs }));
  return {
    open: items.filter((c) => c.status === "open").map((c) => ({ id: c.id, cid: c.cid, title: c.title, text: c.text, dueAt: c.dueAt, createdAt: c.createdAt, reminded: Boolean(c.remindedAt), needsResearch: c.needsResearch })),
    closed: items.filter((c) => c.status !== "open").slice(0, 20).map((c) => ({ id: c.id, title: c.title, text: c.text, status: c.status, at: c.fulfilledAt || c.droppedAt || c.createdAt })),
    verdicts,
    reviews,
    work,
  };
}

async function buildState() {
  const reg = readJson(PROJECTS_FILE, { projects: [] });
  const agy = scanAgy();
  const claude = scanClaude();
  const codex = await scanCodex();
  const wechat = parseWechat();
  const hp = await health();
  const routerState = readJson(path.join(CLAWBOT, "router_state.json"), {});
  const agyById = Object.fromEntries(agy.map((s) => [s.id, s]));

  // 发件记录：桥每发一条微信都登记在 msg_session_map.json（比解析窗口记录准）
  const sentMap = readJson(path.join(CLAWBOT, "msg_session_map.json"), { recent: [] });
  const sentByCid = {};
  for (const e of sentMap.recent || []) {
    if (!e?.cid || !e.createdAt) continue;
    if (/^\s*(⚠️|⏰|↪️|🤔|🕒|🗑️|🦞|❓|🔒|🔓)/u.test(String(e.bodySnippet || ""))) continue; // 桥自己发的系统提醒不算窗口汇报
    (sentByCid[e.cid] ||= []).push({ at: new Date(e.createdAt).toISOString(), text: String(e.bodySnippet || "").slice(0, 1200) });
  }
  const routeKeys = new Set(Object.keys(readJson(path.join(CLAWBOT, "rules.json"), { routes: {} }).routes || {}));
  const projects = reg.projects.map((p) => {
    const sess = (p.sessions || [])
      .map((ref) => (ref.engine === "agy" ? agyById[ref.cid] : null))
      .filter(Boolean);
    const cl = claude.filter((c) => c.cwd && (p.claudeCwd || []).some((d) => c.cwd === d || c.cwd.startsWith(d + "/")));
    const lastAts = [...sess.map((s) => s.lastAt), ...cl.map((c) => c.lastAt)].filter(Boolean).sort();
    const fromMap = (p.sessions || []).flatMap((ref) => sentByCid[ref.cid] || []);
    const reports = [...fromMap, ...sess.flatMap((s) => s.reports)]
      .filter((r) => r.at && r.text)
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    const eru = sess.flatMap((s) => s.eruMsgs).filter((r) => r.at).sort((a, b) => (a.at < b.at ? 1 : -1));
    return {
      ...p,
      routable: Boolean(routeKeys.has(p.id)),
      live: {
        lastAt: lastAts[lastAts.length - 1] || null,
        agySteps: sess.reduce((n, s) => n + s.steps, 0),
        agyTokens: sess.reduce((n, s) => n + tot(s), 0),
        agyErrors: sess.reduce((n, s) => n + s.errors, 0),
        claudeSessions: cl.length,
        claudeTokens: cl.reduce((n, s) => n + tot(s), 0),
        claudeCallsFromAgy: sess.reduce((n, s) => n + s.claudeCalls, 0),
        codexCallsFromAgy: sess.reduce((n, s) => n + s.codexCalls, 0),
        lastReport: reports[0] || null,
        lastEru: eru[0] || null,
        lastClaude: cl.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))[0]
          ? { at: cl[0].lastAt, text: clip(cl[0].lastAi, 260), id: cl[0].id }
          : null,
        bursts: (p.sessions || []).reduce((n, ref) => n + (wechat.bursts[ref.cid] || 0), 0),
      },
    };
  });

  const now = Date.now();
  const since24 = now - 24 * 3600_000;
  const sum24 = (list) => sumWindow(list, since24);
  // 钱花在哪：每个项目近 24 小时（AGY 窗口 + 对应目录的 Claude 会话）
  const claimed = new Set();
  const spend = [];
  for (const p of reg.projects) {
    const own = new Set((p.sessions || []).map((ref) => ref.cid));
    const ag = agy.filter((x) => own.has(x.id) || own.has(resolveMirror(x.id))); // 被接替的旧窗口也算回原项目
    const cl = claude.filter((c) => c.cwd && (p.claudeCwd || []).some((d) => c.cwd === d || c.cwd.startsWith(d + "/")));
    ag.forEach((x) => claimed.add(x));
    cl.forEach((x) => claimed.add(x));
    const n = sum24(ag) + sum24(cl);
    if (n > 0) spend.push({ id: p.id, name: p.name, color: p.color, tokens: n });
  }
  const routerN = sum24(agy.filter((x) => x.isRouter));
  agy.filter((x) => x.isRouter).forEach((x) => claimed.add(x));
  if (routerN > 0) spend.push({ id: "_router", name: "总控转发消息", tokens: routerN, waste: true });
  const otherN = sum24([...agy, ...claude].filter((x) => !claimed.has(x)));
  if (otherN > 0) spend.push({ id: "_other", name: "其他窗口", tokens: otherN });
  spend.sort((a, b) => b.tokens - a.tokens);
  // 每天用量（本机时区，近 7 天）
  const dayKey = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const days = [];
  for (let i = 181; i >= 0; i--) days.push({ day: dayKey(now - i * 86400_000), agy: 0, router: 0, claude: 0 });
  const dIdx = Object.fromEntries(days.map((d, i) => [d.day, i]));
  for (const x of agy) for (const [k, v] of Object.entries(x.hourly || {})) {
    const i = dIdx[dayKey(Date.parse(k + ":00:00Z"))];
    if (i !== undefined) days[i][x.isRouter ? "router" : "agy"] += v;
  }
  for (const x of claude) for (const [k, v] of Object.entries(x.hourly || {})) {
    const i = dIdx[dayKey(Date.parse(k + ":00:00Z"))];
    if (i !== undefined) days[i].claude += v;
  }
  const agyTotal = agy.reduce((n, s) => n + tot(s), 0);
  const routerTotal = agy.filter((s) => s.isRouter).reduce((n, s) => n + tot(s), 0);
  const claudeTotal = claude.reduce((n, s) => n + tot(s), 0);
  const metrics = {
    agyTotal,
    routerTotal,
    claudeTotal,
    agySteps: agy.reduce((n, s) => n + s.steps, 0),
    claudeTurns: claude.reduce((n, s) => n + s.turns, 0),
    agy24: sumWindow(agy, since24, false),
    router24: sumWindow(agy, since24, true),
    claude24: sumWindow(claude, since24),
    routerShare: agyTotal ? routerTotal / agyTotal : 0,
    claudeShare: agyTotal + claudeTotal ? claudeTotal / (agyTotal + claudeTotal) : 0,
    claudeCallsFromAgy: agy.reduce((n, s) => n + s.claudeCalls, 0),
    codexCallsFromAgy: agy.reduce((n, s) => n + s.codexCalls, 0),
    longSessions: agy.filter((s) => s.steps >= 600).length,
    forwards: agy.reduce((n, s) => n + (s.forwards || 0), 0),
    padded: agy.reduce((n, s) => n + (s.padded || 0), 0),
    paddedChars: agy.reduce((n, s) => n + (s.paddedChars || 0), 0),
    burstCount: Object.values(wechat.bursts).reduce((a, b) => a + b, 0),
    sessionCount: { agy: agy.length, claude: claude.length, codex: codex.length },
  };
  const all24 = metrics.agy24 + metrics.router24 + metrics.claude24;
  metrics.routerShare24 = metrics.agy24 + metrics.router24 ? metrics.router24 / (metrics.agy24 + metrics.router24) : 0;
  metrics.claudeShare24 = all24 ? metrics.claude24 / all24 : 0;
  metrics.memPressure = hp.memFreeGB < 0.5;

  const pending = Object.values(routerState.pendingReplies || {}).filter((p) => p && p.cid);

  const sessions = [...agy, ...claude]
    .map(slimSession)
    .concat(codex.map((c) => ({ ...c, steps: 0, tokens: 0 })))
    .sort((a, b) => ((a.lastAt || "") < (b.lastAt || "") ? 1 : -1));

  return {
    generatedAt: new Date().toISOString(),
    health: hp,
    metrics,
    burn: burnSeries(agy, claude, 48),
    spend,
    days,
    models: (() => {
      // 近 30 天按模型：AGY 记录里没有模型名，统一记为 Gemini Argon，再按干活 / 总控拆开
      const since30 = now - 30 * 86400_000;
      const m = {};
      const add = (k, v) => (m[k] = (m[k] || 0) + v);
      for (const x of agy) add(x.isRouter ? "Gemini Argon · 总控转发" : "Gemini Argon · 干活", sumWindow([x], since30));
      for (const x of claude) {
        if (/synthetic/.test(String(x.model || ""))) continue;
        const name = String(x.model || "claude").replace(/^claude-/, "").replace(/-(\d+)-(\d+).*$/, " $1.$2").replace(/^./, (c) => c.toUpperCase());
        add(`Claude ${name}`, sumWindow([x], since30));
      }
      return Object.entries(m).filter(([, v]) => v > 0).map(([name, tokens]) => ({ name, tokens })).sort((a, b) => b.tokens - a.tokens);
    })(),
    longest: Math.max(0, ...agy.map((x) => x.steps || 0)),
    projects,
    sessions,
    wechat: { ...wechat, messages: wechat.messages.map((m) => ({ ...m, routedTitle: !m.routedTo ? null : m.routedTo.startsWith("claude:") ? `Claude · ${m.routedTo.slice(7)}` : m.routedTo.startsWith("codex:") ? "Codex" : (m.routedTo === "new" || m.routedTo.startsWith("new:")) ? "新开窗口" : agyById[m.routedTo]?.title || m.routedTo.slice(0, 8) })) },
    pending,
    lockedSession: routerState.lockedSession || null,
    constraints: readConstraints((cid) => (cid && agyById[cid]?.title) || (cid && cid.startsWith("claude:") ? `Claude · ${cid.slice(7)}` : cid ? cid.slice(0, 8) : "")),
  };
}

function sessionDetail(engine, id) {
  if (engine === "agy") {
    const s = scanAgy().find((x) => x.id === id);
    if (!s) return null;
    const sent = (readJson(path.join(CLAWBOT, "msg_session_map.json"), { recent: [] }).recent || [])
      .filter((e) => e.cid === id && e.createdAt)
      .map((e) => ({ at: new Date(e.createdAt).toISOString(), text: String(e.bodySnippet || "").slice(0, 1200) }));
    const seen = new Set();
    const reports = [...sent, ...s.reports]
      .sort((a, b) => (a.at < b.at ? -1 : 1))
      .filter((r) => {
        const k = String(r.text).replace(/\s+/g, "").slice(0, 40);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(-12);
    return { ...slimSession(s), eruMsgs: s.eruMsgs, reports, lastAi: s.lastAi, firstUser: clip(s.firstUser, 600) };
  }
  if (engine === "claude") {
    const s = scanClaude().find((x) => x.id === id);
    if (!s) return null;
    return { ...slimSession(s), eruMsgs: [], reports: [], lastAi: s.lastAi, firstUser: clip(s.firstUser, 600) };
  }
  return null;
}

// ---------- 写回项目登记表 ----------
// ---------- 在工作台直接给窗口发消息：和微信走同一条路（原话存档 → 路由 → 验收/看门狗/承诺照常生效） ----------
async function sendToWindow(projectId, text) {
  const t = text.trim();
  if (!t) throw new Error("消息是空的");
  if (t.length > 4000) throw new Error("消息太长了");
  const core = await import(path.join(CLAWBOT, "core.mjs"));
  const rules = core.loadRules();
  const route = rules.routes?.[projectId];
  if (!route) throw new Error("这个项目还没有对应的窗口");
  const msgId = core.saveInboundMsg({ text: t, media: [], mediaFiles: [], source: "workbench" });
  core.saveRouterState({ lastInboundMsgId: msgId });
  const { routeMessage } = await import(path.join(CLAWBOT, "agy-route.mjs"));
  const r = await routeMessage({ msgId, to: projectId, via: "工作台" });
  fs.appendFileSync(path.join(CLAWBOT, "bridge.log"), `[${new Date().toISOString()}] [AGY-ClawBot-V3] Direct-routed msg=${msgId} via 工作台 → ${projectId} (${r.engine})\n`);
  return { ok: true, title: route.name, engine: r.engine };
}

const EDITABLE = new Set(["status", "headline", "next", "owner", "flag"]);
const STATUS = new Set(["running", "decide", "blocked", "idle", "stopped", "done"]);
function updateProject(id, patch) {
  const reg = readJson(PROJECTS_FILE, null);
  if (!reg) throw new Error("projects.json 读取失败");
  const p = reg.projects.find((x) => x.id === id);
  if (!p) throw new Error("没有这个项目");
  for (const [k, v] of Object.entries(patch || {})) {
    if (!EDITABLE.has(k)) continue;
    if (k === "status" && !STATUS.has(v)) continue;
    p[k] = String(v ?? "").slice(0, 400);
  }
  p.updatedAt = new Date().toISOString();
  const tmp = PROJECTS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n");
  fs.renameSync(tmp, PROJECTS_FILE);
  return p;
}

function allowedPaths() {
  const reg = readJson(PROJECTS_FILE, { projects: [] });
  const set = new Set();
  for (const p of reg.projects) {
    for (const x of p.paths || []) set.add(x);
    if (p.doc) set.add(p.doc);
  }
  return set;
}

// ---------- HTTP ----------
function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (d) => {
      b += d;
      if (b.length > 50_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    // 只接受本机来源，防止别的网页跨站调用写接口
    const origin = req.headers.origin;
    if (req.method !== "GET" && origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return send(res, 403, { error: "forbidden" });
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(res, 200, fs.readFileSync(path.join(__dirname, "index.html")), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return send(res, 200, await buildState());
    }
    if (req.method === "GET" && url.pathname === "/api/session") {
      const d = sessionDetail(url.searchParams.get("engine"), url.searchParams.get("id"));
      return d ? send(res, 200, d) : send(res, 404, { error: "not found" });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/project/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/project/".length));
      const body = await readBody(req);
      return send(res, 200, updateProject(id, body));
    }
    if (req.method === "POST" && url.pathname === "/api/send") {
      const body = await readBody(req);
      return send(res, 200, await sendToWindow(String(body.project || ""), String(body.text || "")));
    }
    if (req.method === "POST" && url.pathname === "/api/open") {
      const body = await readBody(req);
      const target = String(body.path || "");
      if (!allowedPaths().has(target)) return send(res, 400, { error: "只允许打开登记表里的路径" });
      if (!statSafe(target)) return send(res, 404, { error: "路径不存在" });
      spawn("/usr/bin/open", statSafe(target).isDirectory() ? [target] : ["-R", target], { stdio: "ignore", detached: true }).unref();
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`波妞工作台已启动 → http://127.0.0.1:${PORT}`);
});
