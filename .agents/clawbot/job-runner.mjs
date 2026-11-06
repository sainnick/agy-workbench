#!/usr/bin/env node
/**
 * Claude CLI / Codex 后台任务执行器（由 agy-route.enqueueJob 以 detached 独立进程组拉起）
 * - 与 AGY、bridge 生命周期完全脱钩：它们重启或崩溃都不会连带杀掉正在跑的任务
 * - 同一目标（同一项目的 Claude 会话 / 同一 Codex 线程）串行排队，避免并发 resume 打架
 * - 每次调用写入 delegations.jsonl（started / finished），作为「谁真正干了活」的账本
 * - 结果原样发微信；exit≠0 / is_error 如实标红；PROOF: 行转成 weixin-send --proof 当场核验
 *
 * 用法：node job-runner.mjs <job.json>
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { appendJsonl } from "./state-io.mjs";
import { CLAWBOT_DIR, HUB_DIR, JOBS_DIR, loadRouterState, updateRouterState, loadInboundMsg } from "./core.mjs";
import { DELEGATIONS_FILE } from "./proof.mjs";

const CLAUDE_BIN = "/Users/eru/.local/bin/claude";
const CODEX_BIN = "/opt/homebrew/bin/codex";
const CODEX_GEN_DIR = "/Users/eru/.codex/generated_images";
const SEND_SCRIPT = path.join(CLAWBOT_DIR, "weixin-send.mjs");
const JOB_TIMEOUT_MS = 90 * 60_000;

// CLAUDE.md 置顶红线第 5 条：本机 Claude CLI 唯一标准调用姿势（新号配置目录 + 7897 代理）
const PROXY_ENV = {
  HTTPS_PROXY: "http://127.0.0.1:7897",
  HTTP_PROXY: "http://127.0.0.1:7897",
  ALL_PROXY: "socks5h://127.0.0.1:7897",
  NO_PROXY: "localhost,127.0.0.1,::1,.local",
};

const CLAUDE_SUFFIX = [
  "",
  "---",
  "（这条来自 eru 的微信，由 ClawBot 后台任务交给本机 Claude CLI 执行。你的最终回复会原样发回 eru 的微信：先给结论，简洁。",
  "若声称产出了交付物、修好了或跑通了，请在回复最后单独成行写 `PROOF: file:/绝对路径` 或 `PROOF: url:地址`，做过调研就写 `PROOF: research:/证据.md 绝对路径`（可多行），脚本会当场核验；原型/Mock 必须直说。",
  "未经 eru 拍板不要擅自开新集、全片渲染或写方案外的业务代码。）",
].join("\n");

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireTargetLock(key) {
  const dir = path.join(JOBS_DIR, "locks", key.replace(/[^a-zA-Z0-9_.:-]/g, "_"));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const start = Date.now();
  let announced = false;
  while (true) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
      return () => fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let holder = 0;
      try {
        holder = Number(fs.readFileSync(path.join(dir, "pid"), "utf8"));
      } catch {}
      if (holder && !pidAlive(holder)) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (!announced) {
        log(`等待同目标任务结束（lock=${key}, holder=${holder}）`);
        announced = true;
      }
      if (Date.now() - start > JOB_TIMEOUT_MS) throw new Error(`排队超时：${key}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function runProcess(bin, args, { cwd, env, stdin }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stderr += `\n[job-runner] 超过 ${JOB_TIMEOUT_MS / 60000} 分钟，已终止`;
      child.kill("SIGTERM");
    }, JOB_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${String(e)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

function extractProofs(text) {
  const proofs = [];
  const kept = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^\s*`?PROOF:\s*((?:file|url|mock|research):.+?)`?\s*$/i);
    if (m) proofs.push(m[1].trim());
    else kept.push(line);
  }
  return { text: kept.join("\n").trim(), proofs };
}

async function runClaude(job) {
  const key = `claude:${job.project || "adhoc"}`;
  const st = loadRouterState();
  let sid = job.project ? st.engineSessions?.[key] : null;
  const cwd = job.cwd && fs.existsSync(job.cwd) ? job.cwd : HUB_DIR;
  const env = { ...PROXY_ENV, CLAUDE_CONFIG_DIR: "/Users/eru/.claude-cli" };
  const baseArgs = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];
  const prompt = `${job.instruction}\n${CLAUDE_SUFFIX}`;

  let r = await runProcess(CLAUDE_BIN, sid ? [...baseArgs, "--resume", sid] : baseArgs, { cwd, env, stdin: prompt });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {}
  if (sid && (!parsed || parsed.is_error) && /no conversation found|session.*not found|--resume/i.test(`${r.stderr} ${parsed?.result || ""}`)) {
    log(`resume ${sid} 失败，改为新会话重跑`);
    sid = null;
    r = await runProcess(CLAUDE_BIN, baseArgs, { cwd, env, stdin: prompt });
    try {
      parsed = JSON.parse(r.stdout.trim().split("\n").pop());
    } catch {
      parsed = null;
    }
  }
  if (parsed?.session_id && job.project) {
    updateRouterState((s) => {
      s.engineSessions = { ...(s.engineSessions || {}), [key]: parsed.session_id };
    });
  }
  const isError = r.code !== 0 || !parsed || parsed.is_error === true;
  const resultText = parsed?.result || `${r.stdout}\n${r.stderr}`.trim().slice(-1500) || "（无输出）";
  return {
    cid: key,
    exitCode: r.code,
    isError,
    text: resultText,
    sessionId: parsed?.session_id || sid || null,
    costUsd: parsed?.total_cost_usd ?? null,
    newImages: [],
  };
}

async function runCodex(job) {
  const outMsgFile = path.join(JOBS_DIR, `${job.id}.last.txt`);
  const before = new Map();
  if (fs.existsSync(CODEX_GEN_DIR)) {
    for (const d of fs.readdirSync(CODEX_GEN_DIR)) {
      const sub = path.join(CODEX_GEN_DIR, d);
      if (fs.statSync(sub).isDirectory()) before.set(d, new Set(fs.readdirSync(sub)));
    }
  }
  const cwd = job.cwd && fs.existsSync(job.cwd) ? job.cwd : HUB_DIR;
  const autoImgs = (job.instruction.match(/\/Users\/[^\s"'`<>|]+\.(?:png|jpg|jpeg|webp|gif)/gi) || []).filter((p) => fs.existsSync(p));
  const images = Array.from(new Set([...(job.images || []), ...autoImgs])).filter((p) => fs.existsSync(p));
  const args = ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", cwd, "-o", outMsgFile];
  for (const img of images) args.push("-i", img);
  if (job.threadId) args.push("resume", job.threadId, "-");
  else args.push("-");

  const r = await runProcess(CODEX_BIN, args, { cwd, env: PROXY_ENV, stdin: `${job.instruction}\n` });
  let threadId = job.threadId || null;
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/"thread_id"\s*:\s*"([^"]+)"/);
    if (m) {
      threadId = threadId || m[1];
      break;
    }
  }
  let text = "";
  if (fs.existsSync(outMsgFile)) {
    text = fs.readFileSync(outMsgFile, "utf8").trim();
    fs.rmSync(outMsgFile, { force: true });
  }
  const newImages = [];
  if (fs.existsSync(CODEX_GEN_DIR)) {
    for (const d of fs.readdirSync(CODEX_GEN_DIR)) {
      const sub = path.join(CODEX_GEN_DIR, d);
      if (!fs.statSync(sub).isDirectory()) continue;
      const prev = before.get(d) || new Set();
      for (const f of fs.readdirSync(sub)) {
        if (!prev.has(f) && /\.(png|jpe?g|gif|webp)$/i.test(f)) newImages.push(path.join(sub, f));
      }
    }
  }
  return {
    cid: threadId || "codex-unknown",
    exitCode: r.code,
    isError: r.code !== 0,
    text: text || r.stderr.trim().slice(-800) || "（Codex 无输出）",
    sessionId: threadId,
    costUsd: null,
    newImages,
  };
}

function sendWeixin(args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SEND_SCRIPT, ...args], { stdio: "inherit", cwd: CLAWBOT_DIR });
    c.on("close", resolve);
    c.on("error", resolve);
  });
}


// ───────── 交付验收：Claude 只读审查（独立新会话，不续项目会话，避免自己审自己） ─────────

const FFPROBE_BIN = "/opt/homebrew/bin/ffprobe";
const FFMPEG_BIN = "/opt/homebrew/bin/ffmpeg";
const MAX_REVIEW_ROUNDS = 2;

async function extractKeyframes(video, jobId) {
  const out = [];
  try {
    const r = await runProcess(FFPROBE_BIN, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", video], { cwd: JOBS_DIR, env: {}, stdin: "" });
    const dur = Number(r.stdout.trim());
    if (!(dur > 0)) return out;
    for (const [i, f] of [0.1, 0.5, 0.9].entries()) {
      const img = path.join(JOBS_DIR, `${jobId}_f${i + 1}.jpg`);
      await runProcess(FFMPEG_BIN, ["-v", "error", "-y", "-ss", String((dur * f).toFixed(2)), "-i", video, "-frames:v", "1", "-vf", "scale=960:-2", img], { cwd: JOBS_DIR, env: {}, stdin: "" });
      if (fs.existsSync(img)) out.push(img);
    }
  } catch {}
  return out;
}

async function runReview(job) {
  const rec = job.msgId ? loadInboundMsg(job.msgId) : null;
  const frames = [];
  for (const e of job.evidence || []) if (/\.(mp4|mov|m4v|webm|mkv)$/i.test(e)) frames.push(...(await extractKeyframes(e, job.id)));
  const prompt = [
    `你是 eru 工作站的交付验收员。只读审查，不要修改、创建或删除任何文件。`,
    ``,
    `项目：${job.title}（目录 ${job.cwd}）`,
    `本项目「完成」的最低要求：${job.acceptance?.label || "（未写）"}`,
    rec ? `eru 这次的原话（脚本逐字存档 msg=${rec.id}）：\n「${rec.text || "(纯媒体)"}」${rec.quote?.fullQuotedBody ? `\n（他当时引用的是：「${String(rec.quote.fullQuotedBody).slice(0, 300)}」）` : ""}` : `（没找到这次任务对应的 eru 原话存档，请结合项目目录里的 CLAUDE.md / GEMINI.md 和交付说明判断）`,
    ``,
    `执行窗口（AGY）发给 eru 的交付说明：\n「${job.claimText}」`,
    ``,
    `交付物（请用 Read 打开逐个看）：`,
    ...(job.evidence || []).map((e) => `- ${e}`),
    ...(frames.length ? [`视频关键帧（10% / 50% / 90% 处，已抽好）：`, ...frames.map((f) => `- ${f}`)] : []),
    ``,
    `请判断：`,
    `1. 交付物是否真的回应了 eru 的原话，有没有没做完、偷换任务、或擅自加了 eru 没要的东西；`,
    `2. 交付说明里的说法和交付物是否一致（有没有夸大、把 Mock 说成真实、把没跑的说成跑了）；`,
    `3. 是否违反项目目录里 CLAUDE.md / GEMINI.md 写明的铁律；`,
    `4. 有没有明显的质量问题会让 eru 直接打回。`,
    ``,
    `输出格式（严格遵守）：第一行只写 VERDICT: PASS 或 VERDICT: FAIL。之后最多 8 行要点，每行一句话；FAIL 时写清具体要改什么、改到什么程度算过。`,
  ].join("\n");
  const env = { ...PROXY_ENV, CLAUDE_CONFIG_DIR: "/Users/eru/.claude-cli" };
  const args = ["-p", "--output-format", "json", "--allowedTools", "Read,Glob,Grep", "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch"];
  const r = await runProcess(CLAUDE_BIN, args, { cwd: job.cwd && fs.existsSync(job.cwd) ? job.cwd : HUB_DIR, env, stdin: prompt });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {}
  const text = String(parsed?.result || "").trim();
  const m = text.match(/VERDICT:\s*(PASS|FAIL)/i);
  return {
    ok: r.code === 0 && parsed && !parsed.is_error && Boolean(m),
    verdict: m ? m[1].toUpperCase() : null,
    notes: text.replace(/^.*VERDICT:\s*(PASS|FAIL)\s*/is, "").trim().slice(0, 1500),
    raw: text || `${r.stderr}`.trim().slice(-400),
    sessionId: parsed?.session_id || null,
    costUsd: parsed?.total_cost_usd ?? null,
    exitCode: r.code,
  };
}

