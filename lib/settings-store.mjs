import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SETTINGS = Object.freeze({
  scanInterval: 60,
  highUsageThreshold: 30000,
});

export function normalizeSettings(input = {}) {
  const normalized = { ...DEFAULT_SETTINGS };

  if (input && typeof input.scanInterval !== "undefined") {
    const parsed = Number(input.scanInterval);
    if (Number.isFinite(parsed) && parsed >= 5) {
      normalized.scanInterval = Math.round(parsed);
    }
  }

  if (input && typeof input.highUsageThreshold !== "undefined") {
    const parsed = Number(input.highUsageThreshold);
    if (Number.isFinite(parsed) && parsed >= 0) {
      normalized.highUsageThreshold = Math.round(parsed);
    }
  }

  return normalized;
}

export async function loadSettings(dataDir, hostConfig = null) {
  if (dataDir && path.isAbsolute(dataDir)) {
    const filePath = path.join(dataDir, "settings.json");
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return normalizeSettings(parsed);
    } catch {
      // settings.json 尚不存在时，尝试从宿主旧 config 兼容读取
    }
  }

  const fallback = { ...DEFAULT_SETTINGS };
  try {
    if (typeof hostConfig?.get === "function") {
      const val = await hostConfig.get("scanInterval");
      if (typeof val === "number" && val >= 5) {
        fallback.scanInterval = Math.round(val);
      }
    }
  } catch {}

  return fallback;
}

export async function saveSettings(dataDir, settings) {
  if (!dataDir || !path.isAbsolute(dataDir)) {
    throw new Error("插件数据目录不可用");
  }
  const normalized = normalizeSettings(settings);
  const filePath = path.join(dataDir, "settings.json");
  const temporary = `${filePath}.tmp`;

  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, JSON.stringify(normalized, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }

  return normalized;
}
