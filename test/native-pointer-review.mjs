// Run separately: node test/native-pointer-review.mjs (Chrome and Node WebSocket required).
// Uses a fresh browser profile, fake API replies, and real mouse down/up. Never attaches to Hana.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<!doctype html><meta charset="utf-8"><title>Isolated pointer regression</title>');
    return;
  }
  const path = resolve(root, `.${pathname}`);
  if (!path.startsWith(join(root, "ui") + sep) || !path.endsWith(".js")) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(path);
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const profile = await mkdtemp(join(tmpdir(), "tt-native-pointer-"));
const chrome = spawn(process.env.CHROME_BIN || "/usr/bin/google-chrome", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
  "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let ws;
let timeout;
try {
  await Promise.race([
    run(),
    new Promise((_, reject) => { timeout = setTimeout(() => reject(Error("Native pointer test timed out")), 20000); }),
  ]);
} finally {
  clearTimeout(timeout);
  ws?.close();
  chrome.kill("SIGTERM");
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
}

async function run() {
  const endpoint = await new Promise((resolveReady, reject) => {
    let stderr = "";
    chrome.stderr.on("data", chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolveReady(match[1]);
    });
    chrome.once("error", reject);
    chrome.once("exit", code => reject(Error(`Chrome exited before readiness: ${code}`)));
  });
  ws = new WebSocket(endpoint);
  await once(ws, "open");
  let nextId = 0;
  const pending = new Map();
  const events = new Set();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    } else {
      for (const listener of events) listener(message);
    }
  };
  const call = (method, params = {}, sessionId) => new Promise((resolveCall, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveCall, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => call(method, params, sessionId);
  await send("Page.enable");
  const loaded = new Promise(resolveLoaded => {
    const listener = message => {
      if (message.sessionId === sessionId && message.method === "Page.loadEventFired") {
        events.delete(listener);
        resolveLoaded();
      }
    };
    events.add(listener);
  });
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  await loaded;
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await evaluate(`(async () => {
    document.body.innerHTML = '<div id="fp-codex-section"><div id="codex-card-slot"></div></div><div id="fp-deepseek-section"></div><div id="fp-lithos-section"></div><div id="lithos-card-slot"></div><div id="fp-empty-notice"></div><button id="fp-refresh">刷新</button>';
    window.pointerEvents = [];
    window.listFetches = 0;
    window.refreshVersion = 0;
    window.BroadcastChannel = class { addEventListener() {} removeEventListener() {} postMessage() {} };
    window.fetch = async url => {
      const path = String(url);
      const updated = window.refreshVersion > 0;
      const data = path.includes('/settings') ? {showCodexQuota:true,showDeepseekBalance:false}
        : path.includes('/codex-reset-credits') ? (window.listFetches++, {connected:true,credits:[]})
        : path.includes('/codex-quota') ? {connected:true,planLabel:updated?'Team':'Plus',resetCredits:updated?3:2,creditsBalance:updated?'20':'10',primary:{remainingPercent:updated?70:80}}
        : {connected:false,configured:false};
      return {ok:true,json:async()=>data};
    };
    await import('/ui/function-panel.js');
    for (const type of ['pointerdown','pointerup','click']) {
      document.addEventListener(type, event => window.pointerEvents.push([type,event.target.id]), true);
    }
    let first = true;
    document.addEventListener('pointerdown', event => {
      if (first && event.target.id === 'sb-codex-credit-toggle') {
        first = false;
        window.originalButton = event.target;
        window.refreshVersion = 1;
        window.dispatchEvent(new Event('focus'));
      }
    }, true);
    await new Promise(resolveReady => setTimeout(resolveReady,20));
  })()`);
  const point = await evaluate(`(() => {
    const bounds = document.getElementById('sb-codex-credit-toggle').getBoundingClientRect();
    return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};
  })()`);
  const click = async () => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    // Let the real function-panel focus handler complete its API refresh while held.
    await evaluate("new Promise(resolveWait=>setTimeout(resolveWait,60))");
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    await evaluate("new Promise(resolveWait=>setTimeout(resolveWait,500))");
  };
  await click();
  const first = await evaluate(`({
    events:window.pointerEvents,connected:window.originalButton.isConnected,
    sameButton:window.originalButton===document.getElementById('sb-codex-credit-toggle'),
    buttonText:document.getElementById('sb-codex-credit-toggle').textContent,
    modal:document.getElementById('sb-codex-reset-modal').style.display,listFetches:window.listFetches,
    badges:document.querySelector('.sb-codex-badges').textContent,
    quota:document.querySelector('.sb-codex-body').textContent
  })`);
  console.log("First native click:", JSON.stringify(first));
  assert.equal(first.connected, true, "refresh detached the pressed button");
  assert.equal(first.sameButton, true, "refresh replaced the pressed button");
  assert.equal(first.modal, "flex", "first native click did not open the modal");
  assert.equal(first.listFetches, 1, "first click must fetch exactly once");
  assert.equal(first.events.filter(([type,id])=>type==="click"&&id==="sb-codex-credit-toggle").length,1);
  assert.match(first.buttonText, /卡 3/);
  assert.match(first.badges, /Team/);
  assert.match(first.badges, /20/);
  assert.match(first.quota, /70%/);
  await evaluate(`(async()=>{
    document.getElementById('sb-codex-reset-modal').style.display='none';
    for(let i=0;i<3;i++){
      window.dispatchEvent(new Event('focus'));
      await new Promise(resolveWait=>setTimeout(resolveWait,20));
    }
  })()`);
  await click();
  const repeated = await evaluate(`({listFetches:window.listFetches,modal:document.getElementById('sb-codex-reset-modal').style.display})`);
  assert.equal(repeated.listFetches, 2, "refresh accumulated click handlers");
  assert.equal(repeated.modal, "flex");
  console.log("PASS: first native mouse click survives focus refresh; data updates; repeated refresh keeps one handler.");
}
