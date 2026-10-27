// runtime/engine/services/platform.js
// 宿主机上的路径约定：Hana home 的解析与文本读取。
//
// 引擎以 local-machine 档运行时，文件系统不隔离，可以直接读宿主自己的数据文件。
// 路径解析与宿主保持一致：HANA_HOME 显式覆盖优先，否则退回 <用户目录>/.hanako。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveHanaHome({ env = process.env, platform = process.platform, homedir = os.homedir } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (env.HANA_HOME) {
    let override = env.HANA_HOME;
    if (override === "~" || override.startsWith("~/") || (platform === "win32" && override.startsWith("~\\"))) {
      const home = platform === "win32" ? (env.USERPROFILE || homedir()) : (env.HOME || homedir());
      override = paths.join(home, override.slice(2));
    }
    return paths.resolve(override);
  }
  const userHome = platform === "win32" ? (env.USERPROFILE || homedir()) : (env.HOME || homedir());
  return paths.join(userHome, ".hanako");
}

// Windows 上的编辑器会写 UTF-8 BOM 与 CRLF，JSON.parse 不接受 BOM。
export function readTextFile(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}
