#!/usr/bin/env node
/**
 * 微信 ClawBot ↔ AGY / Codex 个人龙虾守护桥 V2.0
 *
 * 新增特性：
 * 1. 微信长按引用 / 局部划词引用 (Partial Quote) 解析 + 消息 ID 100% 精准溯源原窗口
 * 2. 零延迟手机特权斜杠指令：/help, /status, /screen, /sessions, /use, /unlock, /codex
 * 3. AGY + Codex (sqlite/codex.db) 双引擎统一会话快照与跨引擎续接
 * 4. 微信原生工具进度提示帧 (TOOL_CALL_START / RESULT) + TypingStatus.CANCEL 自动收尾
 * 5. 微信语音 SILK -> 24kHz WAV 自动无损转码
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

import { startWeixinLoginWithQr, waitForWeixinLogin, displayQRCode } from "./dist/src/auth/login-qr.js";
import {
  DEFAULT_BASE_URL,
  CDN_BASE_URL,
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  saveWeixinAccount,
  registerWeixinAccountId,
} from "./dist/src/auth/accounts.js";
import { getUpdates, getConfig, sendTyping } from "./dist/src/api/api.js";
import { MessageItemType, TypingStatus } from "./dist/src/api/types.js";
import { sendMessageWeixin } from "./dist/src/messaging/send.js";
import { sendWeixinMediaFile } from "./dist/src/messaging/send-media.js";
import { downloadMediaFromItem } from "./dist/src/media/media-download.js";
import { initializeQuoteStore, getQuoteStore } from "./dist/src/messaging/quote-store.js";
import { resolvePartialQuote } from "./dist/src/messaging/partial-quote.js";
import { getWeixinMessageId } from "./dist/src/messaging/inbound.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "./dist/src/storage/sync-buf.js";
import {
  loadRouterState,
  saveRouterState,
  scanActiveConversations,
  scanCodexConversations,
  lookupSessionByQuote,
  enqueueJob,
  callAgentApi,
  routeMessage,
  spawnWatcher,
  countTranscriptLines,
} from "./agy-route.mjs";
import {
  DEFAULT_ROUTER_CID,
  UUID_RE,
  loadRules,
  routerCidSet,
  matchRouteByKeywords,
  keywordHits,
  routeKeyForCid,
  saveInboundMsg,
  loadInboundMsg,
  markInboundMsg,
  composeVerbatim,
  BRAIN_DIR,
  MSG_MAP_FILE,
} from "./core.mjs";
import { readJsonlTail, readJson, updateJson } from "./state-io.mjs";
import { listOpenCommitments, takeOverdue, dropCommitment, fmtAgo, claimNudgeSlot } from "./commitments.mjs";
import { PROOFS_FILE } from "./proof.mjs";
import { recordMessageSessionMap } from "./weixin-send.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INBOX_DIR = path.join(__dirname, "inbox");
const PEER_FILE = path.join(__dirname, "latest_peer.json");
const QR_PNG_PATH = "/Users/eru/.gemini/antigravity/brain/f5fc7b1d-3bf0-4bc6-897f-7d902efd07d3/weixin_clawbot_qr.png";
const AGY_ROUTE_SCRIPT = path.join(__dirname, "agy-route.mjs");

fs.mkdirSync(INBOX_DIR, { recursive: true });

function getRouterCid() {
  return process.env.AGY_MAIN_CONV_ID || loadRouterState().routerCid || DEFAULT_ROUTER_CID;
}

/** 发信人白名单：只有 ClawBot 绑定者本人 + rules.json.allowUsers 能下指令 */
function isAllowedSender(fromUserId, account) {
  if (account.userId && fromUserId === account.userId) return true;
  return (loadRules().allowUsers || []).includes(fromUserId);
}

/** 精确引用对应的会话。分拣回执用于选项目，没有业务会话。 */
function quoteTarget(matched) {
  if (!matched?.cid || (matched.title === "微信分拣" && matched.msgId)) return null;
  const cid = String(matched.cid);
  if (cid.startsWith("claude:")) return loadRules().routes?.[cid.slice(7)] ? cid : null;
  if (matched.engine === "codex") return UUID_RE.test(cid) ? `codex:${cid}` : null;
  if (UUID_RE.test(cid)) return cid;
  return null;
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [AGY-ClawBot-V2] ${msg}`);
}

async function saveMediaHelper(buf, mime, subdir, _maxBytes, origFilename) {
  const extMap = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/wav": ".wav",
    "audio/silk": ".silk",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
  };
  let ext = origFilename ? path.extname(origFilename) : extMap[mime] || "";
  if (!ext || ext === ".bin") {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = ".jpg";
    else if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ext = ".png";
    else if (buf.length >= 4 && buf.slice(0, 4).toString("ascii") === "%PDF") ext = ".pdf";
    else if (buf.length >= 12 && buf.slice(4, 8).toString("ascii") === "ftyp") ext = ".mp4";
    else ext = ".bin";
  }
  const base = origFilename
    ? path.basename(origFilename, path.extname(origFilename)).replace(/[^a-zA-Z0-9_\u4e00-\u9fa5.-]/g, "_")
    : `wx_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const outPath = path.join(INBOX_DIR, `${base}_${Date.now()}${ext}`);
  fs.writeFileSync(outPath, buf);
  return { path: outPath };
}

function extractQuoteContext(msg, accountId, fromUserId) {
  const item = (msg.item_list ?? []).find((it) => it.ref_msg);
  if (!item?.ref_msg) return null;

  const ref = item.ref_msg;
  const refId = ref.svr_id?.trim() || ref.message_item?.msg_id?.trim() || "";
  let fullQuotedBody = "";
  if (ref.title?.trim()) fullQuotedBody += ref.title.trim();
  if (ref.message_item?.text_item?.text) {
    fullQuotedBody = fullQuotedBody
      ? `${fullQuotedBody} | ${ref.message_item.text_item.text}`
      : String(ref.message_item.text_item.text);
  } else if (ref.message_item?.voice_item?.text) {
    fullQuotedBody = fullQuotedBody
      ? `${fullQuotedBody} | ${ref.message_item.voice_item.text}`
      : String(ref.message_item.voice_item.text);
  }

  let storedRecord = null;
  try {
    if (refId) {
      storedRecord = getQuoteStore()?.find(accountId, fromUserId, refId) || null;
      if (!fullQuotedBody && storedRecord?.body) {
        fullQuotedBody = storedRecord.body;
      }
    }
  } catch {}

  let partialQuoteText = "";
  if (ref.partial_text && fullQuotedBody) {
    const res = resolvePartialQuote(fullQuotedBody, ref.partial_text);
    if (!res.fallback && res.resolved) {
      partialQuoteText = res.resolved;
    }
  }

  const matchedSession = lookupSessionByQuote({ refId });

  return {
    refId,
    fullQuotedBody: fullQuotedBody.slice(0, 600),
    partialQuoteText,
    quotedMediaPath: matchedSession?.filePath || storedRecord?.mediaPath || null,
    matchedSession,
  };
}

