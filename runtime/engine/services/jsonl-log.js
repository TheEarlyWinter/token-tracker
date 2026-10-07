// 追加式 JSONL 小工具：一行一条 JSON，只追加不重写。
//
// 崩溃安全约定：
//   写 —— 追加前若文件末尾不是换行（上一次写入被中断留下的半截行），先补一个换行把它封口，
//         再追加完整行，最后 fsync。这样任何一次中断最多留下一行「解析不了」的尾巴。
//   读 —— 逐行 JSON.parse，解析失败的行只计数跳过。半截尾巴因此永远不会污染数据。
//
// 这里只负责字节层，不关心记录语义；调用方自己按 key 去重（后写覆盖先写）。
import fs from "node:fs";
import path from "node:path";

// 追加记录（对象数组）。返回写入字节数；records 为空时零写入。
export function appendJsonLines(file, records) {
  if (!records || !records.length) return 0;
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const fd = fs.openSync(file, "a+"); // a+：可读可写，写总是落在末尾
  try {
    const st = fs.fstatSync(fd);
    if (st.size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, st.size - 1);
      if (last[0] !== 0x0a) fs.writeSync(fd, "\n"); // 封住半截行
    }
    fs.writeSync(fd, text);
    try { fs.fsyncSync(fd); } catch {}
  } finally {
    fs.closeSync(fd);
  }
  return Buffer.byteLength(text);
}

// 读取全部记录。返回 { records, skipped, bytes }：
//   records 是解析成功的对象按出现顺序排列；skipped 是解析失败的行数。
export function readJsonLines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch (e) {
    if (e && e.code === "ENOENT") return { records: [], skipped: 0, bytes: 0 };
    throw e;
  }
  const records = [];
  let skipped = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") records.push(v);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped, bytes: Buffer.byteLength(raw) };
}

// 把 file 改名留底到 file + suffix（如 .imported）。若目标已存在，绝不删除/覆盖它，
// 改用 file + suffix + "-<时间戳>"。返回实际备份路径。
export function renameToBackup(file, suffix = ".imported") {
  const base = file + suffix;
  let dest = base;
  if (fs.existsSync(base)) {
    let ts = Date.now();
    while (fs.existsSync(base + "-" + ts)) ts += 1;
    dest = base + "-" + ts;
  }
  fs.renameSync(file, dest);
  return dest;
}

// 原子写文本：tmp + fsync + rename。失败时清理 tmp，绝不留半截目标文件。
export function writeFileAtomic(file, text, mode = 0o600) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "w", mode);
    fs.writeSync(fd, text);
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}
