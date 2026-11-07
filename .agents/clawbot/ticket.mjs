/**
 * 一次性任务票据的 HMAC-SHA256 签名（GPT 二审 P1-1）
 *
 * job-runner 发票：jobs/tickets/<nonce>.json 里除业务字段外带 sig = HMAC(secret, 规范串)；
 * weixin-send 验票：密钥文件缺失 / 权限不是 0600 / 签名不符 → 一律当作无票（普通窗口消息）。
 *
 * 密钥：~/.claude-cli/.ticket_secret（32 字节随机，0600）。只有 job-runner 会在缺失时创建，验票方绝不创建。
 * 测试可用 CLAWBOT_TICKET_SECRET_FILE 指向临时密钥。
 *
 * 边界（如实写明）：同一 macOS 用户下的进程仍能读到这个文件；HMAC 防的是「手写一份 JSON 票据就冒充系统」，
 * 不是操作系统级隔离。真正隔离需要把 job-runner 跑在独立用户/钥匙串下。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const TICKET_SECRET_FILE = process.env.CLAWBOT_TICKET_SECRET_FILE || path.join(os.homedir(), ".claude-cli", ".ticket_secret");
const FIELDS = ["nonce", "jobId", "engine", "role", "createdAt", "pid"];

/** 读密钥；create=true 时缺失则以 0600 原子创建。权限过宽直接拒用（返回 null）。 */
export function loadTicketSecret({ create = false } = {}) {
  const f = TICKET_SECRET_FILE;
  if (!fs.existsSync(f)) {
    if (!create) return null;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try {
      fs.writeFileSync(f, crypto.randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  try {
    const st = fs.statSync(f);
    if ((st.mode & 0o077) !== 0) return null; // 组/其他人可读写 → 不可信
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
    const s = fs.readFileSync(f, "utf8").trim();
    return s.length >= 32 ? s : null;
  } catch {
    return null;
  }
}

function canonical(t) {
  return ["v1", ...FIELDS.map((k) => String(t?.[k] ?? ""))].join("|");
}

export function signTicket(t, secret) {
  return crypto.createHmac("sha256", secret).update(canonical(t)).digest("hex");
}

/** 签名正确返回 true；无密钥、无签名、长度不符、内容被改都返回 false */
export function verifyTicketSig(t, secret = loadTicketSecret()) {
  if (!secret || !t || typeof t.sig !== "string" || !/^[0-9a-f]{64}$/.test(t.sig)) return false;
  const want = Buffer.from(signTicket(t, secret), "hex");
  const got = Buffer.from(t.sig, "hex");
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