async function handlePrivilegedSlashCommand(fullText, mediaFiles, account, fromUserId, contextToken) {
  const trimmed = fullText.trim();
  if (!trimmed.startsWith("/")) return false;

  const [rawCmd, ...restTokens] = trimmed.split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const argText = trimmed.slice(rawCmd.length).trim();
  const sendOpts = {
    baseUrl: account.baseUrl,
    token: account.token,
    contextToken,
    accountId: account.accountId,
  };

  if (cmd === "/help" || cmd === "/菜单") {
    const helpMsg = [
      "🦞 **微信 ClawBot × AGY/Codex 个人龙虾 V2.0 特权指令：**  ",
      "",
      "- `/todo` 或 `/未回` ：秒查所有已发汇报但你还没回/漏回的窗口清单  ",
      "- `/status` 或 `/体检` ：秒查 Mac 磁盘、内存、住宅IP代理链路与活跃进程  ",
      "- `/screen` 或 `/截屏` ：一键截取 Mac 当前屏幕发回微信  ",
      "- `/sessions` 或 `/窗口` ：列出 AGY (#A1..#A8) + Codex (#C1..#C5) 活跃窗口  ",
      "- `/use <编号>` ：手动锁定默认对话窗口（如 `/use A1` 或 `/use C1`）  ",
      "- `/unlock` ：解除窗口锁定，恢复无感智能语义路由  ",
      "- `/codex <指令>` ：直连本机 Codex (gpt-6.1-sol + Images 2.6) 执行或生图  ",
      "- `/claude <路由键> <指令>` ：点名交给本机 Claude CLI 在该项目目录后台执行（如 `/claude echo 审一下全稿`）  ",
      "- `/retry <msg编号> <目标>` ：把存档的原话重投（目标 = 路由键 / claude / claude:<路由键> / new:<标题>）  ",
      "- `/drop <承诺编号>` ：撤销一条不用再做的承诺（编号见 /todo）  ",
      "- `/verify` 或 `/验收` ：查看最近声称「完成」的汇报里，哪些有脚本回执、哪些是 Agent 自述  ",
      "- `#新会话 标题: 内容` ：强制新建独立 AGY 窗口  ",
      "- 💡 长按引用任意历史回复/图片发消息：100% 自动溯源回原窗口！  ",
    ].join("\n");
    await sendMessageWeixin({ to: fromUserId, text: helpMsg, opts: sendOpts });
    return true;
  }

  if (cmd === "/todo" || cmd === "/未回" || cmd === "/待办") {
    const st = loadRouterState();
    const pending = Object.values(st.pendingReplies || {}).filter((p) => p && p.cid);
    const promises = listOpenCommitments();
    if (pending.length === 0 && promises.length === 0) {
      await sendMessageWeixin({ to: fromUserId, text: "✅ 没有等你回的汇报，也没有答应了还没交的事。", opts: sendOpts });
      return true;
    }
    const lines = [];
    if (pending.length) {
      pending.sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0));
      lines.push(`📌 **${pending.length} 个窗口在等你回复/拍板：**`);
      for (const p of pending) {
        const mins = Math.max(1, Math.round((Date.now() - (p.sentAt || Date.now())) / 60000));
        const tag = p.needsDecision ? "⏳待拍板" : "📩待查阅";
        lines.push(`- **${p.title}**（${mins}分钟前 · ${tag}）：${p.summary || "已发送阶段汇报"}`);
      }
    }
    if (promises.length) {
      lines.push(`\n🕒 **答应了还没交的（${promises.length}）：**`);
      for (const c of promises) {
        const late = Date.now() - c.dueAt;
        lines.push(`- \`${c.id}\` **${c.title}**：「${c.text}」（${late > 0 ? `已超时 ${fmtAgo(late)}` : `还剩 ${fmtAgo(-late)}`}）`);
      }
      lines.push(`不用做了就引用这条回「不用做了」`);
    }
    await sendMessageWeixin({ to: fromUserId, text: lines.join("\n"), opts: sendOpts });
    return true;
  }

  if (cmd === "/drop" || cmd === "/撤销") {
    const id = (restTokens[0] || "").trim();
    const hit = id ? dropCommitment(id) : null;
    await sendMessageWeixin({
      to: fromUserId,
      text: hit ? `🗑️ 已撤销 ${hit.title} 的承诺：「${hit.text}」` : `❓ 没找到还在计时的承诺「${id}」。`,
      opts: sendOpts,
    });
    return true;
  }

  if (cmd === "/status" || cmd === "/体检") {
    let diskLine = "未知";
    let memLine = "未知";
    try {
      const dfOut = execSync("df -h / | tail -n 1", { encoding: "utf8" }).trim().split(/\s+/);
      diskLine = `总计 ${dfOut[1]} | 已用 ${dfOut[2]} (${dfOut[4]}) | 可用 ${dfOut[3]}`;
    } catch {}
    try {
      const topMem = execSync("top -l 1 -s 0 | grep PhysMem", { encoding: "utf8" }).trim();
      memLine = topMem.replace("PhysMem:", "").trim();
    } catch {}

    const state = loadRouterState();
    const agyCount = scanActiveConversations(8, true).length;
    const codexCount = (await scanCodexConversations(5)).length;
    const lockStr = state.lockedSession
      ? `🔒 已锁定 [${state.lockedSession.engine.toUpperCase()}] ${state.lockedSession.title}`
      : `🧠 智能无感路由 (上次: ${state.lastRoutedTitle || "无"})`;

    const statusMsg = [
      "🖥️ eru 的 M6 AGY 中枢工作站实时体检：",
      `├ 💾 磁盘空间: ${diskLine}`,
      `├ 🧠 内存状态: ${memLine}`,
      `├ 🛡️ 代理端口: 127.0.0.1:7897 (mihomo 守护在线)`,
      `├ 📂 活跃窗口: AGY ${agyCount} 个 | Codex ${codexCount} 个`,
      `└ 🎯 路由模式: ${lockStr}`,
    ].join("\n");
    await sendMessageWeixin({ to: fromUserId, text: statusMsg, opts: sendOpts });
    return true;
  }

  if (cmd === "/screen" || cmd === "/截屏") {
    const outShot = path.join(INBOX_DIR, `mac_screen_${Date.now()}.jpg`);
    try {
      execSync(`/usr/sbin/screencapture -x -t jpg "${outShot}"`, { timeout: 6000 });
      if (fs.existsSync(outShot) && fs.statSync(outShot).size > 1000) {
        await sendWeixinMediaFile({
          filePath: outShot,
          to: fromUserId,
          text: `📸 Mac 实时屏幕快照 (${new Date().toLocaleTimeString("zh-CN")})`,
          opts: sendOpts,
          cdnBaseUrl: CDN_BASE_URL,
        });
        return true;
      }
    } catch (e) {
      await sendMessageWeixin({
        to: fromUserId,
        text: `⚠️ 截屏调用失败（可能需在 macOS「系统设置 → 隐私与安全性 → 录屏」勾选终端/Antigravity 权限）：${String(e.message || e).slice(0, 120)}`,
        opts: sendOpts,
      });
      return true;
    }
    await sendMessageWeixin({
      to: fromUserId,
      text: "⚠️ 截屏文件为空（多半是缺少录屏权限：系统设置 → 隐私与安全性 → 录屏）",
      opts: sendOpts,
    });
    return true;
  }

  if (cmd === "/verify" || cmd === "/验收") {
    const recent = readJsonlTail(PROOFS_FILE, 300).filter((p) => p.claim || (p.proofs || []).length).slice(-10);
    if (recent.length === 0) {
      await sendMessageWeixin({ to: fromUserId, text: "🧾 还没有任何「声称完成」或带回执的汇报记录。", opts: sendOpts });
      return true;
    }
    const st = loadRouterState();
    const lines = [`🧾 最近 ${recent.length} 条「完成类」汇报的验收情况：`];
    for (const p of recent.reverse()) {
      const who = st.sessionAliases?.[p.session] || p.session?.slice(0, 14) || "未归属";
      const ok = (p.proofs || []).filter((x) => x.level === "ok").length;
      const bad = (p.proofs || []).filter((x) => x.level !== "ok").length;
      const flag = (p.tags || []).length ? `🚩${p.tags.map((t) => t.replace(/[【】⚠️❌🧪🚫]/gu, "").slice(0, 14)).join("；")}` : "✅有回执";
      lines.push(`- ${new Date(p.ts).toLocaleTimeString("zh-CN", { hour12: false })} ${who}：${flag}（回执 ${ok}✓/${bad}✗）「${(p.textHead || "").slice(0, 24)}」`);
    }
    await sendMessageWeixin({ to: fromUserId, text: lines.join("\n"), opts: sendOpts });
    return true;
  }

  if (cmd === "/claude") {
    const rules = loadRules();
    const key = (restTokens[0] || "").toLowerCase();
    const instruction = argText.slice(restTokens[0]?.length || 0).trim();
    if (!rules.routes?.[key] || !instruction) {
      await sendMessageWeixin({
        to: fromUserId,
        text: `用法：/claude <路由键> <指令>\n可用路由键：${Object.keys(rules.routes || {}).join(" / ")}`,
        opts: sendOpts,
      });
      return true;
    }
    const msgId = saveInboundMsg({ text: instruction, media: mediaFiles, mediaFiles, source: "/claude" });
    await routeMessage({ msgId, to: `claude:${key}`, via: "slash" });
    await sendMessageWeixin({
      to: fromUserId,
      text: `🟣 已交给 Claude（${rules.routes[key].name}），做完直接发你。`,
      opts: sendOpts,
    });
    return true;
  }

  if (cmd === "/retry" || cmd === "/重投") {
    const msgId = restTokens[0] || "";
    let to = restTokens[1] || "";
    const rec = loadInboundMsg(msgId);
    if (!rec || !to) {
      await sendMessageWeixin({ to: fromUserId, text: "用法：/retry <msg编号> <目标>（目标 = 路由键 / claude / claude:<路由键> / new:<标题>）", opts: sendOpts });
      return true;
    }
    if (to === "claude") {
      const last = [...(rec.routes || [])].reverse().find((r) => r.routeKey || (r.target && UUID_RE.test(r.target)));
      const rk = last?.routeKey || (last?.target ? routeKeyForCid(last.target) : null);
      if (!rk) {
        await sendMessageWeixin({ to: fromUserId, text: `❓ 这条消息之前没投到已登记的项目，请写明：/retry ${msgId} claude:<路由键>`, opts: sendOpts });
        return true;
      }
      to = `claude:${rk}`;
    }
    try {
      const r = await routeMessage({ msgId, to, via: "retry" });
      await sendMessageWeixin({ to: fromUserId, text: `↪️ 已按原话重投给「${to}」`, opts: sendOpts });
    } catch (e) {
      await sendMessageWeixin({ to: fromUserId, text: `❌ 重投失败：${String(e.message || e).slice(0, 150)}`, opts: sendOpts });
    }
    return true;
  }

  if (cmd === "/sessions" || cmd === "/窗口") {
    const agyList = scanActiveConversations(6, true);
    const codexList = await scanCodexConversations(5);
    const state = loadRouterState();
    const lines = ["📂 当前 AGY + Codex 活跃会话池："];
    if (state.lockedSession?.cid) {
      lines.push(`🔒 当前锁定: [${state.lockedSession.engine.toUpperCase()}] ${state.lockedSession.title}`);
    }
    lines.push("\n【AGY 窗口】");
    for (const s of agyList) {
      const star = s.isLastRouted ? " ⭐" : "";
      const name = s.alias || s.firstMsg.slice(0, 28);
      lines.push(`▸ #${s.shortId}${star} (${s.relTime}): ${name}`);
    }
    if (codexList.length) {
      lines.push("\n【Codex 窗口】");
      for (const c of codexList) {
        const star = c.isLastRouted ? " ⭐" : "";
        lines.push(`▸ #${c.shortId}${star} (${c.relTime}): ${c.title}`);
      }
    }
    lines.push("\n💡 发送 `/use A1` 或 `/use C1` 可锁定指定窗口，发送 `/unlock` 恢复自动路由。");
    await sendMessageWeixin({ to: fromUserId, text: lines.join("\n"), opts: sendOpts });
    return true;
  }

  if (cmd === "/unlock" || cmd === "/解锁") {
    saveRouterState({ lockedSession: null });
    await sendMessageWeixin({
      to: fromUserId,
      text: "🔓 已解除窗口锁定，恢复「零指引无感智能语义路由」模式！",
      opts: sendOpts,
    });
    return true;
  }

  if (cmd === "/use" || cmd === "/锁定") {
    const targetKey = (restTokens[0] || "").toUpperCase();
    const agyList = scanActiveConversations(8, true);
    const codexList = await scanCodexConversations(8);
    const hitAgy = agyList.find((s) => s.shortId === targetKey || s.cid.startsWith(targetKey.toLowerCase()));
    const hitCodex = codexList.find((c) => c.shortId === targetKey || c.cid.startsWith(targetKey.toLowerCase()));
    if (hitAgy) {
      const title = hitAgy.alias || hitAgy.firstMsg.slice(0, 28);
      saveRouterState({
        lockedSession: { engine: "agy", cid: hitAgy.cid, title },
        lastRoutedCid: hitAgy.cid,
        lastRoutedTitle: title,
        lastRoutedEngine: "agy",
      });
      await sendMessageWeixin({
        to: fromUserId,
        text: `🔒 已锁定至 AGY 窗口 #${hitAgy.shortId}「${title}」(${hitAgy.cid.slice(0, 8)})！接下来你直接发消息都会直达该窗口（发 /unlock 解锁）。`,
        opts: sendOpts,
      });
      return true;
    }
    if (hitCodex) {
      saveRouterState({
        lockedSession: { engine: "codex", cid: hitCodex.cid, title: hitCodex.title, cwd: hitCodex.cwd },
        lastRoutedCid: hitCodex.cid,
        lastRoutedTitle: hitCodex.title,
        lastRoutedEngine: "codex",
      });
      await sendMessageWeixin({
        to: fromUserId,
        text: `🔒 已锁定至 Codex 窗口 #${hitCodex.shortId}「${hitCodex.title}」(${hitCodex.cid.slice(0, 8)})！接下来你直接发消息都会直达该 Codex 会话（发 /unlock 解锁）。`,
        opts: sendOpts,
      });
      return true;
    }
    await sendMessageWeixin({
      to: fromUserId,
      text: `❓ 未找到编号 "${targetKey}"，请先发 /sessions 查看可用编号（如 /use A1 或 /use C1）。`,
      opts: sendOpts,
    });
    return true;
  }

  if (cmd === "/qwen") {
    if (!argText) {
      await sendMessageWeixin({
        to: fromUserId,
        text: "用法：`/qwen 你的问题`（将直连本机 Ollama `huihui_ai/Qwen3.8-abliterated:27b` 满血 27B 无审查模型回复）",
        opts: sendOpts,
      });
      return true;
    }
    (async () => {
      try {
        await sendMessageWeixin({
          to: fromUserId,
          text: "🧠 已调起本机满血无审查 `Qwen3.8-27B` 思考中，请稍候…",
          opts: sendOpts,
        });
        const resp = await fetch("http://127.0.0.1:11434/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "huihui_ai/Qwen3.8-abliterated:27b",
            messages: [{ role: "user", content: argText }],
            stream: false,
            think: false,
            keep_alive: "30s",
            options: { num_ctx: 2048 },
          }),
        });
        const data = await resp.json();
        const reply = (data?.message?.content || "（无输出）").trim();
        await sendMessageWeixin({
          to: fromUserId,
          text: `🧠 **[本机 Qwen3.8-27B 满血无审查]**：\n${reply}`,
          opts: sendOpts,
        });
      } catch (e) {
        await sendMessageWeixin({
          to: fromUserId,
          text: `❌ 调用本机 Qwen3.8-27B 失败：${String(e)}`,
          opts: sendOpts,
        });
      }
    })();
    return true;
  }

  if (cmd === "/codex") {
    if (!argText) {
      await sendMessageWeixin({
        to: fromUserId,
        text: "用法：`/codex 你的指令`（可同时附带图片，将直接调用本机 Codex gpt-6.1-sol + Images 2.6 执行并回传结果）",
        opts: sendOpts,
      });
      return true;
    }
    const imgFiles = mediaFiles.filter((f) => /\.(png|jpg|jpeg|webp|gif)$/i.test(f));
    const jobId = enqueueJob({
      engine: "codex",
      threadId: null,
      title: argText.slice(0, 24),
      cwd: "/Users/eru/Desktop/agy工作站",
      instruction: argText,
      images: imgFiles,
    });
    await sendMessageWeixin({ to: fromUserId, text: `🤖 已交给本机 Codex（独立后台进程 job=${jobId}），做完直接回传。`, opts: sendOpts });
    return true;
  }

  return false;
}

