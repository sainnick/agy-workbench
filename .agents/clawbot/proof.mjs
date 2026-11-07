/**
 * 防糊弄验收回执（Anti-Hallucination Gate）
 * 由 weixin-send.mjs 在发送前「亲自」执行检查，结果附在微信消息末尾。
 * Agent 能编一段话，但编不出这里当场跑出来的结果。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJsonlTail } from "./state-io.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DELEGATIONS_FILE = path.join(__dirname, "delegations.jsonl");
export const PROOFS_FILE = path.join(__dirname, "proofs.jsonl");
const FFPROBE = "/opt/homebrew/bin/ffprobe";
const CLAUDE_CLI_PROJECTS = "/Users/eru/.claude-cli/projects";
const CODEX_DB = "/Users/eru/.codex/sqlite/codex.db";

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
const AUDIO_EXT = /\.(wav|mp3|m4a|aac|flac)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|heic)$/i;

function fmtSize(n) {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)}GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)}MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)}KB`;
  return `${n}B`;
}

function fmtAge(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}分钟前生成`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}小时前生成`;
  return `${Math.round(h / 24)}天前生成`;
}

function proofFile(target) {
  const p = path.resolve(target);
  if (!fs.existsSync(p)) return { level: "fail", detail: `文件不存在：${p}` };
  const st = fs.statSync(p);
  if (st.isDirectory()) return { level: "warn", detail: `${p} 是目录，不是交付物文件` };
  if (st.size === 0) return { level: "fail", detail: `${path.basename(p)} 是 0 字节空文件` };
  const age = Date.now() - st.mtimeMs;
  const parts = [path.basename(p)];
  let level = age > 2 * 3600_000 ? "warn" : "ok";
  if (VIDEO_EXT.test(p) || AUDIO_EXT.test(p)) {
    try {
      const out = execFileSync(
        FFPROBE,
        ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", p],
        { encoding: "utf8", timeout: 20_000 }
      );
      const j = JSON.parse(out);
      const dur = Number(j.format?.duration || 0);
      const v = (j.streams || []).find((s) => s.codec_type === "video");
      const hasAudio = (j.streams || []).some((s) => s.codec_type === "audio");
      parts.push(`${dur.toFixed(1)}s`);
      if (v) parts.push(`${v.width}×${v.height}`);
      if (VIDEO_EXT.test(p)) parts.push(hasAudio ? "有音轨" : "无音轨");
      if (!(dur > 0)) level = "fail";
    } catch (e) {
      return { level: "fail", detail: `${path.basename(p)} ffprobe 读取失败（文件可能损坏）` };
    }
  } else if (IMAGE_EXT.test(p)) {
    try {
      const out = execFileSync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", p], { encoding: "utf8", timeout: 10_000 });
      const w = out.match(/pixelWidth: (\d+)/)?.[1];
      const h = out.match(/pixelHeight: (\d+)/)?.[1];
      if (w && h) parts.push(`${w}×${h}`);
    } catch {}
  }
  parts.push(fmtSize(st.size), fmtAge(age));
  if (level === "warn") parts.push("（超过 2 小时，可能不是本轮产物）");
  return { level, detail: parts.join(" · ") };
}

async function proofUrl(target) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(target, { signal: ctrl.signal, redirect: "follow" });
    const full = await r.text();
    const body = full.slice(0, 8000);
    const notes = [];
    if (/\bmock(ed)?\b|\bfake\b|\bdummy\b|lorem ipsum|假数据|模拟数据|演示数据|\bSAMPLE_/i.test(body)) notes.push("响应里有 mock/假数据 字样");
    if (/coming soon|hello,? world|it works!|placeholder|under construction|敬请期待|建设中|Welcome to nginx/i.test(body)) notes.push("像占位页");
    if (full.replace(/\s/g, "").length < 200) notes.push(`响应只有 ${full.length} 字节，看不出真实业务内容`);
    let host = "";
    try {
      host = new URL(target).hostname;
    } catch {}
    const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])|trycloudflare\.com$|ngrok/i.test(host);
    const otherNotes = notes.length;
    if (local) notes.push("本机/临时隧道地址，不能当作生产已上线");
    const level = !r.ok ? "fail" : notes.length ? "warn" : "ok";
    return { level, local, otherNotes, detail: `${target} → HTTP ${r.status}${notes.length ? `（${notes.join("；")}）` : ""}` };
  } catch (e) {
    return { level: "fail", detail: `${target} 访问失败：${String(e.name === "AbortError" ? "10 秒超时" : e.message || e).slice(0, 80)}` };
  } finally {
    clearTimeout(t);
  }
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "out", "coverage", ".venv", "venv", "__pycache__", "_backup_20261106"]);
const CODE_EXT = /\.(m?[jt]sx?|py|html|vue|svelte|go|rb)$/i;
const MOCK_RE = new RegExp(
  [
    String.raw`\b(mock(ed|Data|Response)?|fake[A-Z_a-z]*|dummy|lorem)\b`,
    String.raw`\bSAMPLE_[A-Z_]+\b`,
    String.raw`\b(sample|demo|seed|stub)(Data|History|Videos?|Results?|Mode|Response)\b`,
    String.raw`假数据|演示数据|示例数据|硬编码|模拟(数据|进度|生成|返回)`,
    String.raw`sample\.mp4`,
    String.raw`setTimeout\([^)]*(progress|done|complete)`,
  ].join("|")
);

/** 扫描目录里的 Mock / 空壳特征（跳过测试目录与依赖目录） */
export function scanMocks(dir, maxFiles = 3000) {
  const hits = [];
  let files = 0;
  const walk = (d) => {
    if (files >= maxFiles) return;
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (files >= maxFiles) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || /^(tests?|__tests__|__mocks__|fixtures)$/i.test(e.name)) continue;
        walk(p);
      } else if (CODE_EXT.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
        files++;
        let txt = "";
        try {
          if (fs.statSync(p).size > 500_000) continue;
          txt = fs.readFileSync(p, "utf8");
        } catch {
          continue;
        }
        const lines = txt.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (MOCK_RE.test(lines[i]) && !/placeholder=/.test(lines[i])) {
            hits.push({ file: path.relative(dir, p), line: i + 1, text: lines[i].trim().slice(0, 80) });
          }
        }
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { files, count: hits.length, hits };
}

