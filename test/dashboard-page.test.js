import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { renderDashboardHtml, syncDashboardEntries } from "../lib/dashboard-page.mjs";

test("renderDashboardHtml generates consistent structure with specified version and theme", () => {
  const html = renderDashboardHtml({
    version: "6.4.12",
    theme: "dark",
    basePath: "/custom/path",
    standalone: true,
  });

  assert.match(html, /data-ui-version="6\.4\.12"/);
  assert.match(html, /data-hana-theme="dark"/);
  assert.match(html, /href="\/custom\/path\/base\.css"/);
  assert.match(html, /src="\/custom\/path\/bootstrap\.js"/);
  assert.match(html, /src="\/custom\/path\/vendor\/chart\.umd\.min\.js"/);
});

test("syncDashboardEntries writes matching index.html and versioned entry", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-html-sync-"));
  try {
    fs.mkdirSync(path.join(tmpDir, "ui"));
    syncDashboardEntries(tmpDir, "6.4.12");

    const indexHtml = fs.readFileSync(path.join(tmpDir, "ui/index.html"), "utf8");
    const versionedHtml = fs.readFileSync(path.join(tmpDir, "ui/dashboard-v6.4.12.html"), "utf8");

    assert.equal(indexHtml, versionedHtml);
    assert.match(indexHtml, /data-ui-version="6\.4\.12"/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