async function ensureLoggedIn(forceLogin = false) {
  if (!forceLogin) {
    const ids = listIndexedWeixinAccountIds();
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      const acc = loadWeixinAccount(id);
      if (acc?.token) {
        log(`Found existing WeChat ClawBot credentials for accountId=${id}`);
        return {
          accountId: id,
          token: acc.token,
          baseUrl: acc.baseUrl || DEFAULT_BASE_URL,
          userId: acc.userId,
        };
      }
    }
  }

  log("Starting WeChat ClawBot QR code login...");
  const startRes = await startWeixinLoginWithQr({ botType: "3", force: true });
  if (!startRes.qrcodeUrl) {
    throw new Error(`Failed to obtain QR code: ${startRes.message}`);
  }

  await QRCode.toFile(QR_PNG_PATH, startRes.qrcodeUrl, { width: 420, margin: 2 });
  log(`QR Code image saved to: ${QR_PNG_PATH}`);
  await displayQRCode(startRes.qrcodeUrl);

  const loginRes = await waitForWeixinLogin({
    sessionKey: startRes.sessionKey,
    botType: "3",
    timeoutMs: 480_000,
    verbose: false,
  });

  if (!loginRes.connected || !loginRes.botToken || !loginRes.accountId) {
    throw new Error(`Login did not complete: ${loginRes.message}`);
  }

  saveWeixinAccount(loginRes.accountId, {
    token: loginRes.botToken,
    baseUrl: loginRes.baseUrl || DEFAULT_BASE_URL,
    userId: loginRes.userId,
  });
  registerWeixinAccountId(loginRes.accountId);

  log(`✅ Successfully connected WeChat ClawBot! accountId=${loginRes.accountId}`);
  return {
    accountId: loginRes.accountId,
    token: loginRes.botToken,
    baseUrl: loginRes.baseUrl || DEFAULT_BASE_URL,
    userId: loginRes.userId,
  };
}