function proofMock(dir) {
  if (!fs.existsSync(dir)) return { level: "fail", detail: `mock 扫描目录不存在：${dir}` };
  const r = scanMocks(dir);
  if (r.count === 0) return { level: "ok", detail: `${dir} 扫描 ${r.files} 个代码文件，未发现 mock/fake/TODO 特征` };
  const top = r.hits
    .slice(0, 3)
    .map((h) => `${h.file}:${h.line}`)
    .join("、");
  return { level: "warn", detail: `${dir} 发现 ${r.count} 处 mock/fake/TODO 特征（${top}…）→ 按【原型/Mock】对待`, mock: true };
}

const PROXY_ENV = {
  ...process.env,
  HTTPS_PROXY: "http://127.0.0.1:7897",
  HTTP_PROXY: "http://127.0.0.1:7897",
  ALL_PROXY: "socks5h://127.0.0.1:7897",
  NO_PROXY: "localhost,127.0.0.1,::1,.local",
};

/** 调研证据：文件里必须有足够多的真实来源链接，并抽查能否打开（防"嘴上说调研了"） */
function proofResearch(target) {
  const p = path.resolve(target);
  if (!fs.existsSync(p)) return { level: "fail", detail: `调研证据文件不存在：${p}` };
  const txt = fs.readFileSync(p, "utf8");
  const urls = Array.from(new Set((txt.match(/https?:\/\/[^\s)\]>"'`，。、]+/g) || []).map((u) => u.replace(/[.,;:!?]+$/, ""))));
  const chars = txt.replace(/\s/g, "").length;
  if (urls.length === 0) return { level: "fail", detail: `${path.basename(p)} 里一个来源链接都没有（${chars} 字）→ 不算调研` };
  const sample = urls.slice(0, 6);
  let alive = 0;
  const dead = [];
  for (const u of sample) {
    const r = spawnSync("/usr/bin/curl", ["-sS", "-o", "/dev/null", "-L", "-m", "8", "-A", "Mozilla/5.0", "-w", "%{http_code}", u], {
      encoding: "utf8",
      env: PROXY_ENV,
      timeout: 12_000,
    });
    const code = Number((r.stdout || "").trim());
    if (code && code < 500 && code !== 404 && code !== 410) alive++;
    else dead.push(`${u.slice(0, 40)}(${code || "无响应"})`);
  }
  const level = urls.length >= 5 && alive >= Math.min(3, sample.length) ? "ok" : alive === 0 ? "fail" : "warn";
  return {
    level,
    detail: `${path.basename(p)} · ${chars} 字 · ${urls.length} 个来源链接 · 抽查 ${sample.length} 个能打开 ${alive} 个${dead.length ? `（打不开：${dead.slice(0, 2).join("、")}）` : ""}${urls.length < 5 ? " · 来源少于 5 个" : ""}`,
  };
}

/** spec 形如 file:/abs/x.mp4 | url:http://... | mock:/abs/dir | research:/abs/证据.md
 *  cmd: 已停用——模型自己写的命令不能当考题（谁被验收谁出题），检查项只认 rules.json 里预设的 acceptance */
export async function runProof(spec, { cwd }) {
  const idx = spec.indexOf(":");
  const kind = idx > 0 ? spec.slice(0, idx) : "";
  const target = idx > 0 ? spec.slice(idx + 1) : spec;
  let r;
  if (kind === "file") r = proofFile(target);
  else if (kind === "url") r = await proofUrl(target);
  else if (kind === "cmd") r = { level: "fail", detail: "cmd: 回执已停用：检查项只认 rules.json 预设，不接受自带命令" };
  else if (kind === "mock") r = proofMock(target);
  else if (kind === "research") r = proofResearch(target);
  else r = { level: "fail", detail: `无法识别的回执类型「${spec}」（可用 file: / url: / mock: / research:）` };
  return { kind, target, ...r };
}

const NEGATED = /(未|没有?|尚未|还没有?|待|未能|无法|没能)(完成|上线|跑通|就绪|部署|交付|渲染|修复|做好|搞定|做完|写完|改完|改好|写好|弄完|跑完)/g;
// 「已就绪的工具」「上线前」这类是形容/计划，不算交差；(?![的前时]) 排除定语和时间状语
const CLAIM = /(已?完成|搞定|上线|跑通|已部署|部署好|已交付|交付了|渲染好|渲染完|做好了|已修复|修好了|全部通过|测试通过|做完|写完|改完|弄完|跑完|改好了|写好了|全改好|都改好|出好了|已经好了)(?![的前时])/;

const RESEARCH_NEG = /(没|未|还没|尚未)(有)?(做|跑|完成)?[^。\n]{0,4}(调研|Deep Research|深度研究|检索|查证)/gi;
const RESEARCH_CLAIM = /(已|完成了?|做了|做完|跑了|跑完|深度|实测|真实)[^。\n]{0,10}(调研|Deep Research|深度研究|检索|对标|查证|搜索|抓取|拆解)|(调研|Deep Research|深度研究|查证|检索)[^。\n]{0,8}(完成|做完|跑完|结果|结论|发现|显示)|(根据|参考|对标)[^。\n]{0,10}(小红书|点点|B站|知乎|GitHub|调研|爆款)/i;

export function detectResearchClaim(text) {
  return RESEARCH_CLAIM.test(String(text || "").replace(RESEARCH_NEG, ""));
}

// 「改完发你」「做完再说」这类是计划不是声明；问句也不算
const FUTURE = /(做|写|改|弄|跑|渲染)完(?!了)\s*(后|就|再|之后|以后|发|给|告诉|马上)/g;
export function detectCompletionClaim(text) {
  const sentences = String(text || "")
    .replace(NEGATED, "")
    .replace(FUTURE, "")
    .split(/(?<=[。！!？?\n])/)
    .filter((x) => !/[？?]\s*$/.test(x.trim()));
  return sentences.some((x) => CLAIM.test(x));
}

/**
 * 身份声明检测（GPT 二审 P1-1）：正文是否声称 Claude / Codex「已经」干过活。
 * 按分句（。！？；，、换行）逐句判：
 *   - 句里提到引擎 + 完成态标记（已/了/过/经/由/通过/完成/指出/抓出/清单/意见…）→ 声明
 *   - 句里提到引擎 + 将来/进行时（正在/准备/随后/立即/马上/打算/待…）且没有完成态 → 计划，不算
 *   - 否定句（没调 / 还没让 / 未经）→ 不算
 *   - 中性句（「Claude 盲审：9 分」「Claude 审查结论」）只要带动作词 → 按声明从严
 * 返回引擎列表；detectEngineClaimClauses 返回具体命中的分句（用于改写打标）。
 */
const ENGINE_PATTERNS = {
  claude: /Claude(\s*(CLI|Code|Opus|Sonnet|Haiku))?|克劳德|\bOpus\b|\bSonnet\b|\bHaiku\b/i,
  codex: /Codex|codex\s+exec|GPT[-\s]?\d*(\.\d)?|ChatGPT/i,
};
const ENGINE_NEG = /(没有?|未|尚未|还没有?|并没有?|不是|没再|别|不要|无需|不用|未经)[^，。]{0,6}(调|用|让|请|交|经|叫|跑|给|由)?[^，。]{0,4}(Claude|克劳德|Opus|Sonnet|Codex|GPT)/i;
const ENGINE_FUTURE = /(正在|准备|打算|计划|即将|将要|将会|马上|立刻|立即|随后|稍后|待会|等会|一会儿?|接下来|下一步|然后再?|之后再?|回头|待|拟|排队|这就|现在就|我去|我会|我来|会去|再去|要去|去调|再调|启动|开始|发起)/;
// 强完成态：有它就是在说「已经做了」，哪怕同句里有「正在」
const ENGINE_PAST_STRONG = /(已经?|[^为除]了(?!解)|(审|看|跑|调|用|测|改|查|评|读|过目|把关)过|经过?|由\s*|通过|完成了?|完毕|出炉|出结果|给出|指出|抓出|挑出|发现|认为|确认|判定|打了?\s*\d|签字|背书|(清单|意见|建议|报告|结论|反馈|审计|评分|打分)(里|中|上|显示|要求|指出)?)/;
const ENGINE_ACTION = /(完成|写|做|审|跑|出|改|生成|渲染|重构|盲审|复审|挑刺|评|核|验)/;

export function detectEngineClaimClauses(text) {
  const t = String(text || "")
    .replace(/\*\*/g, "")
    .replace(/(做|写|改|弄|跑|审|渲染)完(?!了)\s*(后|就|再|之后|以后|发|给|告诉|马上)/g, "$1");
  const clauses = t.split(/(?<=[。！!？?；;，,\n])/);
  const out = [];
  for (const raw of clauses) {
    const c = raw.trim();
    if (!c || /[？?]\s*$/.test(c)) continue;
    for (const [engine, re] of Object.entries(ENGINE_PATTERNS)) {
      if (!re.test(c)) continue;
      if (ENGINE_NEG.test(c)) continue;
      const past = ENGINE_PAST_STRONG.test(c);
      const future = ENGINE_FUTURE.test(c);
      if (past || (!future && ENGINE_ACTION.test(c))) out.push({ engine, clause: c });
    }
  }
  return out;
}

export function detectEngineClaims(text) {
  return [...new Set(detectEngineClaimClauses(text).map((x) => x.engine))];
}

/** 把查无调用记录的身份声明分句就地打标，防止截图里只看到「Claude 审过了」 */
export function markUnverifiedEngineClaims(text, engines) {
  let t = String(text || "");
  const set = new Set(engines);
  const seen = new Set();
  for (const { engine, clause } of detectEngineClaimClauses(t)) {
    if (!set.has(engine) || seen.has(clause)) continue;
    seen.add(clause);
    const label = engine === "claude" ? "Claude" : "Codex/GPT";
    const body = clause.replace(/[。！!；;，,\n]+$/, "");
    const i = t.indexOf(body);
    if (i >= 0) t = `${t.slice(0, i)}〔未核实·查无${label}调用〕${body}${t.slice(i + body.length)}`;
  }
  return t;
}

function newestMtimeUnder(dir, depth = 2) {
  let newest = 0;
  const walk = (d, lv) => {
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && lv < depth) walk(p, lv + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          newest = Math.max(newest, fs.statSync(p).mtimeMs);
        } catch {}
      }
    }
  };
  walk(dir, 0);
  return newest;
}

