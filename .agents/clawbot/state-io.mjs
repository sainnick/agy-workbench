/**
 * 共享 JSON 状态读写（bridge / agy-route / weixin-send / job-runner 多进程并发安全）
 * - 原子写：先写临时文件再 rename，读者永远读不到半截 JSON
 * - 互斥：mkdir 目录锁，10 秒以上的残留锁自动清理
 * - 解析失败绝不回落默认值再覆盖：先试 .bak，仍失败就抛错，原文件原样保留
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

function parseFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** 读 JSON。文件不存在返回 fallback；损坏时尝试 .bak；都失败抛错。 */
export function readJson(file, fallback) {
  if (!fs.existsSync(file)) return structuredClone(fallback);
  for (let i = 0; i < 3; i++) {
    try {
      return parseFile(file);
    } catch {
      sleepSync(30);
    }
  }
  const bak = `${file}.bak`;
  if (fs.existsSync(bak)) {
    try {
      return parseFile(bak);
    } catch {}
  }
  throw new Error(`[state-io] ${path.basename(file)} 解析失败且无可用 .bak，拒绝用默认值覆盖`);
}

export function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
    } catch {}
  }
  fs.renameSync(tmp, file);
}

function acquireLock(file, timeoutMs = 5000) {
  const lockDir = `${file}.lock`;
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      return () => {
        try {
          fs.rmdirSync(lockDir);
        } catch {}
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > 10_000) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch {}
      if (Date.now() - start > timeoutMs) {
        throw new Error(`[state-io] 等待 ${path.basename(file)} 锁超时`);
      }
      sleepSync(25);
    }
  }
}

/** 加锁 → 读 → mutator(obj) 原地修改或返回新对象 → 原子写 → 解锁。返回写入后的对象。 */
export function updateJson(file, fallback, mutator) {
  const release = acquireLock(file);
  try {
    const cur = readJson(file, fallback);
    const next = mutator(cur) ?? cur;
    writeJsonAtomic(file, next);
    return next;
  } finally {
    release();
  }
}

export function appendJsonl(file, obj) {
  try {
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n", "utf8");
  } catch (e) {
    console.error(`[state-io] 账本写入失败 ${file}: ${String(e?.message || e)}`);
  }
}

export function readJsonlTail(file, n = 200) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(-n);
  const out = [];
  for (const l of lines) {
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
}