async function handleReviewJob(job) {
  const t0 = Date.now();
  appendJsonl(DELEGATIONS_FILE, { jobId: job.id, engine: "claude", role: "review", project: job.project, cwd: job.cwd, title: job.title, msgId: job.msgId, status: "started" });
  const res = await runReview(job);
  appendJsonl(DELEGATIONS_FILE, { jobId: job.id, engine: "claude", role: "review", project: job.project, sessionId: res.sessionId, status: "finished", verdict: res.verdict, exitCode: res.exitCode, costUsd: res.costUsd, durationMs: Date.now() - t0 });
  const session = [`--session=${job.agyCid}`, `--title=${job.title}`, `--engine=review`];
  const files = (job.evidence || []).filter((e) => e.startsWith("/") && fs.existsSync(e)).slice(0, 1);

  if (!res.ok) {
    updateRouterState((s) => {
      if (s.reviews?.[job.agyCid]) s.reviews[job.agyCid].pendingJob = null;
    });
    await sendWeixin([`⚠️ [${job.title}] Claude 审查没跑成（exit=${res.exitCode}）：${res.raw.slice(0, 160) || "无输出"}\n这次交付只过了脚本验收，还没有经过 Claude 审查。`, ...session]);
    return;
  }

  let round = 0;
  updateRouterState((s) => {
    const cur = { ...(s.reviews?.[job.agyCid] || {}) };
    cur.pendingJob = null;
    if ((cur.msgId || null) !== (job.msgId || null)) cur.rounds = 0; // 新任务重新计轮
    cur.msgId = job.msgId || null;
    if (res.verdict === "PASS") cur.rounds = 0;
    else cur.rounds = (cur.rounds || 0) + 1;
    round = cur.rounds;
    cur.lastVerdict = res.verdict;
    cur.lastVerdictAt = Date.now();
    s.reviews = { ...(s.reviews || {}), [job.agyCid]: cur };
  });

  if (res.verdict === "PASS") {
    try {
      const { processOutgoing } = await import("./commitments.mjs");
      processOutgoing({ cid: job.agyCid, title: job.title, text: "", results: [{ kind: "accepted", level: "ok" }] });
    } catch {}
    await sendWeixin([`✅【Claude 审查通过 · 可拍板】${job.title}\n\n${res.notes || "（无补充意见）"}`, ...files, ...session]);
    return;
  }

  if (round <= MAX_REVIEW_ROUNDS) {
    const { callAgentApi, spawnWatcher, countTranscriptLines } = await import("./agy-route.mjs");
    const before = countTranscriptLines(job.agyCid);
    const back = [
      `🔁 [系统验收退回 · 第 ${round}/${MAX_REVIEW_ROUNDS} 轮]（这是 Claude 审查意见，不是 eru 原话）`,
      ``,
      `你刚发给 eru 的交付没有通过审查。审查意见：`,
      res.notes || "（审查没给出具体意见）",
      ``,
      `按意见改完后，重新用 weixin-send.mjs 把交付物文件附上发给 eru，会再审一次。不要跳过意见，也不要说已完成而不附文件。`,
    ].join("\n");
    const sent = await callAgentApi(["send-message", job.agyCid, back]);
    if (sent.code === 0) spawnWatcher(job.agyCid, job.title, "-", before); // 退回后照样盯：停了不回话会告警
    await sendWeixin([
      `↩️【Claude 审查未通过 · 已退回重做（${round}/${MAX_REVIEW_ROUNDS}）】${job.title}\n\n${res.notes || ""}${sent.code === 0 ? "" : `\n\n⚠️ 退回窗口失败（exit=${sent.code}），需要你手动转达。`}`,
      ...session,
    ]);
    return;
  }
  await sendWeixin([`🛑【连续 ${MAX_REVIEW_ROUNDS} 轮审查没过，需要你看】${job.title}\n\n最后一轮意见：\n${res.notes || ""}`, ...files, ...session]);
}