/**
 * 近 N 小时是否真有 Claude CLI / Codex 调用（自有 ledger + 引擎原生会话记录双源）。
 * 传 cwd 时只认该项目目录（含子目录）下的调用；不传则全局判断并在 source 里注明。
 */
export async function hasEngineEvidence(engine, hours = 6, cwd = null) {
  const since = Date.now() - hours * 3600_000;
  const inScope = (dir) => !cwd || (dir && (dir === cwd || dir.startsWith(`${cwd}/`)));
  const scopeLabel = cwd ? `（限 ${path.basename(cwd)} 目录）` : "（全局，未限定项目）";
  const ledgerHit = readJsonlTail(DELEGATIONS_FILE, 500).some(
    // 只读审查（role/mode = review）不算「该引擎在项目里干过活」，否则审一次就能洗白 6 小时（审计 P0-3）
    (d) => d.engine === engine && !d.test && d.role !== "review" && d.mode !== "review" && new Date(d.ts).getTime() >= since && inScope(d.cwd)
  );
  if (ledgerHit) return { ok: true, source: `delegations.jsonl${scopeLabel}` };
  if (engine === "claude" && fs.existsSync(CLAUDE_CLI_PROJECTS)) {
    const slug = cwd ? cwd.replace(/[^A-Za-z0-9]/g, "-") : null;
    for (const d of fs.readdirSync(CLAUDE_CLI_PROJECTS)) {
      if (slug && d !== slug && !d.startsWith(`${slug}-`)) continue;
      if (newestMtimeUnder(path.join(CLAUDE_CLI_PROJECTS, d), 1) >= since) return { ok: true, source: `~/.claude-cli 会话记录${scopeLabel}` };
    }
  }
  if (engine === "codex" && fs.existsSync(CODEX_DB)) {
    try {
      const sqlite = await import("node:sqlite");
      const db = new sqlite.DatabaseSync(CODEX_DB, { readOnly: true });
      const row = cwd
        ? db.prepare("SELECT MAX(source_updated_at) AS t FROM local_thread_catalog WHERE cwd = ? OR cwd LIKE ?").get(cwd, `${cwd}/%`)
        : db.prepare("SELECT MAX(source_updated_at) AS t FROM local_thread_catalog").get();
      db.close();
      if ((row?.t || 0) * 1000 >= since) return { ok: true, source: `codex.db 会话记录${scopeLabel}` };
    } catch {}
  }
  return { ok: false, source: null, scope: scopeLabel };
}