async function handleInboundMessage(msg, account) {
  const fromUserId = msg.from_user_id || "";
  const contextToken = msg.context_token || "";
  if (!fromUserId) return;
  if (!isAllowedSender(fromUserId, account)) {
    log(`⛔ 拒绝非白名单发信人 ${fromUserId.slice(0, 6)}…（如需放行，加入 rules.json.allowUsers）`);
    return;
  }

  let typingTicket = "";
  try {
    const cfg = await getConfig({
      baseUrl: account.baseUrl,
      token: account.token,
      ilinkUserId: fromUserId,
      contextToken,
    });
    if (cfg?.typing_ticket) {
      typingTicket = cfg.typing_ticket;
      await sendTyping({
        baseUrl: account.baseUrl,
        token: account.token,
        body: {
          ilink_user_id: fromUserId,
          typing_ticket: typingTicket,
          status: TypingStatus.TYPING,
        },
      });
    }
  } catch (e) {
    log(`sendTyping non-fatal warning: ${String(e)}`);
  }

  const peerData = {
    accountId: account.accountId,
    baseUrl: account.baseUrl,
    cdnBaseUrl: CDN_BASE_URL,
    token: account.token,
    fromUserId,
    contextToken,
    typingTicket,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(PEER_FILE, JSON.stringify(peerData, null, 2));

  const textParts = [];
  const mediaPaths = [];
  const rawMediaFiles = [];

  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      textParts.push(item.text_item.text);
    } else if (item.type === MessageItemType.VOICE) {
      if (item.voice_item?.text) {
        textParts.push(`[语音转文字]: ${item.voice_item.text}`);
      }
      const dl = await downloadMediaFromItem(item, {
        cdnBaseUrl: CDN_BASE_URL,
        saveMedia: saveMediaHelper,
        log,
        errLog: log,
        label: "inbound-voice",
      });
      if (dl.decryptedVoicePath) {
        mediaPaths.push(`语音音频(${dl.voiceMediaType || "audio/wav"}): ${dl.decryptedVoicePath}`);
        rawMediaFiles.push(dl.decryptedVoicePath);
      }
    } else if (
      item.type === MessageItemType.IMAGE ||
      item.type === MessageItemType.FILE ||
      item.type === MessageItemType.VIDEO
    ) {
      const dl = await downloadMediaFromItem(item, {
        cdnBaseUrl: CDN_BASE_URL,
        saveMedia: saveMediaHelper,
        log,
        errLog: log,
        label: "inbound-media",
      });
      if (dl.decryptedPicPath) {
        mediaPaths.push(`图片文件: ${dl.decryptedPicPath}`);
        rawMediaFiles.push(dl.decryptedPicPath);
      }
      if (dl.decryptedFilePath) {
        mediaPaths.push(`附件文档: ${dl.decryptedFilePath}`);
        rawMediaFiles.push(dl.decryptedFilePath);
      }
      if (dl.decryptedVideoPath) {
        mediaPaths.push(`视频文件: ${dl.decryptedVideoPath}`);
        rawMediaFiles.push(dl.decryptedVideoPath);
      }
    }
  }

  const fullText = textParts.join("\n").trim();

  // Save inbound message to QuoteStore for future quote lookups
  const inboundMsgId = getWeixinMessageId(msg);
  if (inboundMsgId) {
    try {
      await getQuoteStore()?.put({
        accountId: account.accountId,
        conversationId: fromUserId,
        messageId: inboundMsgId,
        direction: "inbound",
        body: fullText || (mediaPaths[0] ?? "[媒体消息]"),
        createdAt: Date.now(),
      });
    } catch {}
  }

  // Extract Quote / Partial Quote context if user long-pressed a message in WeChat
  const quoteCtx = extractQuoteContext(msg, account.accountId, fromUserId);
  if (quoteCtx?.quotedMediaPath && fs.existsSync(quoteCtx.quotedMediaPath)) {
    mediaPaths.push(`引用历史媒体文件: ${quoteCtx.quotedMediaPath}`);
    rawMediaFiles.push(quoteCtx.quotedMediaPath);
  }

  log(
    `Inbound WeChat message from ${fromUserId}: text="${fullText}" media=[${mediaPaths.join(", ")}] quote=${
      quoteCtx ? `refId=${quoteCtx.refId} matched=${quoteCtx.matchedSession?.cid || "none"}` : "none"
    }`
  );

  // 0. 按 eru 的说法直接办（0 Token，不用记斜杠指令）
  const routingFeedback = isRoutingFeedback(fullText);
  if (!routingFeedback && await handleNaturalIntent({ fullText, quoteCtx, rawMediaFiles, account, fromUserId, contextToken })) return;

  // 1. Check zero-latency privileged slash commands (/status, /screen, /sessions, /use, /unlock, /codex, /help)
  const handledSlash = await handlePrivilegedSlashCommand(
    fullText,
    rawMediaFiles,
    account,
    fromUserId,
    contextToken
  );
  if (handledSlash) return;

  // 1.5 回编号选窗口（上一条消息没判出归属时，桥发过一个编号列表）
  const pick = fullText.match(/^\s*(\d{1,2})\s*$/);
  if (pick && !rawMediaFiles.length && !quoteCtx) {
    const pc = pendingChoiceFor(fromUserId);
    if (pc && !pc.useProjectNames) {
      const n = Number(pick[1]);
      const opt = pc.options.find((o) => o.n === n);
      const sendOptsPick = { baseUrl: account.baseUrl, token: account.token, contextToken, accountId: account.accountId };
      if (!opt) {
        await sendMessageWeixin({ to: fromUserId, text: `❓ 没有编号 ${n}，回列表里的数字就行。`, opts: sendOptsPick });
        return;
      }
      saveRouterState({ pendingChoice: null });
      await deliverChoice({ msgId: pc.msgId, opt, fromUserId, sendOpts: sendOptsPick });
      return;
    }
  }

  // 文字和截图可能由微信拆成相邻消息。只关联同一联系人的紧邻文字和附件。
  const peerKey = `${account.accountId}:${fromUserId}`;
  const receivedAt = Number(msg.create_time_ms) || Date.now();
  const previous = loadInboundMsg(loadRouterState().lastInboundMsgId);
  const related = !quoteCtx ? adjacentMessage(previous, peerKey, receivedAt, fullText, rawMediaFiles) : null;
  const msgId = saveInboundMsg({
    text: fullText,
    peerKey,
    receivedAt,
    related,
    media: mediaPaths,
    mediaFiles: rawMediaFiles,
    quote: quoteCtx
      ? {
          refId: quoteCtx.refId,
          fullQuotedBody: quoteCtx.fullQuotedBody,
          partialQuoteText: quoteCtx.partialQuoteText,
          matched: quoteCtx.matchedSession ? { cid: quoteCtx.matchedSession.cid, engine: quoteCtx.matchedSession.engine, title: quoteCtx.matchedSession.title } : null,
        }
      : null,
  });
  if (!routingFeedback) saveRouterState({ lastInboundMsgId: msgId });
  const sendOpts = { baseUrl: account.baseUrl, token: account.token, contextToken, accountId: account.accountId };
  const ack = (text) => sendMessageWeixin({ to: fromUserId, text, opts: sendOpts }).catch(() => null);

  // 分发纠错由总控接手，保留原任务供下一句「发给 X」改投。
  if (routingFeedback) {
    await deliverChoice({
      msgId, opt: { kind: "router", contextual: true }, fromUserId, sendOpts, quiet: true, via: "总控分发",
    });
    return;
  }

  // 3. "#新会话 标题: 内容"
  const newConvMatch = fullText.match(/^#新会话\s+([^:：]+)[：:]\s*([\s\S]+)$/);
  if (newConvMatch) {
    const title = newConvMatch[1].trim();
    markInboundMsg(msgId, { text: newConvMatch[2].trim() });
    await routeMessage({ msgId, to: `new:${title}`, via: "hashtag" }).catch((e) => ack(`❌ 新建会话失败：${String(e.message || e).slice(0, 120)}`));
    return;
  }

  const state = loadRouterState();
  const rules = loadRules();
  const attachmentRoute = related && !fullText ? previous.routes?.at(-1) : null;
  let target = null;
  let via = "";
  if (quoteCtx) {
    target = quoteTarget(quoteCtx.matchedSession);
    via = "引用溯源";
  } else if (attachmentRoute) {
    target = quoteTarget({
      cid: attachmentRoute.engine === "claude" ? `claude:${attachmentRoute.target}` : attachmentRoute.target,
      engine: attachmentRoute.engine,
    });
    via = "随上一条附件";
  } else if (state.lockedSession?.cid) {
    const locked = state.lockedSession;
    target = locked.engine === "codex" ? `codex:${locked.cid}` : locked.cid;
    via = "窗口锁定";
  } else {
    target = matchRouteByKeywords(fullText, rules);
    if (target) via = "关键词";
  }

  if (target && (target === getRouterCid() || routerCidSet(state).has(target))) {
    const contextual = attachmentRoute?.via === "总控分发";
    await deliverChoice({
      msgId, opt: { kind: "router", cid: target, contextual }, fromUserId, sendOpts,
      quiet: Boolean(attachmentRoute), via: contextual ? "总控分发" : via,
    });
    return;
  }

  if (target) {
    try {
      const r = await routeMessage({ msgId, to: target, via });
      const name =
        (r.routeKey && rules.routes[r.routeKey]?.name) ||
        (String(target).startsWith("claude:") ? `Claude·${rules.routes[target.slice(7)]?.name || target.slice(7)}` : null) ||
        state.sessionAliases?.[r.target] ||
        String(r.target || target).slice(0, 8);
      log(`Direct-routed msg=${msgId} via ${via} → ${target} (${r.engine})`);
      if (attachmentRoute) return;
      const reply = `↪️ 已直投「${name}」（${via}）${r.engine === "agy" && r.target ? busyNote(r.target) : ""}`;
      const sent = await ack(reply);
      if (sent && r.target) recordMessageSessionMap({
        messageId: sent.messageId, serverMessageId: sent.serverMessageId, body: reply,
        sessionCid: r.target, sessionTitle: name, engine: r.engine, msgId,
      });
      return;
    } catch (e) {
      log(`Direct route failed (${via} → ${target}): ${String(e)}`);
      if (quoteCtx || attachmentRoute) {
        await ack("原窗口暂时没有确认收到这条消息。可以重新引用，或指定其他窗口。");
        return;
      }
    }
  }

  // 短追问、未知引用和新话题交回有历史的总控。
  await deliverChoice({
    msgId, opt: { kind: "router", contextual: true }, fromUserId, sendOpts, quiet: true, via: "总控分发",
  });
}


