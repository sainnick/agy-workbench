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

/** 加锁读改写：bridge 与总控调用的 agy-route 可能同时追加 routes，不能互相覆盖（审计 P2-2） */
export function markInboundMsg(id, patch) {
  const rec = loadInboundMsg(id);
  if (!rec) return;
  updateJson(path.join(MSG_STORE_DIR, `${rec.id}.json`), rec, (cur) => ({ ...cur, ...patch, routes: [...(cur.routes || []), ...(patch.routes || [])] }));
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

// ───────── 待回汇报（pendingReplies）生命周期：按项目归并 + 4 小时自动归档 ─────────
// 之前的缺陷：只有 eru 的消息再次路由到「同一个 cid」才会清掉，
// 走 Claude CLI / 别的窗口 / 在电脑前直接处理的事永远挂着，变成僵尸待办反复提醒。
export const PENDING_TTL_MS = 4 * 3600_000;
const PROJECTS_FILE = path.join(HUB_DIR, "workbench", "projects.json");

/** 会话 → 项目键：rules 路由 > claude:<键> > workbench/projects.json > 窗口别名 */
export function projectKeyForCid(cid, st = loadRouterState(), rules = loadRules()) {
  if (!cid) return null;
  if (String(cid).startsWith("claude:")) return String(cid).slice(7) || null;
  const rk = routeKeyForCid(cid, rules, st);
  if (rk) return rk;
  try {
    const eff = resolveMirror(cid, st);
    const reg = readJson(PROJECTS_FILE, { projects: [] });
    for (const p of reg.projects || []) {
      if ((p.sessions || []).some((s) => s.cid === cid || s.cid === eff)) return p.id;
    }
  } catch {}
  const alias = st.sessionAliases?.[cid];
  return alias ? `alias:${alias}` : null;
}

export function isPendingLive(p, now = Date.now()) {
  return Boolean(p && p.cid && now - (p.sentAt || 0) < PENDING_TTL_MS);
}

/** 只读：还在时效内的待回汇报 */
export function livePending(st = loadRouterState(), now = Date.now()) {
  return Object.values(st.pendingReplies || {}).filter((p) => isPendingLive(p, now));
}

function archivePending(st, items, reason, now) {
  if (!items.length) return;
  st.pendingArchive = [...items.map((p) => ({ ...p, archivedAt: now, archivedReason: reason })), ...(st.pendingArchive || [])].slice(0, 50);
}

/** 在 mutator 里调用：超时的待回挪进 pendingArchive */
export function prunePending(st, now = Date.now()) {
  const pm = { ...(st.pendingReplies || {}) };
  const stale = Object.values(pm).filter((p) => !isPendingLive(p, now));
  for (const p of stale) delete pm[p.cid];
  st.pendingReplies = pm;
  archivePending(st, stale, "expired_4h", now);
  return stale;
}

/** 在 mutator 里调用：同一项目任何窗口 / Claude 有新动作、或 eru 给该项目发了新消息 → 清掉该项目所有旧待回 */
export function clearProjectPending(st, cid, reason = "project_activity", now = Date.now()) {
  if (!cid) return [];
  const rules = loadRules();
  const key = projectKeyForCid(cid, st, rules);
  const pm = { ...(st.pendingReplies || {}) };
  const hit = Object.values(pm).filter((p) => p && (p.cid === cid || (key && projectKeyForCid(p.cid, st, rules) === key)));
  for (const p of hit) delete pm[p.cid];
  st.pendingReplies = pm;
  archivePending(st, hit, reason, now);
  touchProject(st, key, now); // 该项目有新动作 → 「下一期提醒」4 小时内不出现
  return hit;
}

// ───────── 自媒体矩阵「🎬 下一期提醒」 ─────────
// 工程 / 副业的一次性待回：超 4 小时直接归档，不再打扰。
// 抖音矩阵账号不同：上一期的具体待办归档后，如果该号当前没有进行中的新一期，
// 就换成一条干净的「待开下一期」提醒——只提醒 eru 拍板，Agent 绝不自动开新集（铁律 2）。
export const MEDIA_PROJECT_KEYS = ["sanhao", "zhezhou", "echo", "zeroclinic", "leiting", "zeus"];
export const MEDIA_GROUP = "抖音矩阵";

export function isMediaProject(p) {
  return Boolean(p && (p.group === MEDIA_GROUP || MEDIA_PROJECT_KEYS.includes(p.id)));
}

/** 从标题 / 汇报里抽出干净的期名（EP02《OK Computer》/《边沁：功利主义》），抽不到返回 null */
function episodeLabel(text) {
  const s = String(text || "");
  const m = s.match(/EP\s?\d+\s*《[^》]{1,30}》/i) || s.match(/EP\s?\d+/i) || s.match(/《[^》]{1,30}》/);
  return m ? m[0].replace(/\s+/g, " ") : null;
}

/** 项目最近活动打点（clearProjectPending 被调用 = 窗口/Claude/eru 对该项目有新动作） */
function touchProject(st, key, now) {
  if (!key) return;
  st.projectActivityAt = { ...(st.projectActivityAt || {}), [key]: now };
}

/**
 * 只读：哪些自媒体账号该提醒 eru 拍板开下一期。
 * 判定「有进行中的新一期」（满足任一就不提醒）：
 *   - 该号还有 4 小时内的待回汇报；
 *   - 该号有还在计时的承诺（commitments open）；
 *   - 4 小时内该号有新动作（窗口发汇报 / Claude 接活 / eru 发话，见 projectActivityAt）；
 *   - projects.json 里状态是 stopped（停更的号不催）。
 */
export function nextEpisodeReminders(st = loadRouterState(), now = Date.now(), opts = {}) {
  const rules = loadRules();
  const reg = opts.registry || readJson(PROJECTS_FILE, { projects: [] });
  const commitments = opts.commitments || readJson(path.join(CLAWBOT_DIR, "commitments.json"), { items: {} });
  const keyOf = (cid) => projectKeyForCid(cid, st, rules);
  const liveKeys = new Set(livePending(st, now).map((p) => keyOf(p.cid)).filter(Boolean));
  const promiseKeys = new Set(
    Object.values(commitments.items || {})
      .filter((c) => c && c.status === "open" && now - (c.dueAt || 0) <= PENDING_TTL_MS)
      .map((c) => keyOf(c.cid))
      .filter(Boolean)
  );
  const out = [];
  for (const p of reg.projects || []) {
    if (!isMediaProject(p) || p.status === "stopped") continue;
    if (liveKeys.has(p.id) || promiseKeys.has(p.id)) continue;
    const act = st.projectActivityAt?.[p.id] || 0;
    if (now - act < PENDING_TTL_MS) continue;
    const last = (st.pendingArchive || []).find((a) => a && keyOf(a.cid) === p.id) || null;
    const headline = p.headline && !/暂无活跃窗口/.test(p.headline) ? p.headline : "";
    const prev = episodeLabel(last?.summary) || episodeLabel(headline) || (headline ? headline.slice(0, 24) : "") || "暂无近期记录";
    const lastAt = Math.max(last?.sentAt || 0, act) || null;
    // 本期还卡在 eru 拍板（选剧本 / 审稿）→ 不是「已交片」，提醒的是本期的拍板，不是开新集
    if (["decide", "blocked"].includes(p.status) && !last) {
      out.push({ key: p.id, name: p.name, kind: "decide", prev, lastAt, text: `⏳ 本期（${prev}）还等你拍板：${p.next || headline || "看一下进度"}` });
      continue;
    }
    out.push({
      key: p.id,
      name: p.name,
      kind: "next",
      prev,
      lastAt,
      text: prev === "暂无近期记录"
        ? "🎬 下一期提醒：最近没有在做的一期，待拍板开启下一期选题/制作"
        : `🎬 下一期提醒：上一期已交片，待拍板开启下一期选题/制作（上一期：${prev}）`,
    });
  }
  return out;
}
