#!/usr/bin/env node
/**
 * 波妞工作站 · GPT 二审（7158f22）五大场景端到端隔离验证
 *
 *   node /Users/eru/Desktop/agy工作站/.agents/clawbot/test/e2e-verification.mjs
 *
 * 隔离方式：把 clawbot/*.mjs 复制到临时沙盒（dist、node_modules 软链），状态文件全部是沙盒里的假数据；
 * 微信发送走沙盒专用假通道（CLAWBOT_FAKE_TRANSPORT，生产目录里设了也无效），不会真的发微信、
 * 不碰生产 commitments.json / proofs.jsonl / router_state.json。
 * 工作台用真实 workbench/server.mjs 起在随机端口，只打不产生副作用的写请求。
 *
 * ① AGY 冒充 Claude 被拦截（正则变体 + 将来时不误判 + 伪造/弱权限票据验不过 + 端到端改写打标）
 * ② 两个 bridge 实例同时启动，端口锁只放行一个（另查生产 47800 锁持有者）
 * ③ 附件上传中断：先发正文、失败告警、不发回执、不记通过、不核销；全部成功才补发回执并核销
 * ④ 工作台写接口：无 / 错 / 旧进程 X-Workbench-Token 一律 403，有效令牌放行
 * ⑤ 承诺账本：进度汇报不建闹钟、同窗最多 1 条活跃、历史堆积收拢、无绑定不核销、--task 精准核销
 */
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "..");
const HUB = path.resolve(SRC, "../..");
const WORKBENCH_SERVER = path.join(HUB, "workbench", "server.mjs");

const results = [];
let current = "";
function scenario(name) {
  current = name;
  console.log(`\n━━ ${name}`);
}
function check(name, cond, detail = "") {
  results.push({ scenario: current, name, pass: Boolean(cond), detail: String(detail || "").slice(0, 300) });
  console.log(`${cond ? "  ✅ PASS" : "  ❌ FAIL"}  ${name}${detail && !cond ? `\n         ↳ ${String(detail).slice(0, 300)}` : ""}`);
}

// ───────── 沙盒 ─────────
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbot-e2e-")));
const SB = path.join(TMP, "clawbot");
const PROJ = path.join(TMP, "proj");
const TRANSPORT = path.join(TMP, "transport.jsonl");
const SECRET = path.join(TMP, "ticket_secret");
const E2E_CID = "e2e00000-0000-4000-8000-000000000001";
const ROUTER_CID = "df666dc1-4b27-4fe4-ae54-5911bf805f99";

fs.mkdirSync(SB, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });
fs.mkdirSync(path.join(TMP, "openclaw"), { recursive: true });
fs.mkdirSync(path.join(TMP, "brain"), { recursive: true });
for (const f of fs.readdirSync(SRC)) if (f.endsWith(".mjs")) fs.copyFileSync(path.join(SRC, f), path.join(SB, f));
fs.symlinkSync(path.join(SRC, "dist"), path.join(SB, "dist"));
fs.symlinkSync(path.join(SRC, "node_modules"), path.join(SB, "node_modules"));
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
writeJson(path.join(SB, "rules.json"), {
  routes: { e2eproj: { name: "E2E测试项目", cid: E2E_CID, cwd: PROJ, engine: "agy", keywords: [], acceptance: { kinds: ["doc"], review: null, label: "文稿" } } },
});
const resetState = (extra = {}) =>
  writeJson(path.join(SB, "router_state.json"), { routerCid: ROUTER_CID, sessionAliases: { [E2E_CID]: "E2E测试项目" }, lastDispatch: {}, ...extra });
resetState();
writeJson(path.join(SB, "latest_peer.json"), { baseUrl: "http://127.0.0.1:9", token: "e2e", contextToken: "e2e", accountId: "e2e-sandbox", fromUserId: "e2e-user" });
writeJson(path.join(SB, "commitments.json"), { items: {} });
fs.writeFileSync(SECRET, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });

const BASE_ENV = {
  ...process.env,
  OPENCLAW_STATE_DIR: path.join(TMP, "openclaw"),
  CLAWBOT_BRAIN_DIR: path.join(TMP, "brain"),
  CLAWBOT_TICKET_SECRET_FILE: SECRET,
  CLAWBOT_FAKE_TRANSPORT: TRANSPORT,
  AGY_SESSION_ID: "",
  AGY_ENGINE: "",
};
delete BASE_ENV.CLAWBOT_JOB_TICKET;
delete BASE_ENV.CLAWBOT_DRY_RUN;
delete BASE_ENV.CLAWBOT_FAKE_FAIL_MEDIA;