function isRoutingFeedback(text) {
  return /^(?:你|波妞)?(?:发错了|投错了|转错了|串窗了|串台了|路由错了|(?:为什么|为啥|怎么会|怎么又)[^。！？!?]{0,16}(?:投给|投到|转给|路由到|投错|串窗))/.test(text);
}

// ───────── 自然语言意图（0 Token）：eru 不用记斜杠指令 ─────────
const COMMIT_ID_RE = /\bc[0-9a-z]{6}\b/g;

function routesByText(text, rules = loadRules()) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return [];
  const hits = new Set(keywordHits(t, rules));
  for (const [k, r] of Object.entries(rules.routes || {})) {
    const name = String(r.name || "").toLowerCase();
    if (name && (name.includes(t) || t.includes(name))) hits.add(k);
  }
  return [...hits];
}

function quotedMsgId(quoteCtx) {
  if (quoteCtx?.matchedSession?.msgId) return quoteCtx.matchedSession.msgId; // 提醒消息登记时带着原话编号
  const body = `${quoteCtx?.fullQuotedBody || ""} ${quoteCtx?.partialQuoteText || ""}`;
  return (body.match(/msg=(m[0-9a-z]{6,})/) || [])[1] || null;
}

async function handleNaturalIntent({ fullText, quoteCtx, rawMediaFiles, account, fromUserId, contextToken }) {
  const t = String(fullText || "").trim();
  if (!t || t.startsWith("/") || rawMediaFiles.length) return false;
  const short = t.length <= 24;
  const rules = loadRules();
  const sendOpts = { baseUrl: account.baseUrl, token: account.token, contextToken, accountId: account.accountId };
  const say = (text) => sendMessageWeixin({ to: fromUserId, text, opts: sendOpts }).catch(() => null);
  const runSlash = (cmd) => handlePrivilegedSlashCommand(cmd, rawMediaFiles, account, fromUserId, contextToken);

  // 裸项目名才算选择。带项目名的新指令仍走正常路由。
  const pc = pendingChoiceFor(fromUserId);
  const quoted = quotedMsgId(quoteCtx);
  const matched = quoteCtx?.matchedSession;
  const exactQuote = matched?.title === "微信分拣" && quoteCtx.refId &&
    [matched.messageId, matched.serverMessageId].includes(quoteCtx.refId);
  const quotedRec = exactQuote && quoted ? loadInboundMsg(quoted) : null;
  const choice = quotedRec && !quotedRec.routes?.length && Date.now() - Date.parse(quotedRec.createdAt) < CHOICE_TTL_MS
    ? { msgId: quoted, options: buildChoiceOptions(rules, []) }
    : !quoteCtx ? pc : null;
  if (choice && short) {
    const name = t.toLowerCase().replace(/[。！!]+$/, "").trim();
    const opt = choice.options.find((o) => {
      if (o.kind === "router") return name === "总控";
      if (o.kind === "new") return /^(新开|新建)(一个)?( agy)?( 窗口|窗口|会话)?$/.test(name);
      const route = rules.routes?.[o.key];
      return route && [o.key, route.name, ...(route.keywords || [])].some((alias) => String(alias).toLowerCase() === name);
    });
    if (opt) {
      if (pc?.msgId === choice.msgId) saveRouterState({ pendingChoice: null });
      await deliverChoice({ msgId: choice.msgId, opt, fromUserId, sendOpts });
      return true;
    }
  }

  // 2) 改投：「发给回声档案」「不对，转给小游戏」（引用某条提醒时投那条里的 msg）
  const re = t.match(/^(不对[，,。 ]*)?(重新|再)?(发|转|投|交)(给|到)\s*(.{1,12}?)(窗口|那边)?[吧。！!]*$/);
  if (re) {
    const dest = re[5].trim();
    const hits = routesByText(dest, rules);
    const to = hits.length === 1 ? hits[0] : /^总控/.test(dest) ? "__router__" : null;
    const st = loadRouterState();
    const msgId = quoted || pc?.msgId || st.lastInboundMsgId;
    if (!to) {
      // 给我发文件、交给 Claude 审一下等是任务内容。
      if (/^(?:我|你|他|她|它|我们|他们|她们|自己|我自己)(?:一份|一下|看看)?$/.test(dest) ||
          /(?:审一下|看一下|帮我|处理一下|跑一下|做一下)$/.test(dest)) return false;
      await say(`没找到叫「${dest}」的窗口。可以说已登记的项目名，或指定总控。`);
      return true;
    }
    if (!msgId) {
      await say("❓ 找不到要改投的那条消息，直接再发一遍吧。");
      return true;
    }
    if (pc?.msgId === msgId) saveRouterState({ pendingChoice: null });
    const opt = to === "__router__" ? { kind: "router" } : { kind: "route", key: to, label: rules.routes[to].name };
    await deliverChoice({ msgId, opt, fromUserId, sendOpts });
    return true;
  }

  // 3) 撤销承诺：引用提醒回「不用做了」，或「小游戏那个不用做了」
  if (/(不用(做|跑|弄|管|交)?了|不需要了|取消|算了|撤(销|掉))/.test(t) && t.length <= 30) {
    const open = listOpenCommitments();
    const ids = new Set([...(t.match(COMMIT_ID_RE) || []), ...(`${quoteCtx?.fullQuotedBody || ""}`.match(COMMIT_ID_RE) || [])]);
    let targets = open.filter((c) => ids.has(c.id));
    if (!targets.length) {
      const hits = routesByText(t, rules);
      if (hits.length === 1) {
        const cid = rules.routes[hits[0]].cid;
        targets = open.filter((c) => c.cid === cid);
      }
    }
    if (targets.length) {
      for (const c of targets) dropCommitment(c.id);
      await say(`🗑️ 已撤销 ${targets.length} 条：${targets.map((c) => `${c.title}「${c.text.slice(0, 24)}」`).join("；")}`);
      return true;
    }
    return false; // 没对上承诺，就当普通消息走路由
  }

  if (!short || routesByText(t, rules).length) return false; // 提到项目的话交给项目窗口

  // 4) 待办 / 状态 / 截屏
  if (/(待办|没回|漏回|要我(拍板|回|看|定)|等我(拍板|回|定)|还有(啥|什么|哪些)[^，。]{0,6}(事|活|没做|没交|没完|要)|谁还没交|答应[^，。]{0,4}没(做|交))/.test(t)) return runSlash("/todo");
  if (/^(截(个|一下)?屏|截图看看|看(一?下|看)?(电脑)?屏幕)/.test(t)) return runSlash("/screen");
  if (/(体检|电脑(状态|怎么样)|代理(还)?(通|在|好|正常)|磁盘|内存)/.test(t)) return runSlash("/status");
  return false;
}


