/**
 * ClawBot 公共核心：路径常量、rules.json（唯一事实来源）、路由状态、原话存档
 * bridge.mjs / agy-route.mjs / weixin-send.mjs / job-runner.mjs 共用，避免循环依赖与多处硬编码。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { readJson, updateJson } from "./state-io.mjs";

export const CLAWBOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const HUB_DIR = "/Users/eru/Desktop/agy工作站";
export const BRAIN_DIR = process.env.CLAWBOT_BRAIN_DIR || "/Users/eru/.gemini/antigravity/brain";
export const DRY_RUN = process.env.CLAWBOT_DRY_RUN === "1";
export const STATE_FILE = path.join(CLAWBOT_DIR, "router_state.json");
export const RULES_FILE = path.join(CLAWBOT_DIR, "rules.json");
export const PEER_FILE = path.join(CLAWBOT_DIR, "latest_peer.json");
export const MSG_MAP_FILE = path.join(CLAWBOT_DIR, "msg_session_map.json");
export const MSG_STORE_DIR = path.join(CLAWBOT_DIR, "inbox", "msgs");
export const JOBS_DIR = path.join(CLAWBOT_DIR, "jobs");
export const DEFAULT_ROUTER_CID = "df666dc1-4b27-4fe4-ae54-5911bf805f99";
/** 历任路由窗口（它们发出的消息不算"子窗口汇报"） */
export const LEGACY_ROUTER_CIDS = ["f9055825-52b3-4d6c-9023-331ac6f68543"];
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATE_DEFAULTS = {
  routerCid: DEFAULT_ROUTER_CID,
  lastRoutedCid: null,
  lastRoutedTitle: null,
  lastRoutedEngine: "agy",
  lastRoutedAt: null,
  lockedSession: null, // { engine: 'agy'|'codex'|'claude', cid, title, cwd?, project? }
  sessionAliases: {},
  legacyMirrors: {},
  pendingReplies: {},
  engineSessions: {}, // { "claude:echo": "<claude session_id>" }
};

export function loadRules() {
  try {
    return readJson(RULES_FILE, { projects: {}, routes: {}, sessionPinMap: {}, allowUsers: [] });
  } catch {
    return { projects: {}, routes: {}, sessionPinMap: {}, allowUsers: [] };
  }
}

/** 只读：解析失败时返回默认值（只用于读，绝不会写回） */
export function loadRouterState() {
  try {
    return { ...structuredClone(STATE_DEFAULTS), ...readJson(STATE_FILE, {}) };
  } catch {
    return structuredClone(STATE_DEFAULTS);
  }
}

/** 加锁合并顶层字段 */
export function saveRouterState(patch) {
  return updateJson(STATE_FILE, {}, (cur) => ({ ...structuredClone(STATE_DEFAULTS), ...cur, ...patch }));
}

/** 加锁读改写：mutator 拿到的是最新状态，避免多进程互相覆盖 */
export function updateRouterState(mutator) {
  return updateJson(STATE_FILE, {}, (cur) => {
    const st = { ...structuredClone(STATE_DEFAULTS), ...cur };
    return mutator(st) ?? st;
  });
}

export function routerCidSet(st = loadRouterState()) {
  return new Set([st.routerCid, st.previousRouterCid, DEFAULT_ROUTER_CID, ...LEGACY_ROUTER_CIDS].filter(Boolean));
}

/** legacyMirrors 链式解析到底（带防环） */
export function resolveMirror(cid, st = loadRouterState()) {
  const mirrors = st.legacyMirrors || {};
  let cur = cid;
  const seen = new Set([cur]);
  while (mirrors[cur] && !seen.has(mirrors[cur])) {
    cur = mirrors[cur];
    seen.add(cur);
  }
  return cur;
}

/** 由会话 ID 反查路由键（rules.routes[*].cid + legacyMirrors + sessionPinMap） */
export function routeKeyForCid(cid, rules = loadRules(), st = loadRouterState()) {
  if (!cid) return null;
  const eff = resolveMirror(cid, st);
  for (const [key, r] of Object.entries(rules.routes || {})) {
    if (r.cid && (r.cid === cid || r.cid === eff || resolveMirror(r.cid, st) === eff)) return key;
  }
  return null;
}

/** 同一套关键词判断供直投和分拣使用。 */
export function keywordHits(text, rules = loadRules()) {
  const t = String(text || "").toLowerCase();
  if (!t) return [];
  return Object.entries(rules.routes || {})
    .filter(([, route]) => (route.keywords || []).some((keyword) => {
      const word = String(keyword || "").toLowerCase();
      if (word === "客户") return /客户(?!端)/.test(t);
      return word && t.includes(word);
    }))
    .map(([key]) => key);
}

export function matchRouteByKeywords(text, rules = loadRules()) {
  const hits = keywordHits(text, rules);
  return hits.length === 1 ? hits[0] : null;
}

// ───────── 原话存档：eru 每条微信原样落盘，转发时只传编号，结构上杜绝转述篡改 ─────────

export function newMsgId() {
  return `m${Date.now().toString(36)}${crypto.randomBytes(1).toString("hex")}`;
}

export function saveInboundMsg(msg) {
  fs.mkdirSync(MSG_STORE_DIR, { recursive: true });
  const id = msg.id || newMsgId();
  const rec = { id, createdAt: new Date().toISOString(), ...msg };
  fs.writeFileSync(path.join(MSG_STORE_DIR, `${id}.json`), JSON.stringify(rec, null, 2));
  return id;
}

export function loadInboundMsg(id) {
  const safe = String(id || "").replace(/[^a-z0-9]/gi, "");
  const p = path.join(MSG_STORE_DIR, `${safe}.json`);
  if (!safe || !fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function markInboundMsg(id, patch) {
  const rec = loadInboundMsg(id);
  if (!rec) return;
  const next = { ...rec, ...patch, routes: [...(rec.routes || []), ...(patch.routes || [])] };
  fs.writeFileSync(path.join(MSG_STORE_DIR, `${rec.id}.json`), JSON.stringify(next, null, 2));
}

/** 把存档的消息还原成逐字文本（原话 + 引用 + 附件路径），不经任何 LLM */
export function composeVerbatim(rec) {
  if (!rec) return "";
  return [
    rec.quote?.partialQuoteText
      ? `[eru 在微信局部划词引用了：「${rec.quote.partialQuoteText}」]`
      : rec.quote?.fullQuotedBody
      ? `[eru 在微信长按引用了历史消息：「${rec.quote.fullQuotedBody}」]`
      : "",
    rec.text || "(纯媒体消息)",
    rec.media?.length ? `📎 附带本地文件：\n${rec.media.map((p) => `- ${p}`).join("\n")}` : "",
    rec.related?.text ? `[同一微信联系人紧接着发送附件前的原话：「${rec.related.text}」]` : "",
    rec.related?.media?.length ? `[同一微信联系人紧接着发文字前的附件]\n${rec.related.media.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
