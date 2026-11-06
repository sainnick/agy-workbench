/**
 * 承诺追踪（防「先答应、后没下文」）
 *
 * - 登记：窗口发微信时说了「马上 / 立刻 / 现在就去 / 正在 + 做某事」，自动登记成一条承诺，带截止时间
 *   （句子里写了「10 分钟 / 半小时 / 2 小时」就按它，否则默认 30 分钟，最长 4 小时）
 * - 兑现：同一窗口之后发出带「通过核验的回执」的消息 → 之前的承诺记为已兑现。
 *   承诺里提到调研 / Deep Research 的，必须是 research 回执通过才算兑现。
 * - 到期：bridge 每分钟巡检，过期没兑现 → 微信提醒 eru + 往该 AGY 窗口发一次系统催办（各一次）
 * - eru 可以用 /drop <编号> 撤销不需要再做的承诺
 */
import path from "node:path";
import crypto from "node:crypto";
import { readJson, updateJson } from "./state-io.mjs";
import { CLAWBOT_DIR, UUID_RE, routerCidSet, loadRouterState } from "./core.mjs";

export const COMMITMENTS_FILE = path.join(CLAWBOT_DIR, "commitments.json");
const DEFAULT_DUE_MIN = 30;
const MAX_DUE_MIN = 240;
const KEEP_ITEMS = 300;

const PROMISE_RE =
  /(马上|立刻|立即|现在就|这就|随后|稍后|待会儿?|接下来我?|我这就|我现在|我去|我会|正在|继续)[^。！？!?\n]{0,30}?(跑|做|改|写|查|调|抓|出|发|渲染|重构|生成|修|整理|研究|调研|检索|搜索|拆解|审|补|重做|实现|开发|部署|测|录|剪)/;
const ASKING_RE = /要不要|是否|可以吗|行吗|好吗|您看|你看|需要我|要我|如果你|如果您|等你|等您|你确认|您确认|拍板后|确认后/;
const RESEARCH_RE = /调研|deep\s*research|深度研究|检索|对标|拆解|查证/i;

function parseDueMinutes(sentence) {
  const s = String(sentence);
  let m;
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*(个)?\s*小时/))) return Math.min(MAX_DUE_MIN, Math.round(Number(m[1]) * 60));
  if (/半(个)?小时/.test(s)) return 30;
  if (/一(个)?小时/.test(s)) return 60;
  if (/两(个)?小时/.test(s)) return 120;
  if ((m = s.match(/(\d+)\s*分钟/))) return Math.min(MAX_DUE_MIN, Math.max(5, Number(m[1])));
  return DEFAULT_DUE_MIN;
}

/** 从一条外发消息里找出承诺句（排除征求意见的问句） */
export function detectPromises(text) {
  const out = [];
  const sentences = String(text || "")
    .replace(/\*\*/g, "")
    .split(/(?<=[。！!？?\n；;])/);
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s || s.length < 6) continue;
    if (/[？?]\s*$/.test(s) || ASKING_RE.test(s)) continue;
    if (!PROMISE_RE.test(s)) continue;
    out.push({ text: s.slice(0, 120), dueMin: parseDueMinutes(s), needsResearch: RESEARCH_RE.test(s) });
  }
  return out.slice(0, 3);
}

function load() {
  try {
    return readJson(COMMITMENTS_FILE, { items: {} });
  } catch {
    return { items: {} };
  }
}

