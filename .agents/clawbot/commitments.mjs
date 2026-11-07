/**
 * 承诺追踪（防「先答应、后没下文」）
 *
 * - 登记：窗口发微信时说了「马上 / 立刻 / 现在就去 / 正在 + 做某事」，自动登记成一条承诺，带截止时间
 *   同一窗口最多 1 条活跃承诺：后续承诺 / 进度汇报合并进这一条；「进度汇报」且没给新时间点的不新建（GPT 二审 P1-4）
 *   （句子里写了「10 分钟 / 半小时 / 2 小时」就按它，否则默认 30 分钟，最长 4 小时）
 * - 兑现：同一窗口之后发出带「通过核验的回执」的消息，且能绑定到该承诺（--task / 当前派发任务 / 回执文件名或关键词）
 *   → 记为已兑现；绑定不上就保持待核验，不盲目核销。
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
/** 无 taskId 时核销所需的最低匹配分：交付物文件名命中（6~10 分）或至少两个关键词（各 2 分） */
const MIN_MATCH_SCORE = 4;
/** 超时 4 小时还没兑现：已催过一次、eru 也没再追，自动归档为 expired，不再出现在「答应了还没交」 */
export const STALE_AFTER_DUE_MS = 4 * 3600_000;
const isStale = (c, now = Date.now()) => c.status === "open" && now - (c.dueAt || 0) > STALE_AFTER_DUE_MS;

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

/** 「进度汇报」类阶段性消息：开头就是进度/进展汇报（允许前面有【项目名】） */
const PROGRESS_HEAD_RE = /^\s*(【[^】]{1,30}】\s*)?(\[[^\]]{1,30}\]\s*)?(🟡|⏳|📍|🔄)?\s*(进度汇报|进度更新|进展汇报|阶段汇报|阶段进展|进度同步|进度)/;
/** 句子里有没有给出新的具体时间点 */
const EXPLICIT_TIME_RE = /\d+(\.\d+)?\s*(个)?\s*(分钟|小时)|半(个)?小时|[一两三]\s*(个)?小时|\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*点(半|钟|前|之前)?/;

export function isProgressReport(text) {
  return PROGRESS_HEAD_RE.test(String(text || "").replace(/\*\*/g, ""));
}

/**
 * 从一条外发消息里找出承诺（排除征求意见的问句）。
 * 一条消息最多合成 1 条承诺（GPT 二审 P1-4：不再一条消息登记 3 个闹钟）。
 * 开头是「进度汇报」且没给新的具体时间点 → 不算新承诺（返回空数组），只用来刷新已有承诺的进度文本。
 */
