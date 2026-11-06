#!/usr/bin/env node
/**
 * AGY 多 Project 分发中枢 V3.0（AGY 为默认执行引擎，Claude / Codex 为显式点名的后台任务）
 *
 * V3 变化（2026-11-06 审计 P0+P1）：
 * - 原话落盘：`route --msg=<编号>` 由脚本逐字转发 eru 原话，路由 LLM 只选目标，无法改写原话
 * - 投递确认：每次投递后台起 watch 进程，窗口报错 / 长时间无动作主动发微信告警
 * - Claude / Codex 任务由独立进程组的 job-runner 执行（AGY 或 bridge 重启都不会被连带杀掉），并记账 delegations.jsonl
 * - 状态读写全部原子化加锁；send 不再清空所有待回；legacyMirrors 链式解析；新窗口 ID 用唯一标记精确识别
 *
 * CLI：
 *   route --msg=<编号> --to=<目标> [--note="一句话备注"]
 *         目标 = 路由键(sanhao/echo/…) | AGY会话ID | codex:<线程ID> | claude:<路由键> | new:<标题>
 *   list | set-router <cid> | watch <cid> <标题> <msgId> <起始行数>
 *   兼容旧命令：send / new / codex-send / codex-new（无 --msg 时会被明确标注为「AGY 转述，非原话」）
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { sendMessageWeixin, sendMessageItemWeixin } from "./dist/src/messaging/send.js";
import { MessageItemType } from "./dist/src/api/types.js";
import { recordMessageSessionMap } from "./weixin-send.mjs";
import { readJson, updateJson, appendJsonl } from "./state-io.mjs";
import {
  CLAWBOT_DIR,
  HUB_DIR,
  BRAIN_DIR,
  RULES_FILE,
  PEER_FILE,
  MSG_MAP_FILE,
  JOBS_DIR,
  UUID_RE,
  DRY_RUN,
  loadRules,
  loadRouterState,
  saveRouterState,
  updateRouterState,
  routerCidSet,
  resolveMirror,
  routeKeyForCid,
  saveInboundMsg,
  loadInboundMsg,
  markInboundMsg,
  composeVerbatim,
} from "./core.mjs";

export { loadRouterState, saveRouterState, updateRouterState } from "./core.mjs";

const __filename = fileURLToPath(import.meta.url);
const CODEX_DB = "/Users/eru/.codex/sqlite/codex.db";
const AGENTAPI_BIN = "/Users/eru/.gemini/antigravity/bin/agentapi";
const AGY_MODEL = "--model=gemini-4-argon-high";
const SUMMARIES_DB = "/Users/eru/.gemini/antigravity/conversation_summaries.db";
const EVENTS_LEDGER = path.join(CLAWBOT_DIR, "events.jsonl");
const SEND_SCRIPT = path.join(CLAWBOT_DIR, "weixin-send.mjs");

const PROJECT_ID_MAP = {
  sanhao: "e3c351cc-716a-470f-a4a2-154c8de8eac5", // 📁 叁号暗房
  zhezhou: "d2000001-0002-4000-8000-000000000002", // 📁 折舟像塑特效
  echo: "a0ccfc45-e214-4550-8508-663e8e5817af", // 📁 echo
  zeroclinic: "d6000001-0006-4000-8000-000000000006", // 📁 第零诊室 ZeroClinic
  sidehustle: "d8000001-0008-4000-8000-000000000008", // 📁 副业与小游戏矩阵
  network: "bbf3d8e8-78a8-4a2e-b5f9-44348c91d5be", // 📁 mac-pack
  hub: "8443bc9f-2810-4330-999e-79f5406f5bc6", // 📁 agy工作站
};

export function formatPendingRepliesTail(excludeCid = "", minAgeMs = 90_000) {
  const st = loadRouterState();
  const pending = Object.values(st.pendingReplies || {}).filter(
    (p) => p && p.cid && p.cid !== excludeCid && Date.now() - (p.sentAt || 0) >= minAgeMs
  );
  if (pending.length === 0) return "";
  pending.sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0));
  const lines = [`\n\n📌 **【防漏回提醒：还有 ${pending.length} 个窗口等你回复】**`];
  for (const p of pending.slice(0, 4)) {
    const mins = Math.max(1, Math.round((Date.now() - (p.sentAt || Date.now())) / 60000));
    const flag = p.needsDecision ? "⏳待拍板" : "📩待查阅";
    lines.push(`- **${p.title}**（${mins}分钟前 · ${flag}）：${(p.summary || "").slice(0, 58)}  `);
  }
  return lines.join("\n");
}

export function lookupSessionByQuote({ refId }) {
  if (!refId) return null;
  try {
    const map = readJson(MSG_MAP_FILE, { byId: {} });
    const entry = map.byId?.[String(refId)];
    return entry?.cid && entry.cid !== "unassigned" ? entry : null;
  } catch {
    return null;
  }
}

function appendAutoloopEvent(evt) {
  appendJsonl(EVENTS_LEDGER, evt);
}

async function pinConversationProject(cid, projectId) {
  if (!cid || !projectId || projectId === PROJECT_ID_MAP.hub) return;
  try {
    const daemonDir = "/Users/eru/.gemini/antigravity/daemon";
    const files = fs.readdirSync(daemonDir).filter((f) => f.startsWith("hub_") && f.endsWith(".json"));
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(daemonDir, f), "utf8"));
        const base = `http://127.0.0.1:${d.httpPort}/exa.language_server_pb.LanguageServerService`;
        const headers = { "Content-Type": "application/json", "x-codeium-csrf-token": d.csrfToken };
        const r1 = await fetch(`${base}/GetAllCascadeTrajectories`, { method: "POST", headers, body: "{}" });
        if (!r1.ok) continue;
        const j1 = await r1.json();
        const s = j1?.trajectorySummaries?.[cid];
        if (!s) continue;
        s.trajectoryMetadata = s.trajectoryMetadata || {};
        s.trajectoryMetadata.projectId = projectId;
        await fetch(`${base}/JetboxWriteSummary`, {
          method: "POST",
          headers,
          body: JSON.stringify({ cascadeId: cid, summary: s }),
        });
        break;
      } catch {}
    }
  } catch {}
}

function resolveProjectIdForCall(args, projectKey) {
  if (projectKey && PROJECT_ID_MAP[projectKey]) return PROJECT_ID_MAP[projectKey];
  try {
    if (args[0] === "send-message" && args[1]) {
      const cid = String(args[1]).replace(/[^0-9a-f-]/gi, "");
      const rules = loadRules();
      const key = rules?.sessionPinMap?.[cid];
      if (key && PROJECT_ID_MAP[key]) return PROJECT_ID_MAP[key];
      const routeKey = routeKeyForCid(cid, rules);
      const routeProject = routeKey && rules.routes[routeKey]?.project;
      if (routeProject && PROJECT_ID_MAP[routeProject]) return PROJECT_ID_MAP[routeProject];
      if (cid && fs.existsSync(SUMMARIES_DB)) {
        const db = new DatabaseSync(SUMMARIES_DB, { readOnly: true });
        const row = db.prepare("SELECT project_id FROM conversation_summaries WHERE conversation_id = ? LIMIT 1").get(cid);
        db.close();
        if (row?.project_id && row.project_id !== "outside-of-project") return row.project_id;
      }
    } else if (args[0] === "new-conversation") {
      const joined = args.join(" ").split("\n---\n")[0];
      if (/淘宝|闲鱼|小游戏|warriors|进化|副业|会员|ultra|h3/i.test(joined)) return PROJECT_ID_MAP.sidehustle;
      if (/叁号暗房|philosophy-remotion|萨特|叔本华|功利主义/.test(joined)) return PROJECT_ID_MAP.sanhao;
      if (/折舟|像塑|effect|佩恩|凋零|苦力怕/i.test(joined)) return PROJECT_ID_MAP.zhezhou;
      if (/回声档案|echo|daft\s*punk|电台司令|radiohead/i.test(joined)) return PROJECT_ID_MAP.echo;
      if (/第零诊室|Zero\s*Clinic|AIGC/i.test(joined)) return PROJECT_ID_MAP.zeroclinic;
      if (/mac-pack|代理链路|mihomo/i.test(joined)) return PROJECT_ID_MAP.network;
    }
  } catch {}
  return process.env.ANTIGRAVITY_PROJECT_ID || PROJECT_ID_MAP.hub;
}

/**
 * agentapi 需要 AGY 语言服务的地址与 CSRF 令牌。AGY 终端里会自带这两个环境变量，
 * 但 bridge 独立运行后没有，所以每次调用前从 daemon/hub_*.json 里找存活的语言服务现取。
 */