export function listOpenCommitments() {
  return Object.values(load().items || {})
    .filter((c) => c.status === "open")
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 先兑现旧承诺，再登记新承诺（同一条消息里的回执不会兑现它自己新许下的承诺）。
 * results: proof.runProof 的结果数组
 */
export function processOutgoing({ cid, title, text, results, dryRun = false }) {
  const report = { fulfilled: [], registered: [] };
  if (!cid || cid === "unassigned") return report;
  // 只有 AGY 执行窗口的承诺才登记：总控窗口和 Claude/Codex 后台结果（claude:xx）说「接下来我会…」时任务已结束，登记了只会白催
  const canRegister = UUID_RE.test(cid) && !routerCidSet().has(cid);
  const okKinds = new Set(results.filter((r) => r.level === "ok").map((r) => r.kind));
  const promises = detectPromises(text);
  const now = Date.now();

  const apply = (db) => {
    db.items = db.items || {};
    if (okKinds.size) {
      for (const c of Object.values(db.items)) {
        if (c.cid !== cid || c.status !== "open") continue;
        if (c.needsResearch && !okKinds.has("research")) continue;
        c.status = "fulfilled";
        c.fulfilledAt = now;
        c.fulfilledBy = [...okKinds].join("+");
        report.fulfilled.push(c);
      }
    }
    // 被催过还没兑现、且催办之后 eru 没给这个窗口派过新消息 → 不再登记新承诺（防「催办 → 我马上补 → 再催」死循环）
    // eru 派了新任务（lastDispatch 晚于催办）就照常登记
    const lastDispatchAt = loadRouterState().lastDispatch?.[cid]?.at || 0;
    const nudgedOpen = Object.values(db.items).some((c) => c.cid === cid && c.status === "open" && c.remindedAt && c.remindedAt > lastDispatchAt);
    for (const p of canRegister && !nudgedOpen ? promises : []) {
      const dup = Object.values(db.items).find((c) => c.cid === cid && c.status === "open" && c.text === p.text);
      if (dup) continue;
      const id = `c${now.toString(36).slice(-4)}${crypto.randomBytes(1).toString("hex")}`;
      const item = {
        id,
        cid,
        title: title || cid.slice(0, 8),
        text: p.text,
        needsResearch: p.needsResearch,
        createdAt: now,
        dueAt: now + p.dueMin * 60_000,
        dueMin: p.dueMin,
        status: "open",
        remindedAt: 0,
      };
      db.items[id] = item;
      report.registered.push(item);
    }
    const ids = Object.keys(db.items);
    if (ids.length > KEEP_ITEMS) {
      ids
        .sort((a, b) => db.items[b].createdAt - db.items[a].createdAt)
        .slice(KEEP_ITEMS)
        .forEach((k) => delete db.items[k]);
    }
    return db;
  };

  if (dryRun) apply(structuredClone(load()));
  else updateJson(COMMITMENTS_FILE, { items: {} }, apply);
  return report;
}

/** 取出已过期、还没提醒过的承诺，并标记为已提醒 */
export function takeOverdue(now = Date.now()) {
  const due = [];
  updateJson(COMMITMENTS_FILE, { items: {} }, (db) => {
    for (const c of Object.values(db.items || {})) {
      if (c.status === "open" && !c.remindedAt && now >= c.dueAt) {
        c.remindedAt = now;
        due.push({ ...c });
      }
    }
    return db;
  });
  return due;
}

export function dropCommitment(id) {
  let hit = null;
  updateJson(COMMITMENTS_FILE, { items: {} }, (db) => {
    const c = db.items?.[id];
    if (c && c.status === "open") {
      c.status = "dropped";
      c.droppedAt = Date.now();
      hit = c;
    }
    return db;
  });
  return hit;
}

export function fmtAgo(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m < 60 ? `${m} 分钟` : `${(m / 60).toFixed(1)} 小时`;
}

/** 交付已进入 Claude 审查：该窗口未兑现的承诺截止时间顺延，审查期间不算「答应了没交」 */
export function holdForReview(cid, minutes = 20) {
  if (!cid) return;
  const until = Date.now() + minutes * 60_000;
  updateJson(COMMITMENTS_FILE, { items: {} }, (db) => {
    for (const c of Object.values(db.items || {})) {
      if (c.cid === cid && c.status === "open" && !c.remindedAt && c.dueAt < until) c.dueAt = until;
    }
    return db;
  });
}

/** 催办限流：同一窗口 2 小时内最多催 2 次，再往后只提醒 eru */
export function claimNudgeSlot(cid, now = Date.now(), max = 2, windowMs = 2 * 3600_000) {
  let ok = false;
  updateJson(COMMITMENTS_FILE, { items: {} }, (db) => {
    db.nudges = db.nudges || {};
    const recent = (db.nudges[cid] || []).filter((t) => now - t < windowMs);
    ok = recent.length < max;
    if (ok) recent.push(now);
    db.nudges[cid] = recent;
    return db;
  });
  return ok;
}