async function main() {
  const jobFile = process.argv[2];
  const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  if (job.engine === "review") {
    const releaseReview = await acquireTargetLock(`review:${job.agyCid}`);
    try {
      await handleReviewJob(job);
    } catch (e) {
      await sendWeixin([`❌ [${job.title}] 审查任务崩溃：${String(e).slice(0, 200)}`, `--session=${job.agyCid}`, `--engine=review`]);
    } finally {
      releaseReview();
    }
    return;
  }
  const lockKey = job.engine === "claude" ? `claude:${job.project || job.id}` : `codex:${job.threadId || job.id}`;
  const promptSha = crypto.createHash("sha256").update(job.instruction || "").digest("hex").slice(0, 12);
  const release = await acquireTargetLock(lockKey);
  const t0 = Date.now();
  const label = job.engine === "claude" ? "Claude" : "Codex";
  appendJsonl(DELEGATIONS_FILE, { jobId: job.id, engine: job.engine, project: job.project || null, cwd: job.cwd, title: job.title, msgId: job.msgId || null, promptSha, status: "started", ...(job.test ? { test: true } : {}) });
  try {
    if (job.engine === "claude" && job.project) {
      updateRouterState((s) => {
        const p = { ...(s.pendingReplies || {}) };
        delete p[`claude:${job.project}`];
        s.pendingReplies = p;
      });
    }
    await sendWeixin([`--tool-start`, `${label}: ${job.title || ""}`]);
    const res = job.engine === "claude" ? await runClaude(job) : await runCodex(job);
    appendJsonl(DELEGATIONS_FILE, {
      jobId: job.id,
      engine: job.engine,
      project: job.project || null,
      sessionId: res.sessionId,
      promptSha,
      status: "finished",
      exitCode: res.exitCode,
      isError: res.isError,
      costUsd: res.costUsd,
      durationMs: Date.now() - t0,
      ...(job.test ? { test: true } : {}),
    });
    await sendWeixin([`--tool-end`, `${label}: ${job.title || ""}`]);
    const { text, proofs } = extractProofs(res.text);
    const secs = Math.round((Date.now() - t0) / 1000);
    const mins = secs < 60 ? `${secs} 秒` : `${Math.round(secs / 60)} 分钟`;
    const head = res.isError
      ? `❌ [${label} · ${job.title}] 执行异常（exit=${res.exitCode}，${mins}）`
      : `${job.engine === "claude" ? "🟣" : "🤖"} [${label} · ${job.title}]（${mins}${res.costUsd != null ? ` · $${Number(res.costUsd).toFixed(2)}` : ""}）`;
    await sendWeixin([
      `${head}\n\n${text}`,
      ...res.newImages,
      `--session=${res.cid}`,
      `--title=${job.title || label}`,
      `--engine=${job.engine}`,
      `--cwd=${job.cwd || HUB_DIR}`,
      ...proofs.map((p) => `--proof=${p}`),
    ]);
    log(`done exit=${res.exitCode} isError=${res.isError}`);
  } catch (e) {
    appendJsonl(DELEGATIONS_FILE, { jobId: job.id, engine: job.engine, project: job.project || null, status: "crashed", error: String(e).slice(0, 300) });
    await sendWeixin([`❌ [${label} · ${job.title}] 后台任务崩溃：${String(e).slice(0, 200)}`]);
  } finally {
    release();
  }
}

main().catch((e) => {
  log(`fatal ${String(e)}`);
  process.exit(1);
});
