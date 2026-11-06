#!/usr/bin/env node
/**
 * 微信 ClawBot V3.0 发送器（Markdown 排版净化 · 会话归属登记 · 未回追踪 · 引用溯源 · 验收回执 Gate）
 *
 * 用法：
 *   node /Users/eru/Desktop/agy工作站/.agents/clawbot/weixin-send.mjs "文本消息" [/绝对路径/文件1 ...] [--session=<cid>] [--title=<标题>]
 *        [--proof=file:/绝对路径] [--proof=url:地址] [--proof=mock:/项目目录] [--proof=research:/调研证据.md] [--cwd=/回执相对路径的基准目录]
 *   node /Users/eru/Desktop/agy工作站/.agents/clawbot/weixin-send.mjs --tool-start "<工具名>"
 *   node /Users/eru/Desktop/agy工作站/.agents/clawbot/weixin-send.mjs --tool-end "<工具名>"
 *
 * 验收 Gate（脚本强制，不靠自觉）：
 *   - 正文声称「完成/上线/跑通/已修复…」却没有任何回执 → 开头强制加【未附验收回执 · Agent 自述】
 *   - 正文声称「Claude/Codex 做了…」但 ledger 与引擎原生会话记录里近 6 小时都查不到调用 → 强制加【疑似冒充】
 *   - 回执发现 mock/fake/TODO 特征 → 强制加【原型/Mock，未接真实后端】
 *   - 正文声称「调研/Deep Research/对标过」却没附 research: 证据文件 → 强制加【调研未经核验】
 *   - 随消息附带的文件自动做 file 回执
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
import { readJson, updateJson, appendJsonl } from "./state-io.mjs";
import { processOutgoing, holdForReview } from "./commitments.mjs";
import { PEER_FILE, MSG_MAP_FILE, HUB_DIR, UUID_RE, JOBS_DIR, CLAWBOT_DIR, resolveMirror, loadRules, loadRouterState, updateRouterState, routerCidSet, routeKeyForCid } from "./core.mjs";
import { runProof, checkAcceptance, detectCompletionClaim, detectResearchClaim, detectEngineClaims, hasEngineEvidence, PROOFS_FILE } from "./proof.mjs";

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

export function recordPendingReply({ cid, title, body, filePath }) {
  if (!cid || cid === "unassigned" || isSystemNotificationText(body)) return;
  try {
    updateRouterState((st) => {
      if (routerCidSet(st).has(cid)) return st;
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

export function recordMessageSessionMap({ messageId, serverMessageId, body, filePath, sessionCid, sessionTitle, engine, msgId = null }) {
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

/** Claude 只读审查排队（独立进程，job-runner 执行；同一窗口同一批交付物 15 分钟内不重复排） */
function enqueueReview({ cid, routeKey, title, claimText, evidence }) {
  const st = loadRouterState();
  const stamp = (e) => {
    try {
      const x = fs.statSync(e);
      return `${e}@${x.size}:${Math.round(x.mtimeMs)}`;
    } catch {
      return e;
    }
  };
  const sig = `${cid}|${[...evidence].map(stamp).sort().join(",")}`;
  const prev = st.reviews?.[cid];
  // 只有上一次审查还没结束、且交付物一字未变时才不重复排队；改过的版本（同路径重新渲染也算）一定重审
  if (prev?.pendingJob && prev?.lastSig === sig && Date.now() - (prev.lastAt || 0) < 30 * 60_000) return null;
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
 * 验收 Gate：返回 { text, receipts, verdict, results }
 * verdict: "accepted"（脚本验收通过，无需审查）| "reviewing"（已交 Claude 审查）| "rejected"（声称完成但不够格）| "none"
 * 项目在 rules.json 里有 acceptance 模板时，「完成」只能由这里判定：不够格的一律降级成「进度」。
 */
async function applyProofGate({ text, proofs, files, sessionCid, cwd, engine = "", dryRun = false }) {
  if (engine === "review") return { text, receipts: [], verdict: "none", results: [] };
  if (isSystemNotificationText(text) && proofs.length === 0 && files.length === 0 && !detectCompletionClaim(text)) return { text, receipts: [], verdict: "none", results: [] };
  const rules = loadRules();
  const rk = sessionCid ? routeKeyForCid(sessionCid, rules) || (sessionCid.startsWith("claude:") ? sessionCid.slice(7) : null) : null;
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
  if (claim && acc.defined) {
    if (!acc.satisfied) {
      verdict = "rejected";
      tags.push(`🟡【进度 · 未通过验收，不算完成】缺：${acc.missing.join("；")}`);
    } else if (acceptance.review === "claude" && engine !== "claude" && engine !== "codex") {
      verdict = "reviewing";
      tags.push("🔎【脚本验收已过 · 已交 Claude 审查，结论稍后单独发】");
    } else {
      verdict = "accepted";
      tags.push("✅【验收通过（脚本核验）】");
    }
  } else if (claim) {
    const hasPassingProof = results.some((r) => r.level === "ok");
    if (results.length === 0) tags.push("⚠️【未附验收回执 · Agent 自述，未经脚本核验】");
    else if (!hasPassingProof) tags.push("⚠️【回执都没有通过核验，「完成」仍是 Agent 自述】");
    else verdict = "accepted";
  }
  if (detectResearchClaim(text) && !specs.some((p) => p.startsWith("research:"))) {
    tags.push("🔍【声称做过调研，但没附调研证据（--proof=research:/证据.md），未经核验】");
  }
  if (verdict !== "rejected" && results.some((r) => r.level === "fail")) tags.push("❌【回执核验未通过】");
  if (verdict !== "rejected" && results.some((r) => r.mock)) tags.push("🧪【原型/Mock，未接真实后端】");
  for (const eng of detectEngineClaims(text)) {
    const ev = await hasEngineEvidence(eng, 6, routeCwd);
    if (!ev.ok) tags.push(`🚫【近 6 小时查不到 ${eng === "claude" ? "Claude CLI" : "Codex"} 调用记录${ev.scope}，疑似冒充】`);
  }

  if (verdict === "reviewing" && !dryRun) {
    const jobId = enqueueReview({ cid: sessionCid, routeKey: rk, title: route?.name, claimText: text, evidence: acc.evidence });
    if (!jobId) tags[tags.indexOf("🔎【脚本验收已过 · 已交 Claude 审查，结论稍后单独发】")] = "🔎【这批交付物正在 Claude 审查中，不重复排队】";
    try {
      holdForReview(sessionCid, 20); // 审查期间不算「答应了没交」
    } catch {}
  }

  const icon = { ok: "✅", warn: "⚠️", fail: "❌" };
  const receipts = results.map((r) => `${icon[r.level] || "•"} ${r.kind} · ${r.detail}`);
  if (!dryRun && (claim || results.length || tags.length)) {
    appendJsonl(PROOFS_FILE, {
      session: sessionCid || "unassigned",
      routeKey: rk,
      claim,
      verdict,
      tags,
      proofs: results.map(({ kind, target, level, detail }) => ({ kind, target, level, detail })),
      textHead: String(text || "").slice(0, 80),
    });
  }
  const tagged = tags.length ? `${tags.join("\n")}\n\n${text}` : text;
  return { text: tagged, receipts, verdict, results };
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
      "用法:\n  node weixin-send.mjs \"文本内容\" [文件...] --session=<cid> [--title=<标题>] [--proof=file:/绝对路径|url:地址|mock:/目录 ...] [--cwd=目录]\n  node weixin-send.mjs --tool-start \"<工具名>\"\n  node weixin-send.mjs --tool-end \"<工具名>\""
    );
    process.exit(0);
  }
  let sessionCid = process.env.AGY_SESSION_ID || "";
  let sessionTitle = process.env.AGY_SESSION_TITLE || "";
  let engine = process.env.AGY_ENGINE || "";
  let cwdFlag = "";
  let toolStart = "";
  let toolEnd = "";
  const proofs = [];
  let dryRun = process.env.CLAWBOT_DRY_RUN === "1";

  const positional = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a.startsWith("--session=")) sessionCid = a.slice("--session=".length);
    else if (a.startsWith("--title=")) sessionTitle = a.slice("--title=".length);
    else if (a.startsWith("--engine=")) engine = a.slice("--engine=".length);
    else if (a.startsWith("--cwd=")) cwdFlag = a.slice("--cwd=".length);
    else if (a.startsWith("--proof=")) proofs.push(a.slice("--proof=".length));
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--tool-start" && rawArgs[i + 1]) toolStart = rawArgs[++i];
    else if (a === "--tool-end" && rawArgs[i + 1]) toolEnd = rawArgs[++i];
    else positional.push(a);
  }

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
  const [rawText, ...files] = positional;
  if (!sessionCid && !isSystemNotificationText(rawText)) {
    console.error("⚠️ 未传 --session=<会话ID>：这条消息将记为「未归属」，eru 引用它回复时会交给总控重新判断。");
  }
  const gate = await applyProofGate({ text: rawText || "", proofs, files, sessionCid, cwd: cwdFlag, engine, dryRun });
  // 承诺追踪：只有「验收通过」才算兑现；调研类承诺单独认 research 回执
  try {
    const fulfilling = gate.verdict === "accepted" ? gate.results : gate.results.filter((r) => r.kind === "research");
    const cm = engine === "review" ? { registered: [] } : processOutgoing({ cid: sessionCid, title: sessionTitle, text: rawText || "", results: fulfilling, dryRun });
    if (cm.registered.length) console.log(`📝 登记承诺 ${cm.registered.map((c) => `${c.id}(${c.dueMin}分钟)`).join("、")}`);
  } catch (e) {
    console.error(`承诺登记失败（不影响发送）：${String(e?.message || e)}`);
  }
  const bodyWithReceipts = gate.receipts.length
    ? `${gate.text}\n\n—— 脚本验收回执 ——\n${gate.receipts.join("\n")}`
    : gate.text;
  const text = formatWeixinText(bodyWithReceipts);

  if (!text && files.length === 0) {
    console.error("用法: node weixin-send.mjs <文本内容> [文件路径1 文件路径2 ...] [--session=<cid>]");
    process.exit(1);
  }
  if (dryRun) {
    console.log(`[dry-run] 不发送、不登记。session=${sessionCid || "unassigned"} files=${files.length}\n----- 将发出的微信正文 -----\n${text}\n----------------------------`);
    return;
  }

  let identity = null;
  if (files.length === 0) {
    // 60秒内重复文本防重发拦截（防止子窗口传完带caption的附件后又单独重发一遍相同文字）
    try {
      const map = readJson(MSG_MAP_FILE, { recent: [] });
      const cleanNorm = (s) => String(s || "").replace(/\s+/g, "").slice(0, 80);
      const targetNorm = cleanNorm(text);
      const now = Date.now();
      const dup = (map.recent || [])
        .slice(0, 6)
        .find((r) => now - (r.createdAt || 0) < 60000 && r.bodySnippet && cleanNorm(r.bodySnippet) === targetNorm);
      if (dup) {
        console.log(`⚠️ 已自动拦截 60 秒内重复文本发送 (与刚发送的附件说明完全一致)`);
        await cancelTypingIfActive(peer);
        return;
      }
    } catch {}
    const res = await sendMessageWeixin({ to: peer.fromUserId, text, opts });
    identity = recordMessageSessionMap({
      messageId: res.messageId,
      serverMessageId: res.serverMessageId,
      body: text,
      sessionCid,
      sessionTitle,
      engine,
    });
    await cancelTypingIfActive(peer);
    console.log(`✅ 已发送微信文本消息: messageId=${res.messageId}${res.serverMessageId ? ` svrId=${res.serverMessageId}` : ""}`);
  } else {
    for (let i = 0; i < files.length; i++) {
      const filePath = path.resolve(files[i]);
      const caption = i === 0 ? text : "";
      const res = await sendWeixinMediaFile({
        filePath,
        to: peer.fromUserId,
        text: caption,
        opts,
        cdnBaseUrl: peer.cdnBaseUrl || CDN_BASE_URL,
      });
      identity =
        recordMessageSessionMap({
          messageId: res.messageId,
          serverMessageId: res.serverMessageId,
          body: caption || `[媒体文件: ${path.basename(filePath)}]`,
          filePath,
          sessionCid,
          sessionTitle,
          engine,
        }) || identity;
      console.log(`✅ 已同时发送微信文本说明与媒体/文件 (${path.basename(filePath)}) [无需再次单独发文本]: messageId=${res.messageId}${res.serverMessageId ? ` svrId=${res.serverMessageId}` : ""}`);
    }
    await cancelTypingIfActive(peer);
  }
  if (identity) {
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
