#!/usr/bin/env node
/**
 * 微信 ClawBot V3.0 发送器（Markdown 排版净化 · 会话归属登记 · 未回追踪 · 引用溯源 · 验收回执 Gate）
 *
 * 用法：
 *   node /Users/eru/Desktop/agy工作站/.agents/clawbot/weixin-send.mjs "文本消息" [/绝对路径/文件1 ...] [--session=<cid>] [--title=<标题>]
 *        [--proof=file:/绝对路径] [--proof=url:地址] [--proof=mock:/项目目录] [--proof=research:/调研证据.md] [--cwd=/回执相对路径的基准目录]
 *        [--task=<msg编号>] [--commitment=<c编号>]
 *   node /Users/eru/Desktop/agy工作站/.agents/clawbot/weixin-send.mjs --tool-start "<工具名>"
 *   node /Users/eru/Desktop/agy工作站/.agents/clawbot/weixin-send.mjs --tool-end "<工具名>"
 *
 * 验收 Gate（脚本强制，不靠自觉；2026-11-07 Claude 加固后的格式）：
 *   - 正常聊天/确认/提问：原样发出，不加任何横幅
 *   - 交付汇报或核验异常：只在正文末尾加一行附注，如「— 🧾 已核验: a.mp4✓ | 🔎 已交 Claude 审查」「— ⚠️ 缺回执·自述」
 *   - 带附件时：先发纯正文（不带回执）→ 逐个传附件 → 全部送达才补发「🧾 验收回执」并落账；
 *     任一附件失败 → 发「⚠️ 附件上传失败，本次交付未完成」，记 attachment_failed，不核销承诺（退出码 4）
 *   - --task=<msg编号> 显式绑定任务，核销只找该任务的承诺；--commitment=<c编号> 精确核销
 *   - 正文声称 Claude/Codex 做过但查无真实调用 → 分句就地标「〔未核实·查无Claude调用〕」，不给绿勾
 *   - --engine= / AGY_ENGINE 已停用；系统身份只认 job-runner 的一次性票据 CLAWBOT_JOB_TICKET
 *   - 正文里手打的系统保留头（「Claude 审查通过 · 可拍板」等）一律剥成「窗口自述」
 *   - 未传项目 --session 的「完成」永不给绿勾；先发成功、再写 proofs.jsonl / 核销承诺 / 排审查
 *
 * 短消息硬卡控（2026-11-07）：正文 >600 字 / 含 Markdown 表格 / 列表 >8 条 / 正文照抄所附 .md
 *   → 窗口调用直接拒发（退出码 3），要求缩成 150~300 字「结论 + 下一步」；
 *   → 系统票据消息（job-runner）全文落盘 outbox/，微信只发摘要 + 路径。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sendMessageWeixin, sendMessageItemWeixin } from "./dist/src/messaging/send.js";
import { sendWeixinMediaFile } from "./dist/src/messaging/send-media.js";
import { sendTyping } from "./dist/src/api/api.js";
import { MessageItemType, TypingStatus } from "./dist/src/api/types.js";
import { CDN_BASE_URL } from "./dist/src/auth/accounts.js";
import { initializeQuoteStore } from "./dist/src/messaging/quote-store.js";
import { readJson, updateJson, appendJsonl, readJsonlTail } from "./state-io.mjs";
import { processOutgoing, holdForReview } from "./commitments.mjs";
import { verifyTicketSig } from "./ticket.mjs";
import { PEER_FILE, MSG_MAP_FILE, HUB_DIR, UUID_RE, JOBS_DIR, CLAWBOT_DIR, resolveMirror, loadRules, loadRouterState, updateRouterState, routerCidSet, routeKeyForCid, prunePending, clearProjectPending } from "./core.mjs";
import { runProof, checkAcceptance, detectCompletionClaim, detectResearchClaim, detectEngineClaims, markUnverifiedEngineClaims, hasEngineEvidence, PROOFS_FILE, DELEGATIONS_FILE } from "./proof.mjs";

const MSG_MAP_MAX_IDS = 3000;

/**
 * 针对微信 ClawBot 原生 CommonMark 渲染器的排版净化器：
 * 1. 移除破坏排版的长横线（━━━━ / ──── / ----），避免与下一行文字粘连
 * 2. 将非标准符号列表（▸ / • / ▪ / ➢）统一转为标准 Markdown 列表（- ），防止被压成同一行
 * 3. 为独立中文大标题（一、/ 二、/ 【...】）自动补齐加粗与空行
 * 4. 在代码块外，确保普通单换行末尾带两个空格（CommonMark 硬换行 `  \n`），彻底杜绝多行粘连成一段
 */