// ───────── 项目验收模板（rules.json routes[*].acceptance）：「完成」的最低证据由配置决定，不由 Agent 决定 ─────────

const DOC_EXT = /\.(md|markdown|txt|docx|pdf)$/i;
const FRESH_MS = 2 * 3600_000;

function isFresh(p) {
  try {
    return Date.now() - fs.statSync(p).mtimeMs <= FRESH_MS;
  } catch {
    return false;
  }
}

const KIND_LABEL = { doc: "2 小时内生成的文稿文件", video: "2 小时内生成、能读出时长的视频", url: "能访问的地址", file: "2 小时内生成的交付文件" };

/**
 * results: runProof 结果数组；acceptance: rules.routes[key].acceptance
 * 返回 { defined, satisfied, missing[], evidence[], mock }
 */
export function checkAcceptance(acceptance, results, claimText = "") {
  if (!acceptance || !Array.isArray(acceptance.kinds) || acceptance.kinds.length === 0) return { defined: false };
  const okFiles = results.filter((r) => r.kind === "file" && r.level === "ok").map((r) => path.resolve(r.target));
  const evidence = [];
  for (const k of acceptance.kinds) {
    if (k === "doc") evidence.push(...okFiles.filter((p) => DOC_EXT.test(p) && isFresh(p)));
    else if (k === "video") evidence.push(...okFiles.filter((p) => VIDEO_EXT.test(p) && isFresh(p)));
    else if (k === "file") evidence.push(...okFiles.filter((p) => isFresh(p)));
    else if (k === "url") {
      // 本机/临时隧道地址算「本机可用」；只有声称上线/生产/公网时才不认
      const claimsProd = /上线|生产|公网|正式|对外|发布/.test(String(claimText));
      evidence.push(
        ...results
          .filter((r) => r.kind === "url" && (r.level === "ok" || (r.level === "warn" && r.local && !r.otherNotes && !claimsProd)))
          .map((r) => r.target)
      );
    }
  }
  const mock = results.some((r) => r.mock);
  const missing = [];
  if (evidence.length === 0) missing.push(`没有合格交付物（需要：${acceptance.kinds.map((k) => KIND_LABEL[k] || k).join(" 或 ")}）`);
  if (acceptance.mockScan && mock) missing.push("代码里有 mock/假数据特征，只能算原型");
  if (results.some((r) => r.level === "fail")) missing.push("有回执核验失败");
  return { defined: true, satisfied: missing.length === 0, missing, evidence: Array.from(new Set(evidence)), mock };
}