function run(script, args, env = {}, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script, ...args], { cwd: SB, env: { ...BASE_ENV, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => c.kill("SIGKILL"), timeoutMs);
    c.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}
const send = (args, env) => run(path.join(SB, "weixin-send.mjs"), args, env);
const transport = () => (fs.existsSync(TRANSPORT) ? fs.readFileSync(TRANSPORT, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const clearTransport = () => fs.rmSync(TRANSPORT, { force: true });
const lastProof = () => {
  const f = path.join(SB, "proofs.jsonl");
  if (!fs.existsSync(f)) return null;
  const lines = fs.readFileSync(f, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
};
const commitments = () => JSON.parse(fs.readFileSync(path.join(SB, "commitments.json"), "utf8")).items;
const seedCommitment = (c) => {
  const db = JSON.parse(fs.readFileSync(path.join(SB, "commitments.json"), "utf8"));
  db.items[c.id] = { cid: E2E_CID, title: "E2E测试项目", needsResearch: false, createdAt: Date.now() - 60_000, dueAt: Date.now() + 30 * 60_000, dueMin: 30, status: "open", remindedAt: 0, ...c };
  writeJson(path.join(SB, "commitments.json"), db);
};
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prod = { cleanup: [] };

async function main() {
  console.log(`沙盒：${TMP}`);

  // ═════════ ① AGY 冒充 Claude ═════════
  scenario("① AGY 冒充 Claude 被拦截");
  const proof = await import(pathToFileURL(path.join(SB, "proof.mjs")).href);
  const claimCases = [
    "已调 Claude 审完了",
    "Claude 盲审通过",
    "让 Claude 审了一遍，没问题",
    "经 Claude 复审，可以交付",
    "Claude CLI 已完成",
    "Opus 审过了",
    "由 Claude 重构完成",
    "Claude CLI 首轮盲审已完成（抓出 6 项问题），正在逐条修复",
    "正在按 Claude 审计清单完成 5 项硬核修复",
    "Claude 指出 3 个问题",
    "Claude 盲审：9 分",
    "GPT 审过了",
  ];
  const futureCases = [
    "正在启动 Claude CLI 复审",
    "随后立即运行 Claude CLI 盲审",
    "准备调 Claude",
    "已修复 GroupID 签名校验，正在实测并启动 Claude CLI 盲审！",
    "接下来交给 Claude 审查，审完发你",
    "还没让 Claude 审",
    "Claude 要不要审一下？",
    "Claude 专属代理链路正常",
    "马上让 Codex 挑刺",
  ];
  const missedClaims = claimCases.filter((t) => proof.detectEngineClaims(t).length === 0);
  check(`已完成态身份声明 ${claimCases.length} 种变体全部识别`, missedClaims.length === 0, `漏判：${missedClaims.join(" / ")}`);
  const falseHits = futureCases.filter((t) => proof.detectEngineClaims(t).length > 0);
  check(`将来时/进行时/否定/问句 ${futureCases.length} 种不误判为冒充`, falseHits.length === 0, `误判：${falseHits.join(" / ")}`);

  fs.writeFileSync(path.join(PROJ, "draft.md"), "# E2E 文稿\n\n正文。\n");
  clearTransport();
  seedCommitment({ id: "cimp001", taskId: "mimp", text: "马上把 draft.md 文稿写完发你" });
  let r = await send(["文稿 draft.md 已完成，已调 Claude 盲审通过。", `--session=${E2E_CID}`, `--proof=file:${path.join(PROJ, "draft.md")}`, "--task=mimp"]);
  let sentText = transport().filter((x) => x.type === "text").map((x) => x.text).join("\n");
  check("端到端：冒充分句被就地改写为〔未核实·查无Claude调用〕", /〔未核实·查无Claude调用〕/.test(sentText), sentText);
  check("端到端：末尾打标「🚫 查无 Claude 调用·疑似冒充」", /🚫 查无 Claude 调用·疑似冒充/.test(sentText), sentText);
  check("端到端：冒充交付不给「🧾 已核验」绿勾", !/🧾 已核验/.test(sentText), sentText);
  check("端到端：proofs.jsonl 记 verdict=impostor", lastProof()?.verdict === "impostor", JSON.stringify(lastProof()));
  check("端到端：冒充交付不核销承诺（即使 --task 对得上）", commitments().cimp001?.status === "open", JSON.stringify(commitments().cimp001));

  clearTransport();
  r = await send(["已修复签名校验，正在启动 Claude CLI 复审，20 分钟内发你结果。", `--session=${E2E_CID}`]);
  sentText = transport().map((x) => x.text || "").join("\n");
  check("端到端：将来时「正在启动 Claude CLI 复审」不打冒充标", r.code === 0 && !/查无 Claude|未核实/.test(sentText), sentText + r.err);

  // 票据 HMAC
  const jobId = "je2eclaude01";
  fs.mkdirSync(path.join(SB, "jobs", "tickets"), { recursive: true });
  writeJson(path.join(SB, "jobs", `${jobId}.json`), { id: jobId, engine: "claude", project: "e2eproj" });
  fs.appendFileSync(path.join(SB, "delegations.jsonl"), JSON.stringify({ ts: new Date().toISOString(), jobId, engine: "claude", status: "started", cwd: path.join(TMP, "jobcwd"), test: true }) + "\n");
  const { signTicket } = await import(pathToFileURL(path.join(SB, "ticket.mjs")).href);
  const mkTicket = ({ sign = true, secretFile = SECRET, tamper = false } = {}) => {
    const nonce = crypto.randomBytes(16).toString("hex");
    const t = { nonce, jobId, engine: "claude", role: "worker", createdAt: Date.now(), pid: process.pid };
    if (sign) t.sig = signTicket(t, fs.readFileSync(secretFile, "utf8").trim());
    if (tamper) t.engine = "codex";
    writeJson(path.join(SB, "jobs", "tickets", `${nonce}.json`), t);
    return nonce;
  };
  const longText = "这是一条系统长消息用于区分票据真伪。".repeat(45); // >600 字：有效票据→落盘摘要；无效→按窗口拒发
  r = await send([longText, `--session=${E2E_CID}`], { CLAWBOT_JOB_TICKET: mkTicket({ sign: false }) });
  check("未签名（手写 JSON）票据被拒，按普通窗口消息拒发", r.code === 3 && /票据签名校验失败/.test(r.err), `code=${r.code} ${r.err.slice(0, 200)}`);
  r = await send([longText, `--session=${E2E_CID}`], { CLAWBOT_JOB_TICKET: mkTicket({ tamper: true }) });
  check("签名后被篡改字段的票据被拒", r.code === 3 && /票据签名校验失败/.test(r.err), `code=${r.code}`);
  const weak = path.join(TMP, "weak_secret");
  fs.copyFileSync(SECRET, weak);
  fs.chmodSync(weak, 0o644);
  r = await send([longText, `--session=${E2E_CID}`], { CLAWBOT_JOB_TICKET: mkTicket({ secretFile: weak }), CLAWBOT_TICKET_SECRET_FILE: weak });
  check("密钥文件权限不是 0600 时一律不认票", r.code === 3 && /票据签名校验失败/.test(r.err), `code=${r.code}`);
  clearTransport();
  r = await send([longText, `--session=${E2E_CID}`], { CLAWBOT_JOB_TICKET: mkTicket() });
  check("有效签名票据被认作系统消息（超长自动落盘只发摘要）", r.code === 0 && /全文已落盘/.test(r.err) && transport().length === 1, `code=${r.code} ${r.err.slice(0, 200)}`);
  const usedTickets = fs.readdirSync(path.join(SB, "jobs", "tickets")).length;
  check("票据一次性：用过即删", usedTickets === 0, `残留 ${usedTickets} 张`);

  // ═════════ ② bridge 单实例锁 ═════════
  scenario("② 两个 bridge 实例同时启动被端口锁拦截");
  const lockPort = await freePort();
  const startBridge = () => {
    const c = spawn(process.execPath, [path.join(SB, "bridge.mjs")], { cwd: SB, env: { ...BASE_ENV, CLAWBOT_LOCK_ONLY: "1", CLAWBOT_LOCK_PORT: String(lockPort) }, stdio: ["ignore", "pipe", "pipe"] });
    c.log = "";
    c.exited = null;
    c.stdout.on("data", (d) => (c.log += d));
    c.stderr.on("data", (d) => (c.log += d));
    c.on("exit", (code) => (c.exited = code));
    return c;
  };
  const A = startBridge();
  const B = startBridge();
  for (let i = 0; i < 100 && A.exited === null && B.exited === null; i++) await sleep(100);
  await sleep(1500);
  const alive = [A, B].filter((c) => c.exited === null);
  const dead = [A, B].filter((c) => c.exited !== null);
  check("同时启动两个实例：恰好一个持锁存活", alive.length === 1 && dead.length === 1, `alive=${alive.length} logs=${A.log.slice(-160)} | ${B.log.slice(-160)}`);
  check("落败实例以 0 退出并记录「Another bridge already holds」", dead[0]?.exited === 0 && /Another bridge already holds/.test(dead[0]?.log || ""), dead[0]?.log);
  check("持锁实例只占锁、不登录微信（LOCK_ONLY 沙盒模式）", /LOCK_ONLY test mode/.test(alive[0]?.log || ""), alive[0]?.log);
  const C = startBridge();
  for (let i = 0; i < 100 && C.exited === null; i++) await sleep(100);
  check("持锁期间第三个实例启动也被拦截", C.exited === 0 && /Another bridge already holds/.test(C.log), C.log);
  for (const c of alive) c.kill("SIGTERM");
  await sleep(500);
  const D = startBridge();
  for (let i = 0; i < 30 && !/LOCK_ONLY test mode/.test(D.log); i++) await sleep(100);
  check("持锁进程退出后锁自动释放，新实例可接管（无残锁）", /LOCK_ONLY test mode/.test(D.log) && D.exited === null, D.log);
  D.kill("SIGTERM");
  const banner = await new Promise((resolve) => {
    const s = net.connect(47800, "127.0.0.1");
    let b = "";
    s.on("data", (d) => (b += d));
    s.on("end", () => resolve(b));
    s.on("error", () => resolve(""));
    setTimeout(() => {
      s.destroy();
      resolve(b);
    }, 2000);
  });
  const prodPid = (banner.match(/pid=(\d+)/) || [])[1];
  check("生产 127.0.0.1:47800 当前由唯一的 clawbot-bridge 持有（只读探测）", Boolean(prodPid), banner || "47800 无人监听");
  prod.bridgePid = prodPid || null;

  // ═════════ ③ 附件上传中断 ═════════
  scenario("③ 附件上传中断时不记账不核销");
  fs.writeFileSync(path.join(PROJ, "a.md"), "# 交付 A\n\n内容 A。\n");
  fs.writeFileSync(path.join(PROJ, "b.md"), "# 交付 B\n\n内容 B。\n");
  seedCommitment({ id: "catt001", taskId: "matt", text: "马上把 a.md 和 b.md 两份文稿写完发你" });
  clearTransport();
  r = await send(["两份文稿已完成，见附件。", path.join(PROJ, "a.md"), path.join(PROJ, "b.md"), `--session=${E2E_CID}`, "--task=matt"], { CLAWBOT_FAKE_FAIL_MEDIA: "b.md" });
  let tr = transport();
  check("上传失败时脚本退出码 4（不是假装成功）", r.code === 4, `code=${r.code} ${r.err.slice(-200)}`);
  check("先发纯正文（不带 🧾 回执）", tr[0]?.type === "text" && !/🧾/.test(tr[0]?.text || ""), JSON.stringify(tr[0]));
  check("a.md 送达、b.md 失败", tr.some((x) => x.type === "media" && x.file === "a.md") && tr.some((x) => x.type === "media_fail" && x.file === "b.md"), JSON.stringify(tr));
  check("立即发出「⚠️ 附件上传失败，本次交付未完成」告警", tr.some((x) => x.type === "text" && /⚠️ 附件上传失败，本次交付未完成/.test(x.text)), JSON.stringify(tr.at(-1)));
  check("全程没有发出任何「🧾 验收回执」", !tr.some((x) => /🧾/.test(x.text || "")), JSON.stringify(tr));
  let lp = lastProof();
  check("proofs.jsonl 记 attachment_failed / sent=false，不是通过", lp?.verdict === "attachment_failed" && lp?.sent === false, JSON.stringify(lp));
  check("承诺未被核销", commitments().catt001?.status === "open", JSON.stringify(commitments().catt001));

  clearTransport();
  r = await send(["两份文稿已完成，见附件。", path.join(PROJ, "a.md"), path.join(PROJ, "b.md"), `--session=${E2E_CID}`, "--task=matt"]);
  tr = transport();
  const order = tr.map((x) => (x.type === "text" ? (/🧾/.test(x.text) ? "receipt" : "body") : `${x.type}:${x.file}`)).join(" → ");
  check("全部成功时顺序为 正文 → 附件 A → 附件 B → 🧾 回执", order === "body → media:a.md → media:b.md → receipt", order);
  lp = lastProof();
  check("全部送达后才记 accepted / sent=true", lp?.verdict === "accepted" && lp?.sent === true && lp?.delivery === "sent", JSON.stringify(lp));
  check("全部送达后才按 --task 核销承诺", commitments().catt001?.status === "fulfilled" && commitments().catt001?.fulfilledTaskId === "matt", JSON.stringify(commitments().catt001));
  const prodGuard = /CLAWBOT_FAKE_TRANSPORT 在生产目录无效/.test(fs.readFileSync(path.join(SRC, "weixin-send.mjs"), "utf8"));
  check("假发送通道仅限沙盒：生产目录内代码有路径守卫", prodGuard);

  // ═════════ ④ 工作台 Control Token ═════════
  scenario("④ 4800 工作台无 X-Workbench-Token 写请求返回 403");
  const startServer = async () => {
    const port = await freePort();
    const c = spawn(process.execPath, [WORKBENCH_SERVER], { env: { ...process.env, WORKBENCH_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
    c.log = "";
    c.stdout.on("data", (d) => (c.log += d));
    c.stderr.on("data", (d) => (c.log += d));
    for (let i = 0; i < 100 && !/已启动/.test(c.log); i++) await sleep(100);
    return { c, port, base: `http://127.0.0.1:${port}` };
  };
  const W = await startServer();
  const W2 = await startServer();
  try {
    const html = await (await fetch(`${W.base}/`)).text();
    const token = (html.match(/name="wb-token" content="([0-9a-f]{64})"/) || [])[1];
    check("GET / 注入 64 位十六进制令牌（占位符已替换）", Boolean(token) && !html.includes("__WORKBENCH_TOKEN__"));
    const html2 = await (await fetch(`${W2.base}/`)).text();
    const token2 = (html2.match(/name="wb-token" content="([0-9a-f]{64})"/) || [])[1];
    const j = (b) => ({ "Content-Type": "application/json", ...b });
    const cases = [
      ["POST /api/send 无令牌", "POST", "/api/send", {}, { project: "e2e-none", text: "x" }],
      ["POST /api/project/:id 无令牌", "POST", "/api/project/e2e-none", {}, { status: "done" }],
      ["POST /api/open 无令牌", "POST", "/api/open", {}, { path: "/tmp" }],
      ["POST /api/send 错误令牌", "POST", "/api/send", { "X-Workbench-Token": "0".repeat(64) }, { project: "e2e-none", text: "x" }],
      ["POST /api/send 截断令牌", "POST", "/api/send", { "X-Workbench-Token": (token || "").slice(0, 32) }, { project: "e2e-none", text: "x" }],
      ["POST /api/send 另一进程的令牌（重启即作废）", "POST", "/api/send", { "X-Workbench-Token": token2 || "" }, { project: "e2e-none", text: "x" }],
      ["PUT /api/maintain 无令牌", "PUT", "/api/maintain", {}, {}],
      ["DELETE /api/project/x 无令牌", "DELETE", "/api/project/e2e-none", {}, null],
    ];
    for (const [name, method, p, h, body] of cases) {
      const resp = await fetch(`${W.base}${p}`, { method, headers: j(h), body: body ? JSON.stringify(body) : undefined });
      check(`${name} → 403`, resp.status === 403, `HTTP ${resp.status} ${await resp.text()}`);
    }
    const ok = await fetch(`${W.base}/api/open`, { method: "POST", headers: j({ "X-Workbench-Token": token }), body: JSON.stringify({ path: "/e2e/不在登记表/的路径" }) });
    check("有效令牌通过鉴权（/api/open 非登记路径 → 400，无副作用）", ok.status === 400, `HTTP ${ok.status}`);
    const g = await fetch(`${W.base}/api/session?engine=agy&id=e2e-none`);
    check("只读 GET 接口不需要令牌（不影响页面刷新）", g.status !== 403, `HTTP ${g.status}`);
    const idx = fs.readFileSync(path.join(HUB, "workbench", "index.html"), "utf8");
    check("index.html 的所有 POST 都经 post() 带 X-Workbench-Token", !/method:'POST'(?![^\n]*X-Workbench-Token)/.test(idx) && /X-Workbench-Token/.test(idx));
  } finally {
    W.c.kill("SIGTERM");
    W2.c.kill("SIGTERM");
  }

  // ═════════ ⑤ 承诺账本 ═════════
  scenario("⑤ 承诺账本防重复堆积与精准核销");
  writeJson(path.join(SB, "commitments.json"), { items: {} });
  const C1 = "e2e00000-0000-4000-8000-0000000000c1";
  const C2 = "e2e00000-0000-4000-8000-0000000000c2";
  const C3 = "e2e00000-0000-4000-8000-0000000000c3";
  resetState({ lastDispatch: { [C1]: { msgId: "mt1", at: Date.now() - 1000 }, [C3]: { msgId: "taskB", at: Date.now() - 1000 } } });
  const cm = await import(pathToFileURL(path.join(SB, "commitments.mjs")).href + `?t=${Date.now()}`);
  const openOf = (cid) => Object.values(commitments()).filter((c) => c.cid === cid && c.status === "open");
  const reports = [
    "进度汇报（波妞）：已完成 TaskBillingService 改造，正在发送真实生成请求校验！",
    "进度汇报（波妞）：已定位计费域签名头校验，正在注入网关签名并完成端到端真实生成！",
    "进度汇报（波妞）：已修复 GroupID 正整数签名校验，正在实测任务落盘并启动 Claude CLI 盲审！",
    "【H3算力工作台】进度汇报：已对齐 output.resources 契约，正在观测真实视频生成任务完成！",
    "进度汇报：已补齐并发额度接口，正在观测任务完成态与 SQL 落盘！",
  ];
  for (const t of reports) cm.processOutgoing({ cid: C1, title: "T1", text: t });
  check("5 条无新时间点的「进度汇报」不新建任何承诺（复现 ad706c0a 事故）", openOf(C1).length === 0, JSON.stringify(openOf(C1)));
  cm.processOutgoing({ cid: C1, title: "T1", text: "收到，我马上去改 a.md 文稿，20 分钟内发你。" });
  check("真正的承诺照常登记 1 条，带 20 分钟时限与当前任务 ID", openOf(C1).length === 1 && openOf(C1)[0].dueMin === 20 && openOf(C1)[0].taskId === "mt1", JSON.stringify(openOf(C1)));
  const firstId = openOf(C1)[0]?.id;
  for (const t of [...reports, "我马上继续补 b.md，接着改。", "我现在去跑一遍渲染，1 小时内给你。"]) cm.processOutgoing({ cid: C1, title: "T1", text: t });
  const o1 = openOf(C1);
  check("再发 7 条进度/承诺：同窗仍只有 1 条活跃承诺（合并不叠加）", o1.length === 1 && o1[0].id === firstId, JSON.stringify(o1.map((c) => c.id)));
  check("合并时更新承诺文本并保留原文", o1[0]?.mergedCount === 7 && /渲染/.test(o1[0]?.text || "") && /a\.md/.test(o1[0]?.originalText || ""), JSON.stringify(o1[0]));
  check("新承诺给出新时间点（1 小时）才顺延截止", o1[0]?.dueMin === 60, `dueMin=${o1[0]?.dueMin}`);

  const db = JSON.parse(fs.readFileSync(path.join(SB, "commitments.json"), "utf8"));
  for (let i = 0; i < 5; i++) db.items[`cleg00${i}`] = { id: `cleg00${i}`, cid: C2, title: "T2", text: `进度汇报：第 ${i} 步`, createdAt: Date.now() - (10 - i) * 60_000, dueAt: Date.now() + 600_000, dueMin: 30, status: "open", remindedAt: 0 };
  writeJson(path.join(SB, "commitments.json"), db);
  cm.processOutgoing({ cid: C2, title: "T2", text: "进度汇报：第 5 步完成一半。" });
  check("历史遗留 5 条同窗堆积 → 收拢为 1 条活跃，其余记 merged", openOf(C2).length === 1 && Object.values(commitments()).filter((c) => c.cid === C2 && c.status === "merged").length === 4);

  const db3 = JSON.parse(fs.readFileSync(path.join(SB, "commitments.json"), "utf8"));
  db3.items.cA = { id: "cA", cid: C3, title: "T3", taskId: "taskA", text: "马上写 alpha 调整方案", createdAt: Date.now() - 60_000, dueAt: Date.now() + 600_000, dueMin: 30, status: "open", remindedAt: 0 };
  writeJson(path.join(SB, "commitments.json"), db3);
  const okVideo = [{ kind: "file", level: "ok", target: "/x/unrelated-cut.mp4" }];
  let f = cm.processOutgoing({ cid: C3, title: "T3", text: "视频渲染好了。", results: okVideo, register: false });
  check("无 taskId、当前派发任务不同、文件名/关键词对不上 → 不核销", f.fulfilled.length === 0 && commitments().cA.status === "open", JSON.stringify(f.fulfilled));
  f = cm.settleCommitments({ cid: "unassigned", text: "alpha 调整方案写好了", results: okVideo });
  check("未归属会话（unassigned）的回执不核销任何承诺", f.length === 0 && commitments().cA.status === "open");
  f = cm.settleCommitments({ cid: C1, taskId: "taskA", text: "alpha 调整方案写好了", results: okVideo });
  check("别的窗口拿同一 taskId 也核销不了本窗承诺", f.length === 0 && commitments().cA.status === "open");
  f = cm.processOutgoing({ cid: C3, title: "T3", text: "方案写好了。", results: [{ kind: "file", level: "ok", target: "/x/plan.md" }], taskId: "taskA", messageId: "fake-msg-1", register: false });
  check("--task=taskA 精准核销且记下交付消息 ID", f.fulfilled.length === 1 && commitments().cA.status === "fulfilled" && commitments().cA.fulfilledMessageId === "fake-msg-1", JSON.stringify(commitments().cA));

  const db4 = JSON.parse(fs.readFileSync(path.join(SB, "commitments.json"), "utf8"));
  db4.items.cB = { id: "cB", cid: C3, title: "T3", taskId: "old", text: "马上把 beta-cut.mp4 渲染出来", createdAt: Date.now() - 60_000, dueAt: Date.now() + 600_000, dueMin: 30, status: "open", remindedAt: 0 };
  writeJson(path.join(SB, "commitments.json"), db4);
  f = cm.processOutgoing({ cid: C3, title: "T3", text: "成片好了。", results: [{ kind: "file", level: "ok", target: "/x/beta-cut.mp4" }], register: false });
  check("无 taskId 但交付物文件名与承诺明确对得上 → 核销", f.fulfilled.length === 1 && commitments().cB.status === "fulfilled");

  // 生产账本只读复核：ad706c0a 堆积已清理
  const prodItems = Object.values(JSON.parse(fs.readFileSync(path.join(SRC, "commitments.json"), "utf8")).items || {});
  const h3Open = prodItems.filter((c) => c.cid.startsWith("ad706c0a") && c.status === "open");
  const h3ProgressOpen = h3Open.filter((c) => /^进度汇报/.test(c.text));
  check("生产账本只读复核：ad706c0a 不再有进度汇报类活跃承诺，同窗活跃 ≤ 1", h3ProgressOpen.length === 0 && h3Open.length <= 1, JSON.stringify(h3Open.map((c) => c.id + ":" + c.text.slice(0, 20))));
}

let fatal = null;
try {
  await main();
} catch (e) {
  fatal = e;
  check("测试脚本自身无异常", false, e?.stack || e);
}
const pass = results.filter((r) => r.pass).length;
const summary = { ranAt: new Date().toISOString(), sandbox: TMP, total: results.length, pass, fail: results.length - pass, prodBridgePid: prod.bridgePid || null, results };
fs.writeFileSync(path.join(__dirname, "last-run.json"), JSON.stringify(summary, null, 2));
console.log(`\n━━ 结果：${pass}/${results.length} PASS${results.length - pass ? `，${results.length - pass} FAIL` : ""}（明细 test/last-run.json）`);
if (!process.env.E2E_KEEP_SANDBOX) fs.rmSync(TMP, { recursive: true, force: true });
process.exit(pass === results.length && !fatal ? 0 : 1);