export function detectPromises(text) {
  const raw = String(text || "").replace(/\*\*/g, "");
  const hits = [];
  for (const piece of raw.split(/(?<=[。！!？?\n；;])/)) {
    const s = piece.trim();
    if (!s || s.length < 6) continue;
    if (/[？?]\s*$/.test(s) || ASKING_RE.test(s)) continue;
    if (!PROMISE_RE.test(s)) continue;
    hits.push(s);
  }
  if (hits.length === 0) return [];
  const timed = hits.filter((s) => EXPLICIT_TIME_RE.test(s));
  if (isProgressReport(raw) && timed.length === 0) return [];
  const main = timed[0] || hits[0];
  return [
    {
      text: main.slice(0, 120),
      dueMin: Math.min(...(timed.length ? timed : [main]).map(parseDueMinutes)),
      explicitTime: timed.length > 0,
      needsResearch: hits.some((s) => RESEARCH_RE.test(s)),
    },
  ];
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
    .filter((c) => c.status === "open" && !isStale(c))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 评估承诺与当前回执/正文的匹配得分（用于同一窗口多条未结承诺时选出最匹配的一条）
 */
function scoreCommitmentMatch(c, text, okResults) {
  let score = 0;
  const cText = String(c.text || "").toLowerCase();
  const msgText = String(text || "").toLowerCase();
  for (const r of okResults || []) {
    const base = path.basename(String(r.target || "")).toLowerCase();
    const stem = base.replace(/\.[^.]+$/, "");
    if (base && cText.includes(base)) score += 10;
    else if (stem && stem.length >= 3 && cText.includes(stem)) score += 6;
  }
  const tokens = cText.match(/[\u4e00-\u9fa5]{2,6}|[a-z0-9_-]{3,}/gi) || [];
  for (const tok of tokens) {
    if (/^(马上|立刻|立即|现在|这就|随后|稍后|接下来|正在|继续|分钟|小时)$/.test(tok)) continue;
    if (msgText.includes(tok)) score += 2;
  }
  return score;
}

/**
 * 在 db.items 上执行承诺核销（内部可变操作）：
 * 1. 若显式指定 commitmentId（支持逗号分隔多个 id），仅精确核销对应 id；
 * 2. 若显式指定 taskId，仅核销绑定了该 taskId 的承诺（若同 taskId 下有多条，优先匹配度最高或最新的一条）；
 * 3. 若未指定 commitmentId / taskId，优先核销目标路径/关键词匹配度最高的 1 条，否则仅核销该窗口最新 1 条匹配的 open 承诺，绝不清空整个窗口全部不相关承诺。
 */
function settleInDb(db, { cid, commitmentId = null, taskId = null, preferTaskId = null, text = "", results = [], messageId = null, now = Date.now() }) {
  const fulfilled = [];
  db.items = db.items || {};
  const okResults = (results || []).filter((r) => r.level === "ok");
  const okKinds = new Set(okResults.map((r) => r.kind));
  if (okKinds.size === 0) return fulfilled;

  const explicitIds = commitmentId
    ? new Set(
        String(commitmentId)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      )
    : null;

  const candidates = Object.values(db.items).filter((c) => {
    if (!c || c.status !== "open") return false;
    if (c.needsResearch && !okKinds.has("research")) return false;
    if (explicitIds && explicitIds.size > 0) {
      return explicitIds.has(c.id) && (!cid || cid === "unassigned" || c.cid === cid);
    }
    if (!cid || cid === "unassigned" || c.cid !== cid) return false;
    if (taskId) return c.taskId === taskId;
    return true;
  });

  if (candidates.length === 0) return fulfilled;

  let toFulfill = [];
  if (explicitIds && explicitIds.size > 0) {
    toFulfill = candidates;
  } else {
    // 按匹配得分优先，其次按创建时间最新排序，每次回执只核销最相关的 1 条承诺
    // 服务端的当前任务（lastDispatch[cid].msgId）优先：交付物 A 不去核销别的任务的承诺 B
    candidates.sort((a, b) => {
      if (preferTaskId) {
        const ta = a.taskId === preferTaskId ? 1 : 0;
        const tb = b.taskId === preferTaskId ? 1 : 0;
        if (tb !== ta) return tb - ta;
      }
      const sa = scoreCommitmentMatch(a, text, okResults);
      const sb = scoreCommitmentMatch(b, text, okResults);
      if (sb !== sa) return sb - sa;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
    // 精准绑定（GPT 二审 P1-4）：没有显式 taskId 时，只核销「属于当前派发任务」或「回执/正文与承诺明确对得上」的那条；
    // 都对不上就保持待核验，绝不拿一份不相关的回执结清别的承诺
    const top = candidates[0];
    const bound = (preferTaskId && top.taskId === preferTaskId) || scoreCommitmentMatch(top, text, okResults) >= MIN_MATCH_SCORE;
    toFulfill = bound ? [top] : [];
  }

  const targets = okResults.map((r) => r.target).filter(Boolean);
  for (const c of toFulfill) {
    c.status = "fulfilled";
    c.fulfilledAt = now;
    c.fulfilledBy = [...okKinds].join("+");
    if (taskId || c.taskId) c.fulfilledTaskId = taskId || c.taskId || null;
    if (messageId) c.fulfilledMessageId = messageId;
    if (targets.length) c.fulfilledTargets = targets;
    fulfilled.push(c);
  }
  return fulfilled;
}

/**
 * 独立精确核销接口：支持按 commitmentId 或 taskId（或窗口最新匹配项）核销承诺
 */
export function settleCommitments({ cid, commitmentId = null, taskId = null, preferTaskId = null, text = "", results = [], messageId = null, dryRun = false }) {
  let fulfilled = [];
  const now = Date.now();
  const apply = (db) => {
    fulfilled = settleInDb(db, { cid, commitmentId, taskId, preferTaskId, text, results, messageId, now });
    return db;
  };
  if (dryRun) apply(structuredClone(load()));
  else updateJson(COMMITMENTS_FILE, { items: {} }, apply);
  return fulfilled;
}

/**
 * 先兑现旧承诺，再登记新承诺（同一条消息里的回执不会兑现它自己新许下的承诺）。
 * results: proof.runProof 的结果数组
 */
export function processOutgoing({ cid, title, text, results = [], commitmentId = null, taskId = null, messageId = null, register = true, dryRun = false }) {
  const report = { fulfilled: [], registered: [], merged: [] };
  if (!cid || cid === "unassigned") return report;
  // 只有 AGY 执行窗口的承诺才登记：总控窗口和 Claude/Codex 后台结果（claude:xx）说「接下来我会…」时任务已结束，登记了只会白催
  const canRegister = register && UUID_RE.test(cid) && !routerCidSet().has(cid);
  const promises = detectPromises(text);
  const progress = isProgressReport(text);
  const now = Date.now();
  const routerSt = loadRouterState();
  const activeTaskId = taskId || routerSt.lastDispatch?.[cid]?.msgId || null;

  const apply = (db) => {
    db.items = db.items || {};
    report.fulfilled = settleInDb(db, {
      cid,
      commitmentId,
      taskId,
      preferTaskId: activeTaskId,
      text,
      results,
      messageId,
      now,
    });
    if (canRegister) registerOrMerge(db, { cid, title, text, promises, progress, activeTaskId, routerSt, now, report });
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

/**
 * 同一窗口最多 1 条活跃承诺（GPT 二审 P1-4）：
 *  - 已有活跃承诺：新承诺 / 新进度合并进去（更新文本），不再叠加新闹钟；
 *    只有给出新的具体时间点、且不处在「被催过后 eru 还没派新活」的状态，才改截止时间并重新计催
 *  - 没有活跃承诺：只有真正的承诺句才登记；「进度汇报」且没给新时间点的不登记
 *  - 历史遗留的多条同窗活跃承诺顺手收拢成最新一条，其余记为 merged
 */
function registerOrMerge(db, { cid, title, text, promises, progress, activeTaskId, routerSt, now, report }) {
  const open = Object.values(db.items)
    .filter((c) => c.cid === cid && c.status === "open" && !isStale(c, now))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const lastDispatchAt = routerSt.lastDispatch?.[cid]?.at || 0;
  const p = promises[0] || null;
  if (open.length) {
    const keep = open[0];
    for (const extra of open.slice(1)) {
      extra.status = "merged";
      extra.mergedInto = keep.id;
      extra.mergedAt = now;
    }
    const nudgedNoNewTask = keep.remindedAt && keep.remindedAt > lastDispatchAt;
    const newText = p ? p.text : progress ? String(text || "").replace(/\*\*/g, "").trim().slice(0, 120) : null;
    if (newText || open.length > 1) {
      if (newText && newText !== keep.text) {
        keep.originalText = keep.originalText || keep.text;
        keep.text = newText;
      }
      keep.updatedAt = now;
      keep.mergedCount = (keep.mergedCount || 0) + (newText ? 1 : 0);
      if (p?.needsResearch) keep.needsResearch = true;
      if (p?.explicitTime && !nudgedNoNewTask) {
        keep.dueAt = now + p.dueMin * 60_000;
        keep.dueMin = p.dueMin;
        keep.remindedAt = 0;
      }
      if (activeTaskId && !keep.taskId) keep.taskId = activeTaskId;
      report.merged.push(keep);
    }
    return;
  }
  if (!p) return;
  // 被催过还没兑现、且催办之后 eru 没给这个窗口派过新消息 → 不再登记新承诺（防「催办 → 我马上补 → 再催」死循环）
  const nudgedOpen = Object.values(db.items).some((c) => c.cid === cid && c.status === "open" && c.remindedAt && c.remindedAt > lastDispatchAt);
  if (nudgedOpen) return;
  const id = `c${now.toString(36).slice(-4)}${crypto.randomBytes(1).toString("hex")}`;
  const item = {
    id,
    cid,
    taskId: activeTaskId,
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

/** 取出已过期、还没提醒过的承诺，并标记为已提醒 */
export function takeOverdue(now = Date.now()) {
  const due = [];
  updateJson(COMMITMENTS_FILE, { items: {} }, (db) => {
    for (const c of Object.values(db.items || {})) {
      if (isStale(c, now)) {
        c.status = "expired";
        c.expiredAt = now;
        continue;
      }
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