function agyServerEnv() {
  const daemonDir = "/Users/eru/.gemini/antigravity/daemon";
  try {
    const hubs = fs
      .readdirSync(daemonDir)
      .filter((f) => /^hub_\d+\.json$/.test(f))
      .map((f) => {
        const full = path.join(daemonDir, f);
        try {
          return { ...JSON.parse(fs.readFileSync(full, "utf8")), mtime: fs.statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((d) => d && d.httpPort && d.csrfToken && d.pid)
      .filter((d) => {
        try {
          process.kill(d.pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (hubs.length === 0) return null;
    return {
      ANTIGRAVITY_LS_ADDRESS: `localhost:${hubs[0].httpPort}`,
      ANTIGRAVITY_CSRF_TOKEN: hubs[0].csrfToken,
      ANTIGRAVITY_APP_DATA_DIR: "/Users/eru/.gemini/antigravity",
    };
  } catch {
    return null;
  }
}

export function callAgentApi(args, { projectKey } = {}) {
  return new Promise((resolve) => {
    const projectId = resolveProjectIdForCall(args, projectKey);
    appendAutoloopEvent({ action: args[0], target: args[0] === "send-message" ? args[1] : "new", projectId });
    const serverEnv = agyServerEnv();
    if (!serverEnv && !process.env.ANTIGRAVITY_LS_ADDRESS) {
      resolve({ code: -2, out: "", err: "找不到存活的 Antigravity 语言服务（AGY 没开？）", projectId });
      return;
    }
    const env = { ...process.env, ...(serverEnv || {}), ANTIGRAVITY_PROJECT_ID: projectId };
    const child = spawn(AGENTAPI_BIN, args, { cwd: HUB_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    // agentapi 偶尔不返回：超时按失败处理，免得 bridge 收信循环被一条消息卡死
    const timeoutMs = Number(process.env.CLAWBOT_AGENTAPI_TIMEOUT_MS) || 90_000;
    const timer = setTimeout(() => {
      err += `\nagentapi 超过 ${timeoutMs / 1000} 秒没返回，已终止`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: "", err: String(e), projectId });
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      const cid = args[0] === "send-message" ? String(args[1] || "").replace(/[^0-9a-f-]/gi, "") : null;
      const jsonErr = (out.match(/"error"\s*:\s*"([^"]+)"/) || [])[1];
      const finalCode = code === 0 && jsonErr ? 1 : code;
      if (cid && projectId && finalCode === 0) await pinConversationProject(cid, projectId);
      resolve({ code: finalCode, out: out.trim(), err: (err.trim() || jsonErr || "").trim(), projectId });
    });
  });
}

export async function notifyWeixin(text, sessionMeta = null) {
  if (DRY_RUN) {
    console.log(`[dry-run notify] ${text}`);
    return null;
  }
  if (!fs.existsSync(PEER_FILE)) return null;
  try {
    const peer = JSON.parse(fs.readFileSync(PEER_FILE, "utf8"));
    const res = await sendMessageWeixin({
      to: peer.fromUserId,
      text,
      opts: { baseUrl: peer.baseUrl, token: peer.token, contextToken: peer.contextToken, accountId: peer.accountId },
    });
    if (sessionMeta?.cid) {
      recordMessageSessionMap({
        messageId: res.messageId,
        serverMessageId: res.serverMessageId,
        body: text,
        sessionCid: sessionMeta.cid,
        sessionTitle: sessionMeta.title,
        engine: sessionMeta.engine || "agy",
        msgId: sessionMeta.msgId || null,
      });
    }
    return res;
  } catch (e) {
    console.error(`[agy-route] Failed to send WeChat notification: ${String(e)}`);
    return null;
  }
}

export async function sendToolProgressWeixin(toolName, phase = "start") {
  if (!fs.existsSync(PEER_FILE)) return;
  try {
    const peer = JSON.parse(fs.readFileSync(PEER_FILE, "utf8"));
    const now = Date.now();
    const item =
      phase === "start"
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
    await sendMessageItemWeixin({
      to: peer.fromUserId,
      item,
      opts: { baseUrl: peer.baseUrl, token: peer.token, contextToken: peer.contextToken, accountId: peer.accountId },
    });
  } catch {}
}

function formatRelativeTime(mtimeMs) {
  const diffSec = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
  if (diffSec < 60) return `${diffSec}秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}小时前`;
  return `${Math.floor(diffHr / 24)}天前`;
}

function cleanUserText(rawContent) {
  if (!rawContent) return "";
  let text = rawContent;
  const urMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (urMatch) {
    text = urMatch[1];
  } else {
    const smMatch = text.match(/<SYSTEM_MESSAGE>([\s\S]*?)<\/SYSTEM_MESSAGE>/);
    if (smMatch) {
      text = smMatch[1]
        .replace(/^[\s\S]*?content=/, "")
        .replace(/---[\s\S]*?(【微信同步回复指令】|回复微信：)[\s\S]*$/, "");
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

function transcriptPath(cid) {
  return path.join(BRAIN_DIR, cid, ".system_generated/logs/transcript.jsonl");
}

export function countTranscriptLines(cid) {
  const p = transcriptPath(cid);
  if (!fs.existsSync(p)) return 0;
  return fs.readFileSync(p, "utf8").split("\n").filter(Boolean).length;
}

export function scanActiveConversations(limit = 8, excludeRouter = true) {
  const state = loadRouterState();
  if (!fs.existsSync(BRAIN_DIR)) return [];
  const routers = routerCidSet(state);
  const entries = fs
    .readdirSync(BRAIN_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && UUID_RE.test(d.name));

  const replacedCids = new Set(Object.keys(state.legacyMirrors || {}));
  const list = [];
  for (const d of entries) {
    const cid = d.name;
    if (excludeRouter && routers.has(cid)) continue;
    if (replacedCids.has(cid)) continue;

    const tPath = transcriptPath(cid);
    if (!fs.existsSync(tPath)) continue;
    const stat = fs.statSync(tPath);
    const lines = fs.readFileSync(tPath, "utf8").trim().split("\n");
    if (lines.length === 0 || !lines[0]) continue;

    let firstStep = null;
    try {
      firstStep = JSON.parse(lines[0]);
    } catch {
      continue;
    }
    if (firstStep.type === "SYSTEM_MESSAGE" && /sender=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(firstStep.content || "")) {
      continue;
    }

    const userPrompts = [];
    let lastAiText = "";
    let lastStep = null;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        lastStep = obj;
        if (obj.type === "USER_INPUT") {
          const cleaned = cleanUserText(obj.content);
          if (cleaned) userPrompts.push(cleaned);
        } else if (
          obj.type === "SYSTEM_MESSAGE" &&
          (obj.content?.includes("sender=user") || obj.content?.includes("来自 eru 手机微信") || obj.content?.includes("eru 从微信发来的直接消息") || obj.content?.includes("eru 微信消息"))
        ) {
          const cleaned = cleanUserText(obj.content);
          if (cleaned) userPrompts.push(cleaned);
        } else if (obj.type === "PLANNER_RESPONSE" && typeof obj.content === "string") {
          const aiClean = obj.content.replace(/\s+/g, " ").trim();
          if (aiClean) lastAiText = aiClean;
        }
      } catch {}
    }
    if (userPrompts.length === 0) continue;

    list.push({
      engine: "agy",
      cid,
      alias: state.sessionAliases?.[cid] || "",
      mtimeMs: stat.mtimeMs,
      relTime: formatRelativeTime(stat.mtimeMs),
      turns: userPrompts.length,
      firstMsg: userPrompts[0].slice(0, 140),
      recentMsgs: userPrompts.slice(-2).map((m) => m.slice(0, 140)),
      latestAiSnippet: lastAiText ? lastAiText.slice(0, 220) : "(正在执行工具或思考中...)",
      isLastRouted: state.lastRoutedCid === cid,
      lastState: lastStep ? `${lastStep.type}(${lastStep.status})` : "UNKNOWN",
    });
  }
  list.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return list.slice(0, limit).map((item, idx) => ({ ...item, shortId: `A${idx + 1}` }));
}

export async function scanCodexConversations(limit = 5) {
  if (!fs.existsSync(CODEX_DB)) return [];
  try {
    const db = new DatabaseSync(CODEX_DB, { readOnly: true });
    const rows = db
      .prepare(`
        SELECT thread_id, display_title, cwd, source_kind, source_updated_at
        FROM local_thread_catalog
        WHERE (source_kind = 'vscode' OR cwd IS NOT NULL)
          AND missing_candidate = 0
        ORDER BY source_updated_at DESC
        LIMIT ?
      `)
      .all(limit);
    db.close();
    const state = loadRouterState();
    return rows.map((r, idx) => {
      const mtimeMs = (r.source_updated_at || 0) * 1000;
      return {
        engine: "codex",
        shortId: `C${idx + 1}`,
        cid: r.thread_id,
        title: r.display_title || "Codex 会话",
        cwd: r.cwd || HUB_DIR,
        mtimeMs,
        relTime: mtimeMs ? formatRelativeTime(mtimeMs) : "未知",
        isLastRouted: state.lastRoutedCid === r.thread_id,
      };
    });
  } catch {
    return [];
  }
}

export async function formatActiveSessionsForPrompt(limit = 8) {
  const state = loadRouterState();
  const rules = loadRules();
  const agySessions = scanActiveConversations(limit, true);
  const lines = [];
  if (state.lockedSession?.cid) {
    lines.push(`🔒 锁定: [${state.lockedSession.engine.toUpperCase()}:${state.lockedSession.cid}] 「${state.lockedSession.title}」`);
  } else if (state.lastRoutedCid) {
    lines.push(`📌 上次对话: [${(state.lastRoutedEngine || "agy").toUpperCase()}:${state.lastRoutedCid}] 「${state.lastRoutedTitle || "未命名"}」`);
  }
  lines.push(`🗂️ 【路由键（--to= 直接用）】：`);
  for (const [key, r] of Object.entries(rules.routes || {})) {
    lines.push(`- ${key} → ${r.name}（AGY ${r.cid ? r.cid.slice(0, 8) : "未建窗"}）`);
  }
  lines.push(`📂 【AGY 活跃窗口 (${agySessions.length}个)】：`);
  for (const s of agySessions) {
    const tag = s.isLastRouted ? "⭐" : "";
    const titlePart = s.alias || s.firstMsg.slice(0, 24);
    const snippet = (s.latestAiSnippet || "").replace(/\s+/g, " ").slice(0, 55);
    lines.push(`#${s.shortId}${tag} ${s.cid} [${titlePart}] (${s.relTime}, ${s.lastState}) → ${snippet}`);
  }
  return lines.join("\n");
}

/** 投递给 AGY 子窗口的外壳：只保留回复方式 + 脚本会强制执行的规则，其余规则见 GEMINI.md */
const HANDOFF_STEPS = 500;
function countPlannerSteps(cid) {
  try {
    const t = fs.readFileSync(transcriptPath(cid), "utf8");
    return (t.match(/"type":"PLANNER_RESPONSE"/g) || []).length;
  } catch {
    return 0;
  }
}

function buildWrappedTaskPrompt(body, sessionLabel, sessionCid, { msgId = "", verbatim = true, routeKey = null } = {}) {
  const sessionFlag = sessionCid ? ` --session=${sessionCid}` : "";
  const titleFlag = sessionLabel ? ` --title="${sessionLabel.replace(/"/g, "")}"` : "";
  const head = verbatim
    ? `📱 [eru 微信消息${msgId ? ` msg=${msgId}` : ""}]（以下为 eru 原话，脚本逐字转发）`
    : `📱 [经 AGY 路由转述的消息 · ⚠️ 非 eru 原话，如有疑问以 eru 原话为准]`;
  const rules = loadRules();
  const rk = routeKey || (sessionCid ? routeKeyForCid(sessionCid, rules) : null);
  const acc = rk ? rules.routes?.[rk]?.acceptance : null;
  const route = rk ? rules.routes?.[rk] : null;
  const steps = sessionCid ? countPlannerSteps(sessionCid) : 0;
  const lines = [
    head,
    ``,
    body,
    ``,
    `---`,
    `回复微信：node ${SEND_SCRIPT} '结论' [/绝对路径/交付物文件]${sessionFlag}${titleFlag}`,
    `先秒回：拿到这条后第一件事就是用上面的命令回 eru 一句话（20 字内）——简单问题直接给答案；要动手的说清你接下来做什么。然后再开始干活，干完再发结果。`,
    acc
      ? `验收（脚本强制）：本项目「完成」= ${acc.label}，作为附件发出。没附合格交付物却说完成，消息会被自动降级成【进度 · 未通过验收】。${acc.review === "claude" ? "附件通过脚本检查后会交 Claude 审查，不通过会退回本窗口重做。" : ""}`
      : `验收（脚本强制）：声称完成必须附交付物文件或 --proof=url:地址；没有就会被标【未验证】。`,
    `说了「马上 / 正在 / 接下来去做 X」会被登记成承诺并计时（默认 30 分钟），到期没交合格结果会提醒 eru。做不到就直说做不到。eru 点名的工具和引擎（Deep Research / Claude / Codex 等）不许换成别的顶替；调不了就直说，并讲清需要 eru 做哪一步。调研必须附 --proof=research:/证据.md。原型/Mock 必须直说。未经 eru 拍板不写业务代码、不渲染、不开新集。`,
  ];
  if (steps >= HANDOFF_STEPS) {
    lines.push(
      `⚠️ 本窗口已 ${steps} 步。先把现状写进 ${route?.cwd || "项目目录"}/HANDOFF.md（当前进度、eru 已拍板的决定、没做完的事、关键文件路径），再处理上面的消息。`
    );
  }
  return lines.join("\n");
}

// ───────── 新建 AGY 窗口：用唯一标记精确识别新会话 ID ─────────

export async function createConversation({ title, body, projectKey, msgId = "", verbatim = true }) {
  const token = crypto.randomBytes(5).toString("hex");
  const beforeDirs = new Set(fs.existsSync(BRAIN_DIR) ? fs.readdirSync(BRAIN_DIR) : []);
  const wrapped = `[route-token:${token}]\n${buildWrappedTaskPrompt(body, title, "", { msgId, verbatim })}`;
  const res = await callAgentApi(["new-conversation", AGY_MODEL, `--title=${title}`, wrapped], { projectKey });
  let newCid = (res.out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || null;
  for (let i = 0; !newCid && i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const fresh = (fs.existsSync(BRAIN_DIR) ? fs.readdirSync(BRAIN_DIR) : []).filter((d) => !beforeDirs.has(d) && UUID_RE.test(d));
    newCid = fresh.find((d) => {
      try {
        return fs.readFileSync(transcriptPath(d), "utf8").includes(`route-token:${token}`);
      } catch {
        return false;
      }
    }) || null;
  }
  if (newCid) {
    if (projectKey && PROJECT_ID_MAP[projectKey]) await pinConversationProject(newCid, PROJECT_ID_MAP[projectKey]);
    updateRouterState((st) => {
      st.sessionAliases = { ...(st.sessionAliases || {}), [newCid]: title };
      st.lastRoutedCid = newCid;
      st.lastRoutedTitle = title;
      st.lastRoutedEngine = "agy";
      st.lastRoutedAt = new Date().toISOString();
    });
  }
  return { code: res.code, cid: newCid, err: res.err };
}

// ───────── 投递到已有 AGY 窗口 + 投递确认 ─────────

const MISSING_RE = /not.?found|no such|unknown conversation|does not exist|invalid (recipient|conversation)/i;

export function spawnWatcher(cid, title, msgId, beforeLines) {
  try {
    const child = spawn(process.execPath, [__filename, "watch", cid, title, msgId || "-", String(beforeLines)], {
      detached: true,
      stdio: "ignore",
      cwd: CLAWBOT_DIR,
    });
    child.unref();
  } catch {}
}

export async function deliverToAgy({ cid, title, body, msgId = "", verbatim = true, routeKey = null }) {
  const st = loadRouterState();
  const effectiveCid = resolveMirror(cid, st);
  const beforeLines = countTranscriptLines(effectiveCid);
  const res = await callAgentApi(["send-message", effectiveCid, buildWrappedTaskPrompt(body, title, effectiveCid, { msgId, verbatim, routeKey })]);

  if (res.code !== 0) {
    const errText = `${res.err} ${res.out}`.trim();
    if (!MISSING_RE.test(errText)) {
      await notifyWeixin(`⚠️ 你的消息没送进「${title}」（${errText.slice(0, 80) || "没有返回原因"}）。引用这条说「发给 X」可以换个窗口`, { cid, title, engine: "agy", msgId });
      return { code: res.code, cid: effectiveCid };
    }
    // 只有「会话不存在」才建接力窗口
    const created = await createConversation({
      title,
      body: `[接力原会话 ${cid}（${title}），历史上下文可读 ${transcriptPath(cid)}]\n\n${body}`,
      projectKey: routeKey ? loadRules().routes?.[routeKey]?.project : null,
      msgId,
      verbatim,
    });
    if (created.cid) {
      updateRouterState((s) => {
        s.legacyMirrors = { ...(s.legacyMirrors || {}), [effectiveCid]: created.cid };
      });
      await notifyWeixin(`🦞 原会话「${title}」已不存在，已建接力窗口 ${created.cid.slice(0, 8)} 继续处理。`, { cid: created.cid, title, engine: "agy" });
      spawnWatcher(created.cid, title, msgId, 0);
    } else {
      await notifyWeixin(`⚠️ 「${title}」窗口已经不在了，新窗口也没建起来。引用这条说「发给 X」可以换个窗口`, { cid, title, engine: "agy", msgId });
    }
    return { code: created.cid ? 0 : created.code, cid: created.cid };
  }

  updateRouterState((s) => {
    const pending = { ...(s.pendingReplies || {}) };
    delete pending[cid];
    delete pending[effectiveCid];
    s.pendingReplies = pending;
    s.sessionAliases = { ...(s.sessionAliases || {}), [effectiveCid]: title };
    s.lastRoutedCid = effectiveCid;
    s.lastRoutedTitle = title;
    s.lastRoutedEngine = "agy";
    s.lastRoutedAt = new Date().toISOString();
    s.lastDispatch = { ...(s.lastDispatch || {}), [effectiveCid]: { msgId: msgId || null, at: Date.now(), routeKey } };
  });
  spawnWatcher(effectiveCid, title, msgId, beforeLines);
  return { code: 0, cid: effectiveCid };
}

/**
 * 投递后盯 transcript：
 *  - 消息还在排队（窗口忙着跑上一个任务）→ 只要窗口有动作就继续等，不算处理、也不告警
 *  - 窗口完全没动作超过 4 分钟 → 告警「卡死」
 *  - 消息已注入后：报错且 45 秒没恢复 → 告警；4 分钟没有任何模型动作 → 告警
 */
function repliedSince(cid, sinceMs, msgId, watchingRouter) {
  try {
    const map = readJson(MSG_MAP_FILE, { recent: [] });
    if (watchingRouter && msgId !== "-" &&
        loadInboundMsg(msgId)?.routes?.some((route) => route.target && route.target !== cid)) return true;
    return (map.recent || []).some((r) => r.cid === cid && (r.createdAt || 0) >= sinceMs &&
      (!watchingRouter || !r.msgId));
  } catch {
    return true; // 读不到就不误报
  }
}

async function watchTurnEnd(cid, title, msgId, injectedAt, start, totalMs) {
  const watchingRouter = routerCidSet().has(cid);
  const QUIET_MS = Number(process.env.CLAWBOT_TURN_QUIET_MS) || 5 * 60_000;
  const POLL = Number(process.env.CLAWBOT_WATCH_POLL_MS) || 6000;
  let lastSize = 0;
  let lastChange = Date.now();
  while (Date.now() - start < totalMs) {
    await new Promise((r) => setTimeout(r, POLL));
    let size = 0;
    try {
      size = fs.statSync(transcriptPath(cid)).size;
    } catch {}
    if (size !== lastSize) {
      lastSize = size;
      lastChange = Date.now();
      continue;
    }
    if (Date.now() - lastChange >= QUIET_MS) {
      // 最后一步还是 RUNNING（长命令、渲染在跑）就不算停，继续等
      let lastStatus = "";
      try {
        const tail = fs.readFileSync(transcriptPath(cid), "utf8").trimEnd().split("\n").pop();
        lastStatus = JSON.parse(tail).status || "";
      } catch {}
      if (lastStatus === "RUNNING") {
        lastChange = Date.now();
        continue;
      }
      if (!repliedSince(cid, injectedAt, msgId, watchingRouter)) {
        await notifyWeixin(
          `⚠️ 「${title}」停了 ${Math.round(QUIET_MS / 60000)} 分钟，没给你回消息，可能做了一半就停了。直接说话它会接着做；想换个窗口就引用这条说「发给 X」`,
          { cid, title, engine: "agy", msgId: msgId !== "-" ? msgId : null }
        );
      }
      return;
    }
  }
}

async function watchDelivery(cid, title, msgId, beforeLines) {
  const env = (k, d) => Number(process.env[k]) || d;
  const TOTAL_MS = env("CLAWBOT_WATCH_TOTAL_MS", 30 * 60_000);
  const IDLE_MS = env("CLAWBOT_WATCH_MS", 240_000);
  const ERR_MS = env("CLAWBOT_WATCH_ERR_MS", 45_000);
  const POLL_MS = env("CLAWBOT_WATCH_POLL_MS", 6000);
  const retryHint = msgId !== "-" ? `。想换个窗口就引用这条说「发给 X」` : "";
  const marker = msgId !== "-" ? `msg=${msgId}` : null;
  const start = Date.now();
  let lastActivityAt = start;
  let lastCount = beforeLines;
  let injectedAt = 0;
  let errorFirstAt = 0;
  while (Date.now() - start < TOTAL_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const p = transcriptPath(cid);
    if (!fs.existsSync(p)) continue;
    const all = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
    if (all.length > lastCount) {
      lastActivityAt = Date.now();
      lastCount = all.length;
    }
    const fresh = all.slice(beforeLines);
    let idx = marker ? fresh.findIndex((l) => l.includes(marker)) : 0;
    if (idx < 0) {
      if (Date.now() - lastActivityAt > IDLE_MS) {
        await notifyWeixin(`⚠️ 「${title}」${Math.round((Date.now() - lastActivityAt) / 60000)} 分钟没动静，你的消息还没被它接收，可能卡住了${retryHint}`, { cid, title, engine: "agy", msgId: msgId !== "-" ? msgId : null });
        return;
      }
      continue; // 窗口在忙，消息排队中
    }
    injectedAt = injectedAt || Date.now();
    let errorText = "";
    let progressed = false;
    for (const l of fresh.slice(idx + 1)) {
      let o;
      try {
        o = JSON.parse(l);
      } catch {
        continue;
      }
      if (o.type === "ERROR_MESSAGE") {
        errorText = String(o.error || o.content || "").slice(0, 120);
        progressed = false;
      } else if (o.source === "MODEL" || o.type === "PLANNER_RESPONSE") {
        progressed = true;
      }
    }
    if (progressed) {
      // 已开始处理：继续盯到这一轮结束，结束了却没给 eru 回话就告警（AGY 最常见的「做一半就停」）
      await watchTurnEnd(cid, title, msgId, injectedAt, start, TOTAL_MS);
      return;
    }
    if (errorText) errorFirstAt = errorFirstAt || Date.now();
    if (errorText && Date.now() - errorFirstAt > ERR_MS) {
      await notifyWeixin(`⚠️ 「${title}」报错后停住了（${errorText.slice(0, 60)}）${retryHint}`, { cid, title, engine: "agy", msgId: msgId !== "-" ? msgId : null });
      return;
    }
    if (!errorText && Date.now() - injectedAt > IDLE_MS) {
      await notifyWeixin(`⚠️ 「${title}」收到你的消息 ${Math.round(IDLE_MS / 60000)} 分钟了还没反应，可能卡住了${retryHint}`, { cid, title, engine: "agy", msgId: msgId !== "-" ? msgId : null });
      return;
    }
  }
  if (!injectedAt) console.log(`[watch] ${title} 窗口持续忙碌，${TOTAL_MS / 60000} 分钟内消息仍在排队，未告警`);
}

// ───────── Claude / Codex 后台任务：独立进程组执行，与 AGY、bridge 生命周期脱钩 ─────────

export function enqueueJob(job) {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  const id = `j${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const jobFile = path.join(JOBS_DIR, `${id}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ id, createdAt: new Date().toISOString(), ...job }, null, 2));
  const logFd = fs.openSync(path.join(JOBS_DIR, `${id}.log`), "a");
  const child = spawn(process.execPath, [path.join(CLAWBOT_DIR, "job-runner.mjs"), jobFile], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: CLAWBOT_DIR,
  });
  child.unref();
  fs.closeSync(logFd);
  return id;
}

/** 兼容旧调用：现在改为排队到独立进程执行 */
export async function dispatchToCodex({ threadId = null, title = "Codex 任务", cwd = HUB_DIR, instruction, imagePaths = [], project = null }) {
  return enqueueJob({ engine: "codex", threadId, title, cwd, instruction, images: imagePaths, project });
}

// ───────── 统一路由入口 ─────────

/**
 * to: 路由键 | AGY 会话ID | codex:<线程ID> | claude:<路由键> | new:<标题>
 */
export async function routeMessage({ msgId, to, note = "", via = "router" }) {
  const rec = loadInboundMsg(msgId);
  if (!rec) throw new Error(`找不到原话存档 msg=${msgId}`);
  const rules = loadRules();
  const noteBlock = note ? `\n\n🐟 波妞路由备注（不是 eru 原话）：${note}` : "";
  const body = composeVerbatim(rec) + noteBlock;
  const target = String(to || "").trim();
  const images = (rec.mediaFiles || []).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
  let result;

  if (target.startsWith("claude:") || target.startsWith("codex:") || target.startsWith("codex-new:")) {
    const [engine, ref] = [target.split(":")[0], target.slice(target.indexOf(":") + 1)];
    if (engine === "claude") {
      const r = rules.routes?.[ref];
      if (!r) throw new Error(`未知路由键「${ref}」，可用：${Object.keys(rules.routes || {}).join(" / ")}`);
      const jobId = enqueueJob({ engine: "claude", project: ref, cwd: r.cwd, title: r.name, instruction: body, images, msgId });
      result = { engine: "claude", target: ref, jobId };
    } else if (engine === "codex") {
      const hit = (await scanCodexConversations(30)).find((c) => c.cid === ref);
      const jobId = enqueueJob({ engine: "codex", threadId: ref, cwd: hit?.cwd || HUB_DIR, title: hit?.title || "Codex", instruction: body, images, msgId });
      result = { engine: "codex", target: ref, jobId };
    } else {
      const r = rules.routes?.[ref];
      const jobId = enqueueJob({ engine: "codex", threadId: null, project: r ? ref : null, cwd: r?.cwd || HUB_DIR, title: r?.name || "Codex 新任务", instruction: body, images, msgId });
      result = { engine: "codex", target: `new:${ref}`, jobId };
    }
  } else if (target.startsWith("new:")) {
    const title = target.slice(4).trim() || "微信新任务";
    const created = await createConversation({ title, body, msgId });
    if (created.code !== 0) throw new Error(`新建 AGY 窗口失败 exit=${created.code}：${created.err || ""}`);
    if (created.cid) spawnWatcher(created.cid, title, msgId, 0);
    await notifyWeixin(`🦞 已新建「${title}」${created.cid ? `(${created.cid.slice(0, 8)})` : "（未能识别新窗口 ID）"}处理中。`, created.cid ? { cid: created.cid, title, engine: "agy" } : null);
    result = { engine: "agy", target: created.cid, created: true };
  } else if (rules.routes?.[target]) {
    const r = rules.routes[target];
    if (r.engine === "claude" || r.engine === "codex") {
      return routeMessage({ msgId, to: r.engine === "claude" ? `claude:${target}` : `codex-new:${target}`, note, via });
    }
    if (r.cid) {
      const d = await deliverToAgy({ cid: r.cid, title: r.name, body, msgId, routeKey: target });
      if (d.code !== 0) throw new Error(`投递「${r.name}」失败 exit=${d.code}`);
      result = { engine: "agy", target: d.cid, routeKey: target };
    } else {
      const created = await createConversation({ title: r.name, body, projectKey: r.project, msgId });
      if (created.cid) {
        updateJson(RULES_FILE, {}, (rl) => {
          rl.routes[target].cid = created.cid;
        });
        spawnWatcher(created.cid, r.name, msgId, 0);
      }
      result = { engine: "agy", target: created.cid, routeKey: target, created: true };
    }
  } else if (UUID_RE.test(target)) {
    if (routerCidSet().has(target)) throw new Error("不能把消息投回路由窗口自己");
    const st = loadRouterState();
    const routeKey = routeKeyForCid(target, rules, st);
    const title = (routeKey && rules.routes[routeKey]?.name) || st.sessionAliases?.[target] || target.slice(0, 8);
    const d = await deliverToAgy({ cid: target, title, body, msgId, routeKey });
    if (d.code !== 0) throw new Error(`投递「${title}」失败 exit=${d.code}`);
    result = { engine: "agy", target: d.cid, routeKey };
  } else {
    throw new Error(`无法识别的目标「${target}」`);
  }

  markInboundMsg(msgId, { routes: [{ at: new Date().toISOString(), via, to: target, ...result }] });
  return result;
}

// ───────── CLI ─────────

function parseFlags(argv) {
  const flags = {};
  const pos = [];
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)=([\s\S]*)$/i);
    if (m) flags[m[1]] = m[2];
    else pos.push(a);
  }
  return { flags, pos };
}

async function cliMain() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseFlags(rest);

  if (!cmd || cmd === "list") {
    console.log(await formatActiveSessionsForPrompt(10));
    return;
  }

  if (cmd === "set-router") {
    if (!rest[0]) {
      console.error("Usage: node agy-route.mjs set-router <conversation_id>");
      process.exit(1);
    }
    const updated = updateRouterState((st) => {
      if (st.routerCid && st.routerCid !== rest[0]) st.previousRouterCid = st.routerCid;
      st.routerCid = rest[0];
    });
    console.log(`✅ Router Conversation ID updated to: ${updated.routerCid}`);
    return;
  }

  if (cmd === "watch") {
    const [cid, title, msgId, beforeLines] = rest;
    await watchDelivery(cid, title, msgId, Number(beforeLines) || 0);
    return;
  }

  if (cmd === "route") {
    if (!flags.msg || !flags.to) {
      console.error('Usage: node agy-route.mjs route --msg=<编号> --to=<路由键|会话ID|codex:<线程ID>|claude:<路由键>|new:<标题>> [--note="备注"]');
      process.exit(1);
    }
    const r = await routeMessage({ msgId: flags.msg, to: flags.to, note: flags.note || "" });
    console.log(`✅ msg=${flags.msg} 已逐字投递 → ${JSON.stringify(r)}`);
    return;
  }

  // ── 以下为兼容旧命令。没有 --msg 时正文由调用方（LLM）撰写，会被明确标注为转述 ──
  const legacyBody = (parts) => {
    if (flags.msg) {
      const rec = loadInboundMsg(flags.msg);
      if (!rec) throw new Error(`找不到原话存档 msg=${flags.msg}`);
      return { body: composeVerbatim(rec), verbatim: true };
    }
    return { body: parts.join(" ").trim(), verbatim: false };
  };

  if (cmd === "send") {
    const [targetCid, sessionTitle, ...msgParts] = pos;
    const { body, verbatim } = legacyBody(msgParts);
    if (!targetCid || !sessionTitle || !body) {
      console.error('Usage: node agy-route.mjs send <target_cid> "<会话简称>" ("<内容>" | --msg=<编号>)');
      process.exit(1);
    }
    const d = await deliverToAgy({ cid: targetCid, title: sessionTitle, body, msgId: flags.msg || "", verbatim });
    console.log(`${d.code === 0 ? "✅" : "❌"} send → ${d.cid} (${sessionTitle}) exit=${d.code}${verbatim ? "" : "（已标注为 AGY 转述）"}`);
    return;
  }

  if (cmd === "new") {
    const [title, ...msgParts] = pos;
    const { body, verbatim } = legacyBody(msgParts);
    if (!title || !body) {
      console.error('Usage: node agy-route.mjs new "<新会话标题>" ("<内容>" | --msg=<编号>)');
      process.exit(1);
    }
    const created = await createConversation({ title, body, msgId: flags.msg || "", verbatim });
    if (created.cid) spawnWatcher(created.cid, title, flags.msg || "-", 0);
    await notifyWeixin(`🦞 已新建「${title}」${created.cid ? `(${created.cid.slice(0, 8)}) ` : ""}处理中。`, created.cid ? { cid: created.cid, title, engine: "agy" } : null);
    console.log(`${created.cid ? "✅" : "⚠️"} new → ${created.cid || "未识别到新会话 ID"} (${title}) exit=${created.code}`);
    return;
  }

  if (cmd === "codex-send" || cmd === "codex-new") {
    const isNew = cmd === "codex-new";
    const [a, b, ...msgParts] = pos;
    const { body } = legacyBody(msgParts);
    if (!a || !b || !body) {
      console.error(isNew ? 'Usage: node agy-route.mjs codex-new "<标题>" "<工作目录>" ("<指令>" | --msg=<编号>)' : 'Usage: node agy-route.mjs codex-send <thread_id> "<标题>" ("<指令>" | --msg=<编号>)');
      process.exit(1);
    }
    let jobId;
    if (isNew) {
      jobId = enqueueJob({ engine: "codex", threadId: null, title: a, cwd: b, instruction: body, msgId: flags.msg || "" });
    } else {
      const hit = (await scanCodexConversations(30)).find((c) => c.cid === a);
      jobId = enqueueJob({ engine: "codex", threadId: a, title: b, cwd: hit?.cwd || HUB_DIR, instruction: body, msgId: flags.msg || "" });
    }
    console.log(`✅ 已排队到独立后台进程执行 Codex（job=${jobId}），本命令立即返回，结果会直接发微信。`);
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  cliMain().catch((e) => {
    console.error(String(e?.message || e));
    process.exit(1);
  });
}
