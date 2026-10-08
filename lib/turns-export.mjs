import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Export only into the App-owned data root. Never accept a destination from UI.
export async function saveTurnsExport({ dataDir, csv, rowCount, now = new Date() }) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error("插件导出目录不可用");
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  const filename = `token-turns-${date}-${randomUUID()}.csv`;
  const directory = path.join(dataDir, "exports");
  const file = path.join(directory, filename);
  const temporary = `${file}.tmp`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, csv, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { saved: true, filename, path: file, rowCount, bytes: Buffer.byteLength(csv, "utf8") };
}