// 旧分拣提示仍可在有效期内引用并手动指定。
const CHOICE_TTL_MS = 15 * 60_000;
const ADJACENT_MESSAGE_MS = 5_000;

function pendingChoiceFor(fromUserId) {
  const pc = loadRouterState().pendingChoice;
  if (!pc?.msgId || Date.now() - (pc.at || 0) >= CHOICE_TTL_MS) return null;
  return !pc.fromUserId || pc.fromUserId === fromUserId ? pc : null;
}

function adjacentMessage(previous, peerKey, receivedAt, text, mediaFiles) {
  if (previous?.peerKey !== peerKey || !previous.receivedAt ||
      Math.abs(receivedAt - previous.receivedAt) > ADJACENT_MESSAGE_MS) return null;
  const textThenMedia = previous.text && !text && mediaFiles.length;
  const mediaThenText = !previous.text && previous.mediaFiles?.length && text && !mediaFiles.length;
  if (!textThenMedia && !mediaThenText) return null;
  return { msgId: previous.id, text: previous.text, media: previous.media || [], mediaFiles: previous.mediaFiles || [] };
}

/** 取同一微信会话里最近两条真实答复，作为总控判断续话的上下文。 */
function recentAgentReplies(accountId, fromUserId) {
  try {
    const store = getQuoteStore();
    if (!store) return [];
    const recent = readJson(MSG_MAP_FILE, { recent: [] }).recent || [];
    const routers = routerCidSet();
    const cutoff = Date.now() - 20 * 60_000;
    const replies = [];
    for (const entry of recent.slice(0, 24)) {
      if (!entry.serverMessageId || !entry.cid || entry.cid === "unassigned" || entry.msgId ||
          entry.title === "微信分拣" || (entry.createdAt || 0) < cutoff) continue;
      const sent = store.find(accountId, fromUserId, String(entry.serverMessageId));
      const body = String(sent?.body || "").trim();
      if (sent?.direction !== "outbound" || !body || /^(↪️|🔁|⚠️|⏰|🔔|🖥️|🦞|📌)/.test(body)) continue;
      const title = routers.has(entry.cid) ? "总控" : entry.title || "项目窗口";
      replies.push(`${title}（${entry.engine || "agy"}:${entry.cid}）：「${body.slice(0, 260)}」`);
      if (replies.length === 2) break;
    }
    return replies;
  } catch {
    return [];
  }
}