export function formatWeixinText(raw) {
  if (!raw) return "";
  let text = String(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "  ");

  const lines = text.split("\n");
  const out = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    // 1. 剔除纯装饰长横线（━━━ / ─── / ═══ / --- 等），换成空行分隔
    if (/^\s*[━─═—\-_*]{4,}\s*$/.test(line)) {
      if (out.length > 0 && out[out.length - 1].trim() !== "") {
        out.push("");
      }
      continue;
    }
    // 剔除行首粘连的长横线
    line = line.replace(/^\s*[━─═]{3,}\s*/, "");

    // 2. H5/H6 降级为 H4，H1-H4 确保前面有空行
    if (/^#{1,6}\s+/.test(line.trim())) {
      line = line.trim().replace(/^#{5,6}\s+/, "#### ");
      if (out.length > 0 && out[out.length - 1].trim() !== "") {
        out.push("");
      }
      out.push(line);
      out.push("");
      continue;
    }

    // 3. 独立中文章节标题（如 "一、..." / "1️⃣ 【...】" / "Part 0｜..."）自动加粗并前后空行
    if (/^\s*([一二三四五六七八九十]+、|[1-9]️⃣\s*【|Part\s*\d+\s*[|｜])/i.test(line) && !line.includes("**")) {
      if (out.length > 0 && out[out.length - 1].trim() !== "") {
        out.push("");
      }
      out.push(`**${line.trim()}**`);
      out.push("");
      continue;
    }

    // 4. 将 ▸ / • / ▪ / ➢ / ├ / └ 等非标符号转为标准 Markdown 无序列表 `- `
    if (/^\s*[▸•▪➢➤▪▫├└]\s+/.test(line)) {
      line = line.replace(/^\s*[▸•▪➢➤▪▫├└]\s+/, "- ");
    }

    // 5. 微信 iLink CommonMark 渲染器会把单换行 \n 合并到同一行（且把行尾双空格渲染成难看的宽空格）
    // 因此普通文本行之间必须用双换行（空行）分隔，才能在微信里真正独立成行！
    const trimmed = line.trim();
    if (trimmed === "") {
      if (out.length > 0 && out[out.length - 1] !== "") {
        out.push("");
      }
    } else {
      const isListItem = /^(-|\*|\d+\.)\s+/.test(trimmed);
      const prevLine = out.length > 0 ? out[out.length - 1] : "";
      const prevIsList = /^(-|\*|\d+\.)\s+/.test(prevLine);
      if (out.length > 0 && prevLine !== "" && !(isListItem && prevIsList)) {
        out.push("");
      }
      out.push(trimmed);
    }
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 微信短消息硬卡控（2026-11-07，eru 批评「发这么长一段干嘛」后加）：
 * 微信是手机聊天窗口，日常汇报 150~300 字，只说「结论 + 下一步 / 要拍板的事」。
 * 以下任一条命中即判「超规」：
 *   - 正文（去空白）> BREVITY_HARD 字
 *   - 含 Markdown 表格（|---|---| 分隔行，或连续 3 行以上 |…| 行）
 *   - 列表项 > BREVITY_MAX_LIST 条
 *   - 正文和所附 .md/.txt 附件大段重复（把报告 read_text() 塞进正文又附原文件）
 * 窗口（AGY/手动调用）超规 → 拒发、退出码 3，要求缩成 200 字人话；
 * 系统票据（job-runner 的 Claude/Codex 结果、审查）超规 → 全文落盘 outbox/，微信只发摘要 + 路径。
 */
export const BREVITY_SOFT = 300;
export const BREVITY_HARD = 600;
export const BREVITY_MAX_LIST = 8;
export const OUTBOX_DIR = path.join(CLAWBOT_DIR, "outbox");

const visibleLen = (s) => [...String(s || "").replace(/\s+/g, "")].length;

export function checkWeixinBrevity(rawText, files = []) {
  const text = String(rawText || "").replace(/\\n/g, "\n");
  const lines = text.split("\n");
  const reasons = [];
  const len = visibleLen(text);
  if (len > BREVITY_HARD) reasons.push(`正文 ${len} 字，超过 ${BREVITY_HARD} 字上限`);

  const hasTableSep = lines.some((l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(l));
  let pipeRun = 0, maxPipeRun = 0;
  for (const l of lines) {
    pipeRun = /^\s*\|.*\|\s*$/.test(l) ? pipeRun + 1 : 0;
    maxPipeRun = Math.max(maxPipeRun, pipeRun);
  }
  if (hasTableSep || maxPipeRun >= 3) reasons.push("含 Markdown 表格（微信里会变成一堆竖线）");

  const listCount = lines.filter((l) => /^\s*([-*+•▸]|\d+[.、)）])\s+/.test(l)).length;
  if (listCount > BREVITY_MAX_LIST) reasons.push(`列表 ${listCount} 条，超过 ${BREVITY_MAX_LIST} 条`);

  if (len > 200) {
    const probe = text.replace(/\s+/g, "");
    for (const f of files) {
      if (!/\.(md|markdown|txt)$/i.test(f)) continue;
      try {
        const body = fs.readFileSync(path.resolve(f), "utf8").replace(/\s+/g, "");
        // 抽正文中段 3 个 60 字片段，任意 2 个能在附件里找到 → 判为贴原文
        const picks = [0.2, 0.5, 0.8].map((r) => probe.slice(Math.floor(probe.length * r), Math.floor(probe.length * r) + 60)).filter((p) => p.length >= 40);
        if (picks.filter((p) => body.includes(p)).length >= 2) reasons.push(`正文是附件 ${path.basename(f)} 的原文复制，附件已经发了就别再贴`);
      } catch {}
    }
  }
  return { ok: reasons.length === 0, len, soft: len > BREVITY_SOFT, reasons };
}

/** 系统消息超规时：全文落盘，返回只含摘要 + 路径的短正文 */
export function spillToOutbox(rawText, label = "msg") {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const ts = new Date(Date.now() + 8 * 3600_000).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const file = path.join(OUTBOX_DIR, `${ts}_${String(label).replace(/[^\w一-龥-]/g, "").slice(0, 20) || "msg"}.md`);
  fs.writeFileSync(file, String(rawText || ""), "utf8");
  const plain = String(rawText || "")
    .replace(/\\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim() && !/^\s*\|/.test(l) && !/^\s*[-=━─]{3,}\s*$/.test(l) && !l.trim().startsWith("```"))
    .map((l) => l.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim())
    .join(" ");
  let head = [...plain].slice(0, 220).join("");
  const cut = Math.max(head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"), head.lastIndexOf("；"));
  if (cut > 80) head = head.slice(0, cut + 1);
  else if ([...plain].length > 220) head += "…";
  return { file, text: `${head}\n\n（全文 ${visibleLen(rawText)} 字太长，已存电脑：${file}）` };
}

/**
 * 会话归属：只认显式传入的 --session / --title（或环境变量）。
 * 不再按正文关键词猜（旧版会把提到「闲鱼」的消息挂错窗口）；没传就记为 unassigned，引用时交给路由判断。
 */
function inferSessionIdentity({ sessionCid, sessionTitle, engine }) {
  const st = loadRouterState();
  const rules = loadRules();
  const aliases = st.sessionAliases || {};
  let cid = sessionCid || "";
  let title = sessionTitle || "";

  if (cid && !cid.includes(":") && !UUID_RE.test(cid)) {
    const full = Object.keys(aliases).find((k) => k.startsWith(cid));
    if (full) cid = full;
  }
  if (!cid && title) {
    const full = Object.keys(aliases).find((k) => aliases[k] === title);
    if (full) cid = full;
  }
  if (!cid) return { cid: "unassigned", title: title || "未归属", engine: engine || "agy" };
  if (!title) {
    const rk = routeKeyForCid(cid, rules, st);
    title = aliases[cid] || (rk && rules.routes[rk]?.name) || cid.slice(0, 8);
  }
  if (routerCidSet(st).has(cid)) title = title || "AGY 主控会话";
  return { cid, title, engine: engine || (cid.startsWith("claude:") ? "claude" : "agy") };
}

function isSystemNotificationText(body) {
  const t = (body || "").trim();
  if (!t || t.length < 18) return true;
  if (/^(🦞|⚠️|🔒|🔓|🖥️|📂|⏰|❓)/.test(t)) return true;
  return false;
}

/** 截到一句话的结尾，不在半句话中间断开 */
function clipSentence(line, max = 90) {
  const t = String(line || "").replace(/^[-#▸•\s]+/, "").replace(/^[^\p{L}\p{N}「“]+/u, "").trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const cut = Math.max(...["。", "！", "？", "!", "?", "；", ";"].map((c) => head.lastIndexOf(c)));
  if (cut >= 12) return head.slice(0, cut + 1);
  const soft = Math.max(head.lastIndexOf("，"), head.lastIndexOf(","), head.lastIndexOf("："));
  return (soft >= 20 ? head.slice(0, soft) : head) + "…";
}

function extractPendingSummary(body) {
  const clean = (body || "")
    .replace(/\*\*/g, "")
    .replace(/  $/gm, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^[🟡🔎✅⚠️❌🧪🚫🔍]/u.test(l)); // 跳过闸门加的标签行
  if (clean.length === 0) return "有新进展汇报";
  const firstLine = clipSentence(clean[0]);
  const questionLine = [...clean].reverse().find((l) => /[?？]|请拍板|请审阅|请确认|你看|首选|方案/.test(l));
  if (questionLine && questionLine !== clean[0]) return `${firstLine}（待拍板：${clipSentence(questionLine, 60)}）`;
  return firstLine;
}

/** 「已转交 / 已转发给 xx 窗口」这类转交说明：不是要 eru 回复的汇报，不进待回 */
function isRelayNotice(body, filePath) {
  if (filePath) return false;
  const t = String(body || "").replace(/\*\*/g, "");
  return /(已|原样|帮你|帮您|这就|马上)?(转交|转发给|转给|投递给|派给|交给)[^。！!\n]{0,40}(窗|专窗|总控|会话|df666dc1|[0-9a-f]{8})/.test(t) || /^(已|原样)(转交|转发)/.test(t.trim());
}

export function recordPendingReply({ cid, title, body, filePath }) {
  if (!cid || cid === "unassigned" || isSystemNotificationText(body)) return;
  const relay = isRelayNotice(body, filePath);
  try {
    updateRouterState((st) => {
      if (routerCidSet(st).has(cid)) return st;
      prunePending(st);
      if (relay) return st; // 转交说明不是汇报：既不登记，也不动该项目原有待回
      // 同一项目任何窗口 / Claude 有新动作 → 旧待回作废，以最新这条为准
      clearProjectPending(st, cid, "superseded");
      const needsDecision = /[?？]|请拍板|请审阅|请确认|你看|觉得|可以吗|要不要|首选|候选/.test(body || "");
      st.pendingReplies = {
        ...(st.pendingReplies || {}),
        [cid]: {
          cid,
          title: title || st.sessionAliases?.[cid] || cid.slice(0, 8),
          sentAt: Date.now(),
          summary: extractPendingSummary(body),
          needsDecision,
          filePath: filePath || null,
          remindedCount: 0,
          lastRemindedAt: 0,
        },
      };
      return st;
    });
  } catch {}
}

export function recordMessageSessionMap({ messageId, serverMessageId, body, filePath, sessionCid, sessionTitle, engine, msgId = null, system = false }) {
  try {
    const resolved = inferSessionIdentity({ sessionCid, sessionTitle, engine });
    const entry = {
      cid: resolved.cid,
      title: resolved.title || "",
      engine: resolved.engine,
      messageId: messageId || null,
      serverMessageId: serverMessageId || null,
      bodySnippet: (body || "").slice(0, 300),
      filePath: filePath || null,
      msgId: msgId || null,
      ...(system ? { system: true } : {}), // 桥/看门狗/审查等系统消息：不算窗口自己的回复
      createdAt: Date.now(),
    };
    updateJson(MSG_MAP_FILE, { byId: {}, recent: [] }, (map) => {
      if (!map.byId) map.byId = {};
      if (!Array.isArray(map.recent)) map.recent = [];
      if (messageId) map.byId[String(messageId)] = entry;
      if (serverMessageId) map.byId[String(serverMessageId)] = entry;
      map.recent.unshift(entry);
      if (map.recent.length > 200) map.recent = map.recent.slice(0, 200);
      const ids = Object.keys(map.byId);
      if (ids.length > MSG_MAP_MAX_IDS) {
        ids
          .sort((a, b) => (map.byId[b]?.createdAt || 0) - (map.byId[a]?.createdAt || 0))
          .slice(MSG_MAP_MAX_IDS)
          .forEach((k) => delete map.byId[k]);
      }
      return map;
    });
    return resolved;
  } catch (err) {
    console.error(`⚠️ 会话映射登记失败（不影响发送）：${String(err?.message || err)}`);
    return null;
  }
}

/** 同一窗口同一批交付物是否已有审查在跑（纯读取，发送前用来决定附注文案） */
function reviewSignature(cid, evidence) {
  const stamp = (e) => {
    try {
      const x = fs.statSync(e);
      return `${e}@${x.size}:${Math.round(x.mtimeMs)}`;
    } catch {
      return e;
    }
  };
  return `${cid}|${[...evidence].map(stamp).sort().join(",")}`;
}

function reviewAlreadyPending(cid, evidence) {
  const prev = loadRouterState().reviews?.[cid];
  // 只有上一次审查还没结束、且交付物一字未变时才不重复排队；改过的版本（同路径重新渲染也算）一定重审
  return Boolean(prev?.pendingJob && prev?.lastSig === reviewSignature(cid, evidence) && Date.now() - (prev.lastAt || 0) < 30 * 60_000);
}

/** Claude 只读审查排队（独立进程，job-runner 执行）。只在微信发送成功之后调用。 */
function enqueueReview({ cid, routeKey, title, claimText, evidence }) {
  if (reviewAlreadyPending(cid, evidence)) return null;
  const st = loadRouterState();
  const sig = reviewSignature(cid, evidence);
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  const id = `r${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const rules = loadRules();
  const job = {
    id,
    engine: "review",
    createdAt: new Date().toISOString(),
    project: routeKey,
    cwd: rules.routes?.[routeKey]?.cwd || HUB_DIR,
    title: title || rules.routes?.[routeKey]?.name || routeKey,
    agyCid: cid,
    msgId: st.lastDispatch?.[cid]?.msgId || null,
    claimText: String(claimText || "").slice(0, 3000),
    evidence,
    acceptance: rules.routes?.[routeKey]?.acceptance || null,
  };
  const jobFile = path.join(JOBS_DIR, `${id}.json`);
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));
  updateRouterState((s) => {
    s.reviews = { ...(s.reviews || {}), [cid]: { ...(s.reviews?.[cid] || {}), lastSig: sig, lastAt: Date.now(), pendingJob: id } };
  });
  const logFd = fs.openSync(path.join(JOBS_DIR, `${id}.log`), "a");
  const child = spawn(process.execPath, [path.join(CLAWBOT_DIR, "job-runner.mjs"), jobFile], { detached: true, stdio: ["ignore", logFd, logFd], cwd: CLAWBOT_DIR });
  child.unref();
  fs.closeSync(logFd);
  return id;
}

/**
 * 内部身份核验（审计 P0-1/P0-2）：命令行 --engine= 与 AGY_ENGINE 不再被信任。
 * 只认 job-runner 写的一次性票据（CLAWBOT_JOB_TICKET），读到即删；
 *  - role=review：对应 jobs/<id>.json 必须是 engine=review 的审查任务 → 系统消息，跳过闸门
 *  - role=worker：delegations.jsonl 里必须有这个 jobId 的真实非 review 写任务记录 → engine=claude/codex
 */
export function consumeJobTicket(nonce) {
  if (!/^[0-9a-f]{32}$/.test(String(nonce || ""))) return null;
  const f = path.join(JOBS_DIR, "tickets", `${nonce}.json`);
  let t = null;
  try {
    t = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
  try {
    fs.rmSync(f, { force: true });
  } catch {}
  if (!t?.jobId || Date.now() - (t.createdAt || 0) > 2 * 3600_000) return null;
  // HMAC 签名（GPT 二审 P1-1）：密钥缺失/权限不对/签名不符/nonce 与文件名不一致 → 无票
  if (t.nonce !== nonce || !verifyTicketSig(t)) {
    console.error("⚠️ 票据签名校验失败，按普通窗口消息处理。");
    return null;
  }
  let job = null;
  try {
    job = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, `${t.jobId}.json`), "utf8"));
  } catch {
    return null;
  }
  if (t.role === "review") return job.engine === "review" ? { engine: "review", jobId: t.jobId } : null;
  if (!["claude", "codex"].includes(job.engine) || job.engine !== t.engine) return null;
  const real = readJsonlTail(DELEGATIONS_FILE, 800).some((d) => d.jobId === t.jobId && d.engine === job.engine && d.role !== "review" && d.mode !== "review" && d.status === "started");
  return real ? { engine: job.engine, jobId: t.jobId, project: job.project || null } : null;
}

/** 系统保留头：只有 job-runner / bridge 能发。普通窗口手打的一律剥掉并标「窗口自述」（审计 P0-2） */
const RESERVED_HEAD_RE = /[✅🔎↩️🛑🟡]️?\s*【[^】]{0,40}(Claude\s*审查|审查(通过|未通过|没过)|可拍板|验收通过|已退回重做|进度\s*·\s*未通过)[^】]{0,40}】/gu;
const RESERVED_LEAD_RE = /^\s*(🟣\s*\[Claude|🤖\s*\[Codex|🔁\s*\[系统|⏰\s*\[系统)/u;
export function stripReservedHeads(text) {
  let t = String(text || "");
  let hit = false;
  t = t.replace(RESERVED_HEAD_RE, () => {
    hit = true;
    return "（窗口自述）";
  });
  if (RESERVED_LEAD_RE.test(t)) {
    hit = true;
    t = t.replace(RESERVED_LEAD_RE, (m) => `（窗口自述）${m.replace(/^\s*[🟣🤖🔁⏰]️?\s*/u, "")}`);
  }
  return { text: t, stripped: hit };
}

/**
 * 验收 Gate（纯计算，不落账、不排审查——这些都等微信发送成功后再做）。返回：
 *   verdict: "accepted" | "reviewing" | "rejected" | "none"
 *   note:    单行紧凑附注（放正文末尾；正常聊天为空）
 *   tags:    短标签数组（写 proofs.jsonl 用）
 */
async function applyProofGate({ text, proofs, files, sessionCid, cwd, engine = "", project = null }) {
  const empty = { note: "", tags: [], receipts: [], verdict: "none", results: [], claim: false, rk: null, route: null, acc: null };
  if (engine === "review") return empty;
  if (isSystemNotificationText(text) && proofs.length === 0 && files.length === 0 && !detectCompletionClaim(text)) return empty;
  const rules = loadRules();
  let rk = sessionCid ? routeKeyForCid(sessionCid, rules) || (sessionCid.startsWith("claude:") ? sessionCid.slice(7) : null) : null;
  if (!rk && project && rules.routes?.[project]) rk = project; // 票据核验过的 Claude/Codex 后台任务按任务登记的项目判
  if (rk && !rules.routes?.[rk]) rk = null;
  const route = rk ? rules.routes?.[rk] : null;
  const routeCwd = route?.cwd || null;
  const acceptance = route?.acceptance || null;
  const execCwd = cwd || routeCwd || process.cwd();
  const claim = detectCompletionClaim(text);

  const specs = [...proofs];
  for (const f of files) specs.push(`file:${path.resolve(f)}`);
  // 调研/证据类文档（不管是 --proof=file: 还是当附件发）一律加跑 research 核验，防止拿普通附件绕过调研检查
  for (const sp of [...specs]) {
    const m = sp.match(/^file:(.+\.(md|txt|markdown))$/i);
    if (m && /research|evidence|调研|证据|对标|拆解/i.test(path.basename(m[1]))) specs.push(`research:${m[1]}`);
  }
  const wantMock = routeCwd && !specs.some((s) => s.startsWith("mock:")) && (specs.some((s) => s.startsWith("url:")) || (claim && acceptance?.mockScan));
  if (wantMock) specs.push(`mock:${routeCwd}`);
  for (let i = specs.length - 1; i >= 0; i--) if (specs.indexOf(specs[i]) !== i) specs.splice(i, 1); // 去重

  const results = [];
  for (const s of specs) results.push(await runProof(s, { cwd: execCwd }));

  const tags = [];
  let verdict = "none";
  const acc = claim ? checkAcceptance(acceptance, results, text) : { defined: false };
  if (claim && !rk) {
    // 未传有效项目 --session（或用总控 cid）：最多给警告，永远不给绿勾（审计 P0-4）
    tags.push("⚠️ 未归属项目会话·不判验收");
  } else if (claim && acc.defined) {
    if (!acc.satisfied) {
      verdict = "rejected";
      tags.push(`⚠️ 未过验收·只算进度（缺：${acc.missing.join("；")}）`);
    } else if (acceptance.review === "claude" && engine !== "claude" && engine !== "codex") {
      verdict = "reviewing";
      tags.push(reviewAlreadyPending(sessionCid, acc.evidence) ? "🔎 这批正在 Claude 审查" : "🔎 脚本已核验·已交 Claude 审查");
    } else {
      verdict = "accepted";
      tags.push("✅ 已核验");
    }
  } else if (claim) {
    const hasPassingProof = results.some((r) => r.level === "ok");
    if (results.length === 0) tags.push("⚠️ 缺回执·自述");
    else if (!hasPassingProof) tags.push("⚠️ 回执未过·自述");
    else {
      verdict = "accepted";
      tags.push("✅ 已核验");
    }
  }
  if (detectResearchClaim(text) && !specs.some((p) => p.startsWith("research:"))) tags.push("🔍 调研无证据");
  if (verdict !== "rejected" && results.some((r) => r.level === "fail")) tags.push("❌ 回执核验失败");
  if (verdict !== "rejected" && results.some((r) => r.mock)) tags.push("🧪 Mock 原型");
  // 身份声明（P1-1）：持有效签名票据的同引擎后台任务免查；其余一律查近 6 小时真实调用，查不到就就地打标改写
  const impostor = [];
  for (const eng of detectEngineClaims(text)) {
    if (engine && engine === eng) continue;
    const ev = await hasEngineEvidence(eng, 6, routeCwd);
    if (!ev.ok) {
      impostor.push(eng);
      tags.push(`🚫 查无 ${eng === "claude" ? "Claude" : "Codex"} 调用·疑似冒充`);
    }
  }
  const rewrittenText = impostor.length ? markUnverifiedEngineClaims(text, impostor) : text;

  const icon = { ok: "✓", warn: "⚠", fail: "✗" };
  const short = (r) => `${r.kind === "file" || r.kind === "research" ? path.basename(r.target) : r.kind === "mock" ? "mock扫描" : r.target.slice(0, 40)}${icon[r.level] || ""}`;
  const receipts = results.map((r) => `${icon[r.level] || "•"} ${r.kind} · ${r.detail}`);
  // 只有交付汇报或核验异常才出附注；普通聊天/附图不加任何东西
  const anomaly = tags.some((t) => !t.startsWith("✅") && !t.startsWith("🔎"));
  let note = "";
  if (claim || anomaly) {
    const ok = results.filter((r) => r.level === "ok");
    const head = verdict === "accepted" || verdict === "reviewing" ? `🧾 已核验: ${ok.map(short).join(" ") || "—"}` : results.length ? `🧾 ${results.map(short).join(" ")}` : "";
    const rest = tags.filter((t) => t !== "✅ 已核验");
    note = `— ${[head, ...rest].filter(Boolean).join(" | ")}`;
    if (note === "— ") note = "";
  }
  // 冒充身份的交付不算通过：不发绿勾、不核销承诺、不排审查
  if (impostor.length && (verdict === "accepted" || verdict === "reviewing")) {
    verdict = "impostor";
    note = note.replace(/^— 🧾 已核验:/, "— 🧾");
  }
  return { note, tags, receipts, verdict, results, claim, rk, route, acc, text: rewrittenText, impostor };
}

/**
 * 发送成功之后才落账：proofs.jsonl、承诺核销/登记、审查排队（审计 P0-5 / P1-3）
 * delivery: "sent" 全部送达 | "failed" 正文都没发出去 | "attachment_failed" 正文发了、附件没全到（GPT 二审 P1-3）
 * 只有 "sent" 才核销 / 登记承诺 / 排审查；其余只记一条不通过的账。
 */
function commitAfterSend({ gate, sessionCid, sessionTitle, rawText, engine, delivery, taskId = null, commitmentId = null, messageId = null, failedFiles = [] }) {
  if (engine === "review") return;
  const sent = delivery === "sent";
  if (gate.claim || gate.results.length || gate.tags.length || !sent) {
    appendJsonl(PROOFS_FILE, {
      session: sessionCid || "unassigned",
      routeKey: gate.rk,
      claim: gate.claim,
      verdict: sent ? gate.verdict : delivery,
      tags: sent ? gate.tags : [...gate.tags, delivery === "attachment_failed" ? "⚠️ 附件上传失败·交付未完成" : "❌ 微信发送失败"],
      sent,
      delivery,
      ...(failedFiles.length ? { failedFiles } : {}),
      ...(taskId ? { taskId } : {}),
      ...(messageId ? { messageId } : {}),
      proofs: gate.results.map(({ kind, target, level, detail }) => ({ kind, target, level, detail })),
      textHead: String(rawText || "").slice(0, 80),
    });
  }
  if (!sent) return;
  if (gate.verdict === "reviewing") {
    enqueueReview({ cid: sessionCid, routeKey: gate.rk, title: gate.route?.name, claimText: rawText, evidence: gate.acc.evidence });
    try {
      holdForReview(sessionCid, 20); // 审查期间不算「答应了没交」
    } catch {}
  }
  try {
    // 承诺追踪：只有「验收通过」才算兑现；调研类承诺单独认 research 回执；冒充身份的一律不兑现
    const fulfilling = gate.verdict === "accepted" ? gate.results : gate.verdict === "impostor" ? [] : gate.results.filter((r) => r.kind === "research");
    const cm = processOutgoing({ cid: sessionCid, title: sessionTitle, text: rawText || "", results: fulfilling, taskId, commitmentId, messageId, dryRun: false });
    if (cm.fulfilled.length) console.log(`✔️ 核销承诺 ${cm.fulfilled.map((c) => c.id).join("、")}`);
    if (cm.registered.length) console.log(`📝 登记承诺 ${cm.registered.map((c) => `${c.id}(${c.dueMin}分钟)`).join("、")}`);
    if (cm.merged?.length) console.log(`🔁 合并进已有承诺 ${cm.merged.map((c) => c.id).join("、")}（同窗最多 1 条活跃）`);
  } catch (e) {
    console.error(`承诺登记失败（不影响发送）：${String(e?.message || e)}`);
  }
}

/**
 * 测试专用假发送通道：只有脚本**不在**生产目录（隔离测试副本）时才生效，生产目录里设了也无效，
 * 防止窗口用环境变量「假装发了微信」来核销承诺。
 */
const PROD_CLAWBOT_DIR = path.join(HUB_DIR, ".agents", "clawbot");
function fakeTransport() {
  const f = process.env.CLAWBOT_FAKE_TRANSPORT;
  if (!f) return null;
  let here = CLAWBOT_DIR;
  let prod = PROD_CLAWBOT_DIR;
  try {
    here = fs.realpathSync(CLAWBOT_DIR);
    prod = fs.realpathSync(PROD_CLAWBOT_DIR);
  } catch {}
  if (here === prod) {
    console.error("⚠️ CLAWBOT_FAKE_TRANSPORT 在生产目录无效，已忽略。");
    return null;
  }
  const log = (o) => fs.appendFileSync(f, JSON.stringify({ ts: Date.now(), ...o }) + "\n");
  let n = 0;
  return {
    text: async ({ text }) => {
      const messageId = `fake-t${++n}`;
      log({ type: "text", messageId, text });
      return { messageId };
    },
    media: async ({ filePath }) => {
      const fail = String(process.env.CLAWBOT_FAKE_FAIL_MEDIA || "");
      if (fail && path.basename(filePath) === fail) {
        log({ type: "media_fail", file: path.basename(filePath) });
        throw new Error(`fake upload failure: ${path.basename(filePath)}`);
      }
      const messageId = `fake-m${++n}`;
      log({ type: "media", messageId, file: path.basename(filePath) });
      return { messageId };
    },
  };
}

async function cancelTypingIfActive(peer) {
  if (!peer?.typingTicket) return;
  try {
    await sendTyping({
      baseUrl: peer.baseUrl,
      token: peer.token,
      body: {
        ilink_user_id: peer.fromUserId,
        typing_ticket: peer.typingTicket,
        status: TypingStatus.CANCEL,
      },
    });
  } catch {}
}

async function main() {
  if (!fs.existsSync(PEER_FILE)) {
    console.error("尚未收到过微信消息（latest_peer.json 不存在）。请先在手机微信 ClawBot 发一条消息激活会话上下文！");
    process.exit(1);
  }
  const peer = JSON.parse(fs.readFileSync(PEER_FILE, "utf-8"));
  await initializeQuoteStore({}, peer.accountId).catch(() => null);

  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs.includes("--help") || rawArgs.includes("-h")) {
    console.log(
      "用法:\n  node weixin-send.mjs \"文本内容\" [文件...] --session=<cid> [--title=<标题>] [--proof=file:/绝对路径|url:地址|mock:/目录 ...] [--cwd=目录] [--task=<msg编号>] [--commitment=<c编号>]\n  node weixin-send.mjs --tool-start \"<工具名>\"\n  node weixin-send.mjs --tool-end \"<工具名>\""
    );
    process.exit(0);
  }
  let sessionCid = process.env.AGY_SESSION_ID || "";
  let sessionTitle = process.env.AGY_SESSION_TITLE || "";
  // --engine= / AGY_ENGINE 已废弃：只认 job-runner 的一次性票据
  const ticket = process.env.CLAWBOT_JOB_TICKET ? consumeJobTicket(process.env.CLAWBOT_JOB_TICKET) : null;
  const engine = ticket?.engine || "";
  let cwdFlag = "";
  let taskFlag = "";
  let commitmentFlag = "";
  let toolStart = "";
  let toolEnd = "";
  const proofs = [];
  let dryRun = process.env.CLAWBOT_DRY_RUN === "1";
  let engineFlagIgnored = Boolean(process.env.AGY_ENGINE);

  const positional = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a.startsWith("--session=")) sessionCid = a.slice("--session=".length);
    else if (a.startsWith("--title=")) sessionTitle = a.slice("--title=".length);
    else if (a.startsWith("--engine=")) engineFlagIgnored = true;
    else if (a.startsWith("--cwd=")) cwdFlag = a.slice("--cwd=".length);
    else if (a.startsWith("--proof=")) proofs.push(a.slice("--proof=".length));
    else if (a.startsWith("--task=")) taskFlag = a.slice("--task=".length).trim();
    else if (a.startsWith("--commitment=")) commitmentFlag = a.slice("--commitment=".length).trim();
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--tool-start" && rawArgs[i + 1]) toolStart = rawArgs[++i];
    else if (a === "--tool-end" && rawArgs[i + 1]) toolEnd = rawArgs[++i];
    else positional.push(a);
  }
  if (engineFlagIgnored) console.error("⚠️ --engine= / AGY_ENGINE 已停用，按普通窗口消息处理。");

  const opts = {
    baseUrl: peer.baseUrl,
    token: peer.token,
    contextToken: peer.contextToken,
    accountId: peer.accountId,
  };

  // Native WeChat Tool Call Progress Item
  if ((toolStart || toolEnd) && dryRun) {
    console.log(`[dry-run] 工具进度帧 ${toolStart ? "start" : "end"}: ${toolStart || toolEnd}`);
    return;
  }
  if (toolStart || toolEnd) {
    const isStart = Boolean(toolStart);
    const toolName = toolStart || toolEnd;
    const now = Date.now();
    const item = isStart
      ? {
          type: MessageItemType.TOOL_CALL_START,
          create_time_ms: now,
          is_completed: false,
          tool_call_start_item: { tool_name: toolName, tool_call_id: `agy-tool-${now}` },
        }
      : {
          type: MessageItemType.TOOL_CALL_RESULT,
          create_time_ms: now,
          is_completed: true,
          tool_call_result_item: { tool_name: toolName, tool_call_id: `agy-tool-${now}`, status: "completed" },
        };
    const res = await sendMessageItemWeixin({
      to: peer.fromUserId,
      item,
      opts,
      label: isStart ? "sendToolCallStartMessage" : "sendToolCallResultMessage",
    });
    console.log(`✅ 已发送微信原生工具进度帧 (${toolName}): messageId=${res.messageId}`);
    return;
  }

  // 窗口传旧 ID（已被接力窗口取代）也合法：统一换成现役 ID，承诺/审查/看门狗才对得上
  if (UUID_RE.test(sessionCid)) sessionCid = resolveMirror(sessionCid);
  const [rawInput, ...files] = positional;
  // 非系统消息一律剥掉手打的系统保留头（「Claude 审查通过 · 可拍板」等）
  let { text: rawText, stripped } = engine === "review" ? { text: rawInput || "", stripped: false } : stripReservedHeads(rawInput || "");
  if (stripped) console.error("⚠️ 正文里有系统保留头（审查结论/验收标签），已改成「窗口自述」。");

  // 微信短消息硬卡控：窗口超规直接拒发；系统票据消息自动落盘只发摘要
  const brev = checkWeixinBrevity(rawText, files);
  if (!brev.ok) {
    if (ticket) {
      const spilled = spillToOutbox(rawText, ticket.engine || "job");
      console.error(`✂️ 系统消息超规（${brev.reasons.join("；")}），全文已落盘 ${spilled.file}，微信只发摘要。`);
      rawText = spilled.text;
    } else {
      console.error(
        [
          `❌ 拒发：微信是手机聊天窗口，这条不像人话。`,
          ...brev.reasons.map((r) => `   - ${r}`),
          `请改成 150~300 字（最多 500 字）的人话：一句结论 + 下一步 / 要 eru 拍板的事。`,
          `不要贴整篇 .md、不要表格、不要长列表；详细内容写进文件留在电脑上，eru 要看再把文件作为附件发（正文只写一句说明）。`,
        ].join("\n")
      );
      process.exit(3);
    }
  } else if (brev.soft) {
    console.error(`⚠️ 正文 ${brev.len} 字，日常汇报建议 300 字以内（本次照发）。`);
  }
  if (!sessionCid && !isSystemNotificationText(rawText)) {
    console.error("⚠️ 未传 --session=<会话ID>：这条消息记为「未归属」，声称完成也不会给绿勾。");
  }
  const gate = await applyProofGate({ text: rawText, proofs, files, sessionCid, cwd: cwdFlag, engine, project: ticket?.project || null });
  if (gate.impostor?.length) {
    rawText = gate.text;
    console.error(`🚫 正文声称 ${gate.impostor.join("/")} 做过，但查不到真实调用记录：已就地标「未核实」，不给绿勾、不核销承诺。`);
  }
  const self = inferSessionIdentity({ sessionCid, sessionTitle, engine });
  const projLabel = (sessionTitle || gate.route?.name || self.title || "").trim();
  if (
    rawText &&
    projLabel &&
    projLabel !== "未归属" &&
    projLabel !== "AGY 主控会话" &&
    !isSystemNotificationText(rawText) &&
    !rawText.trim().startsWith("【") &&
    !rawText.trim().startsWith(`[${projLabel}`) &&
    !rawText.includes(`【${projLabel}】`)
  ) {
    rawText = `【${projLabel}】${rawText.trim()}`;
  }
  // 极简格式：正文原样，只有交付/异常时末尾带一行附注；不再有顶部警告墙和多行回执块
  const text = formatWeixinText(gate.note ? `${rawText}\n\n${gate.note}` : rawText);

  if (!text && files.length === 0) {
    console.error("用法: node weixin-send.mjs <文本内容> [文件路径1 文件路径2 ...] [--session=<cid>]");
    process.exit(1);
  }
  if (dryRun) {
    console.log(`[dry-run] 不发送、不登记。session=${sessionCid || "unassigned"} engine=${engine || "agy"} verdict=${gate.verdict} files=${files.length}\n----- 将发出的微信正文 -----\n${text}\n----------------------------`);
    if (gate.receipts.length) console.log(`🧾 验收回执：\n${gate.receipts.join("\n")}`);
    return;
  }

  // 60 秒去重：按「会话 + 正文」判重，不同窗口说同一句话不会被吞（审计 P1-3）
  if (text && files.length === 0) {
    try {
      const map = readJson(MSG_MAP_FILE, { recent: [] });
      const norm = (x) => String(x || "").replace(/\s+/g, "").slice(0, 80);
      const now = Date.now();
      const dup = (map.recent || [])
        .slice(0, 12)
        .find((r) => now - (r.createdAt || 0) < 60000 && r.cid === self.cid && !r.msgId && r.bodySnippet && norm(r.bodySnippet) === norm(text));
      if (dup) {
        console.log(`⚠️ 同一会话 60 秒内已发过完全相同的正文，本次不重复发送（未落账）`);
        await cancelTypingIfActive(peer);
        return;
      }
    } catch {}
  }

  // 发送顺序（GPT 二审 P1-3）：
  //   无附件：正文 + 附注一条发完 → 落账
  //   有附件：先发纯正文（不带 🧾 回执）→ 逐个传附件 → 全部成功才补发「🧾 验收回执」并落账；
  //           任一附件失败：立刻发「⚠️ 附件上传失败，本次交付未完成」，只记一条不通过的账，绝不核销
  const fake = fakeTransport();
  const sendText = (t) => (fake ? fake.text({ text: t }) : sendMessageWeixin({ to: peer.fromUserId, text: t, opts }));
  const sendMedia = (filePath) => (fake ? fake.media({ filePath }) : sendWeixinMediaFile({ filePath, to: peer.fromUserId, text: "", opts, cdnBaseUrl: peer.cdnBaseUrl || CDN_BASE_URL }));
  const bodyOnly = files.length && gate.note ? formatWeixinText(rawText) : text;
  const sys = engine === "review";
  let identity = null;
  let lastMessageId = null;
  const delivered = [];
  try {
    if (bodyOnly) {
      const res = await sendText(bodyOnly);
      lastMessageId = res.messageId || lastMessageId;
      identity = recordMessageSessionMap({ messageId: res.messageId, serverMessageId: res.serverMessageId, body: bodyOnly, sessionCid, sessionTitle, engine, filePath: files[0] ? path.resolve(files[0]) : null, system: sys });
      console.log(`✅ 已发送微信正文: messageId=${res.messageId}${res.serverMessageId ? ` svrId=${res.serverMessageId}` : ""}`);
    }
  } catch (err) {
    commitAfterSend({ gate, sessionCid, sessionTitle, rawText, engine, delivery: "failed", taskId: taskFlag || null });
    await cancelTypingIfActive(peer);
    throw err;
  }
  let failed = null;
  for (const f of files) {
    const filePath = path.resolve(f);
    try {
      const res = await sendMedia(filePath);
      lastMessageId = res.messageId || lastMessageId;
      delivered.push(path.basename(filePath));
      identity =
        recordMessageSessionMap({ messageId: res.messageId, serverMessageId: res.serverMessageId, body: `[文件: ${path.basename(filePath)}] ${bodyOnly.slice(0, 200)}`, filePath, sessionCid, sessionTitle, engine, system: sys }) || identity;
      console.log(`✅ 已发送附件 ${path.basename(filePath)}: messageId=${res.messageId}${res.serverMessageId ? ` svrId=${res.serverMessageId}` : ""}`);
    } catch (err) {
      failed = { file: path.basename(filePath), error: String(err?.message || err).slice(0, 120) };
      break;
    }
  }
  if (failed) {
    const left = files.slice(delivered.length).map((f) => path.basename(f));
    const alert = formatWeixinText(
      `⚠️ 附件上传失败，本次交付未完成（${delivered.length}/${files.length} 个已送达；失败：${failed.file}${left.length > 1 ? `，未发：${left.slice(1).join("、")}` : ""}）。上面那条说明不算交付，回执作废。`
    );
    try {
      await sendText(alert);
    } catch (e) {
      console.error(`告警也没发出去：${String(e?.message || e)}`);
    }
    commitAfterSend({ gate, sessionCid, sessionTitle, rawText, engine, delivery: "attachment_failed", taskId: taskFlag || null, failedFiles: left });
    await cancelTypingIfActive(peer);
    console.error(`❌ 附件 ${failed.file} 上传失败：${failed.error}。已告警 eru，未核销任何承诺。`);
    process.exit(4);
  }
  if (files.length && gate.note) {
    // 附件全部送达，才补发验收回执
    try {
      const res = await sendText(formatWeixinText(gate.note.replace(/^—\s*/, "")));
      lastMessageId = res.messageId || lastMessageId;
      recordMessageSessionMap({ messageId: res.messageId, serverMessageId: res.serverMessageId, body: gate.note, sessionCid, sessionTitle, engine, system: true });
    } catch (err) {
      commitAfterSend({ gate, sessionCid, sessionTitle, rawText, engine, delivery: "attachment_failed", taskId: taskFlag || null });
      await cancelTypingIfActive(peer);
      throw err;
    }
  }
  await cancelTypingIfActive(peer);
  commitAfterSend({ gate, sessionCid, sessionTitle, rawText, engine, delivery: "sent", taskId: taskFlag || null, commitmentId: commitmentFlag || null, messageId: lastMessageId });
  if (identity && engine !== "review") {
    recordPendingReply({ cid: identity.cid, title: identity.title, body: rawText || "", filePath: files[0] || null });
  }
  if (gate.receipts.length) console.log(`🧾 验收回执：\n${gate.receipts.join("\n")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error("发送微信消息失败:", err);
    process.exit(1);
  });
}