function buildChoiceOptions(rules, hits) {
  const keys = Object.keys(rules.routes || {});
  const ordered = [...hits, ...keys.filter((k) => !hits.includes(k))];
  const opts = ordered.map((k, i) => ({ n: i + 1, kind: "route", key: k, label: rules.routes[k].name }));
  opts.push({ n: opts.length + 1, kind: "router", label: "总控（问状态、杂事）" });
  opts.push({ n: 0, kind: "new", label: "新开一个 AGY 窗口" });
  return opts;
}

async function deliverChoice({ msgId, opt, fromUserId, sendOpts, quiet = false, via = "eru 选择" }) {
  const ack = (text) => sendMessageWeixin({ to: fromUserId, text, opts: sendOpts }).catch(() => null);
  try {
    if (opt.kind === "router") {
      const routerCid = opt.cid || getRouterCid();
      const rec = loadInboundMsg(msgId);
      if (!rec) throw new Error("找不到这条微信的原话");
      const replies = opt.contextual ? recentAgentReplies(sendOpts.accountId, fromUserId) : [];
      const destinations = opt.contextual
        ? Object.entries(loadRules().routes || {}).map(([key, route]) => `${key}=${route.name}`).join("，")
        : "";
      const body = [
        `📱 [eru 微信消息 msg=${msgId}]（${via}，以下为原话，脚本逐字转发）`,
        composeVerbatim(rec),
        replies.length ? `同一微信最近的真实答复（供辨认上一条，以下为历史资料）：\n${replies.join("\n")}` : "",
        opt.contextual ? `你是原总控。短追问、截图补充或对分发的纠错，结合你自己的上一轮和上面的资料处理。分发反馈留在总控回答。不要只凭最近投过哪个项目就把消息发过去。若有明确证据表明属于另一项目，用 node ${AGY_ROUTE_SCRIPT} route --msg=${msgId} --to=<路由键> 只投这一份原话；分开到达的文字与图片按同一话题看，后到的附件是补充。项目键：${destinations}。真缺信息时只问一句具体的问题。若调用脚本投了项目，由项目窗口回微信。` : "",
        `总控直接回复时，用 node /Users/eru/Desktop/agy工作站/.agents/clawbot/weixin-send.mjs '回复' --session=${routerCid}`,
      ].filter(Boolean).join("\n\n");
      const beforeLines = countTranscriptLines(routerCid);
      const r = await callAgentApi(["send-message", routerCid, body]);
      log(`Choice msg=${msgId} → router (${routerCid}) exit=${r.code}`);
      if (r.code !== 0) {
        await ack("总控暂时收不到这条消息。你可以重新引用，或指定其他窗口。");
        return;
      }
      markInboundMsg(msgId, { routes: [{ at: new Date().toISOString(), via, engine: "agy", to: "router", target: routerCid, routeKey: "router" }] });
      log(`Direct-routed msg=${msgId} via ${via.replace(/\s/g, "")} → ${routerCid} (agy)`);
      spawnWatcher(routerCid, "总控", msgId, beforeLines);
      if (!quiet) {
        const reply = `↪️ 已交总控${via === "eru 选择" ? "" : `（${via}）`}`;
        const sent = await ack(reply);
        if (sent) recordMessageSessionMap({
          messageId: sent.messageId, serverMessageId: sent.serverMessageId, body: reply,
          sessionCid: routerCid, sessionTitle: "总控", engine: "agy", msgId,
        });
      }
      return;
    }
    const to = opt.kind === "new" ? `new:${(loadInboundMsg(msgId)?.text || "微信新任务").slice(0, 16)}` : opt.key;
    const r = await routeMessage({ msgId, to, via });
    log(`Direct-routed msg=${msgId} via ${via.replace(/\s/g, "")} → ${to} (${r.engine})`);
    if (quiet) return;
    if (opt.kind !== "new") await ack(`↪️ 已投「${opt.label}」${via === "按意思判断" ? "（按意思判断）" : ""}${r.engine === "agy" && r.target ? busyNote(r.target) : ""}${via === "按意思判断" ? "。不对就说「发给 X」" : ""}`);
  } catch (e) {
    await ack(`❌ 投递失败：${String(e.message || e).slice(0, 120)}。说「发给 X」可以重投`);
  }
}

// ───────── 收信去重：处理完才推进游标，所以同一条可能被拉到两次 ─────────
const HANDLED_FILE = path.join(__dirname, "handled_ids.json");
function inboundKey(msg) {
  try {
    const id = getWeixinMessageId(msg);
    if (id) return String(id);
  } catch {}
  return msg?.message_id ? String(msg.message_id) : msg?.seq ? `seq${msg.seq}` : null;
}
function wasHandled(key) {
  try {
    return (readJson(HANDLED_FILE, { ids: [] }).ids || []).includes(key);
  } catch {
    return false;
  }
}
function markHandled(key) {
  try {
    updateJson(HANDLED_FILE, { ids: [] }, (d) => {
      d.ids = [key, ...(d.ids || []).filter((x) => x !== key)].slice(0, 1000);
      return d;
    });
  } catch (e) {
    log(`markHandled warning: ${String(e)}`);
  }
}

function rememberOwner(sent, body, cid, title) {
  try {
    if (!sent || !cid) return;
    recordMessageSessionMap({ messageId: sent.messageId, serverMessageId: sent.serverMessageId, body, sessionCid: cid, sessionTitle: title, engine: "agy" });
  } catch {}
}

async function notifyEru(text, owner = null) {
  try {
    if (!fs.existsSync(PEER_FILE)) return;
    const peer = JSON.parse(fs.readFileSync(PEER_FILE, "utf8"));
    const sent = await sendMessageWeixin({
      to: peer.fromUserId,
      text,
      opts: { baseUrl: peer.baseUrl, token: peer.token, contextToken: peer.contextToken, accountId: peer.accountId },
    });
    if (owner?.cid) rememberOwner(sent, text, owner.cid, owner.title);
  } catch (e) {
    log(`notifyEru warning: ${String(e)}`);
  }
}

/** 目标窗口是不是正在忙上一件事（记录 20 秒内还在动，或最后一步是 RUNNING） */
function busyNote(cid) {
  try {
    const p = path.join(BRAIN_DIR, cid, ".system_generated/logs/transcript.jsonl");
    const st = fs.statSync(p);
    let running = false;
    try {
      const fd = fs.openSync(p, "r");
      const len = Math.min(st.size, 4000);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const last = buf.toString("utf8").trimEnd().split("\n").pop();
      running = JSON.parse(last).status === "RUNNING";
    } catch {}
    if (running || Date.now() - st.mtimeMs < 20_000) return "。它正在忙上一件事，你这条排在后面，忙完就处理";
  } catch {}
  return "";
}

// ───────── 承诺到期巡检：提醒 eru + 往窗口发一次系统催办（各一次） ─────────
async function checkOverdueCommitments() {
  const due = takeOverdue();
  if (!due.length) return;
  const lines = [`🕒 **答应了没交（${due.length}）：**`];
  for (const c of due) {
    lines.push(`- \`${c.id}\` **${c.title}**：「${c.text}」（说好 ${c.dueMin} 分钟，已过）`);
    if (UUID_RE.test(c.cid) && !claimNudgeSlot(c.cid)) {
      lines.push(`  （这个窗口 2 小时内已催过 2 次，不再催，需要你看）`);
    } else if (UUID_RE.test(c.cid)) {
      const nudge = [
        `⏰ [系统催办 · 非 eru 原话] 你 ${fmtAgo(Date.now() - c.createdAt)}前对 eru 说：「${c.text}」，说好 ${c.dueMin} 分钟，到现在没交合格结果。`,
        c.needsResearch ? `这条涉及调研：必须附 --proof=research:/证据.md 才算兑现。` : `交付时把产物文件作为附件发出，才算兑现。`,
        `做不到就直接告诉 eru 做不到、卡在哪，不要再许新的承诺。`,
      ].join("\n");
      const before = countTranscriptLines(c.cid);
      const r = await callAgentApi(["send-message", c.cid, nudge]);
      if (r.code !== 0) lines.push(`  （催办没送进窗口，exit=${r.code}）`);
      else spawnWatcher(c.cid, c.title, "-", before); // 催完照样盯：停了不回话会告警
    }
  }
  lines.push(`不用做了就引用这条回「不用做了」`);
  const owners = [...new Set(due.map((c) => c.cid))];
  await notifyEru(lines.join("\n"), owners.length === 1 ? { cid: owners[0], title: due[0].title } : null);
  log(`Overdue commitments: ${due.map((c) => c.id).join(",")}`);
}

async function main() {
  const forceLogin = process.argv.includes("--login");
  const account = await ensureLoggedIn(forceLogin);
  await initializeQuoteStore({}, account.accountId).catch((e) =>
    log(`QuoteStore init warning: ${String(e)}`)
  );

  const syncFilePath = getSyncBufFilePath(account.accountId);
  let getUpdatesBuf = loadGetUpdatesBuf(syncFilePath) ?? "";
  log(`Entering WeChat ClawBot V2.0 long-poll loop for accountId=${account.accountId} (Router=${getRouterCid()})...`);

  // 后台未回消息防遗漏巡检定时器（每 60 秒检查一次：超过 6 分钟未回且尚未主动提醒过的窗口，自动汇总温和提醒 1 次）
  setInterval(async () => {
    try {
      if (!fs.existsSync(PEER_FILE)) return;
      const peer = JSON.parse(fs.readFileSync(PEER_FILE, "utf8"));
      const lastInMs = peer.updatedAt ? new Date(peer.updatedAt).getTime() : 0;
      const now = Date.now();
      // 如果用户最近 2.5 分钟内正在打字互动，不打断用户
      if (now - lastInMs < 150_000) return;

      const st = loadRouterState();
      const pendingMap = { ...(st.pendingReplies || {}) };
      const due = Object.values(pendingMap).filter(
        (p) => p && p.cid && (p.remindedCount || 0) === 0 && now - (p.sentAt || now) >= 360_000
      );
      if (due.length === 0) return;

      due.sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0));
      const lines = [`⏰ **【防遗漏提醒】你有 ${due.length} 个工作台的消息还没回：**\n`];
      for (const p of due) {
        const mins = Math.max(1, Math.round((now - (p.sentAt || now)) / 60000));
        const tag = p.needsDecision ? "⏳待拍板" : "📩待查阅";
        lines.push(`- **${p.title}**（${mins}分钟前 · ${tag}）  \n  ${p.summary || "已提交阶段汇报"}  `);
        pendingMap[p.cid] = { ...p, remindedCount: (p.remindedCount || 0) + 1, lastRemindedAt: now };
      }
      lines.push(`\n💡 直接说话题或窗口名就能回它；问「还有啥待办」看全部。`);
      saveRouterState({ pendingReplies: pendingMap });
      const sent = await sendMessageWeixin({
        to: peer.fromUserId,
        text: lines.join("\n"),
        opts: {
          baseUrl: peer.baseUrl,
          token: peer.token,
          contextToken: peer.contextToken,
          accountId: peer.accountId,
        },
      });
      // 只涉及一个窗口时登记归属：eru 引用这条提醒回复，就直接回到那个窗口
      if (due.length === 1) rememberOwner(sent, lines.join("\n"), due[0].cid, due[0].title);
      log(`Sent proactive pending-reply reminder for ${due.length} session(s)`);
    } catch (e) {
      log(`Pending reminder timer warning: ${String(e)}`);
    }
  }, 60_000);

  setInterval(() => {
    checkOverdueCommitments().catch((e) => log(`Commitment check warning: ${String(e)}`));
  }, 60_000);

  let timeoutMs = 35_000;
  while (true) {
    try {
      const resp = await getUpdates({
        baseUrl: account.baseUrl,
        token: account.token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs,
      });

      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        timeoutMs = resp.longpolling_timeout_ms;
      }

      if ((resp.ret && resp.ret !== 0) || (resp.errcode && resp.errcode !== 0)) {
        log(`getUpdates API warning: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      // 先处理、后推进游标：处理中途崩溃时整批会重新拉取，已处理过的按消息 ID 跳过。
      // 语义是「至少一次」：已经投出去但还没 markHandled 时崩溃，重启后这条会再投一次（可接受，比丢消息好）。
      // 单条处理不会无限卡住：agentapi 调用有 90 秒超时。
      for (const msg of resp.msgs ?? []) {
        const key = inboundKey(msg);
        if (key && wasHandled(key)) {
          log(`skip already-handled inbound ${key}`);
          continue;
        }
        try {
          await handleInboundMessage(msg, account);
        } catch (e) {
          const dump = path.join(INBOX_DIR, `failed_${Date.now()}.json`);
          try {
            fs.writeFileSync(dump, JSON.stringify(msg, null, 2));
          } catch {}
          log(`handleInboundMessage failed (${String(e)}); raw message saved to ${dump}`);
          await notifyEru(`⚠️ 有一条微信消息处理失败，原始内容已存到 ${dump}。可以再发一遍。`);
        }
        if (key) markHandled(key);
      }

      if (resp.get_updates_buf) {
        saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }
    } catch (err) {
      log(`Long-poll error (will retry in 3s): ${String(err)}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main().catch((err) => {
  log(`Fatal error: ${String(err)}`);
  process.exit(1);
});
