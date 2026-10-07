import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  formatToken,
  formatAxisToken,
  formatCny,
  formatDual,
  convertToUsd,
  formatDualByCurrency,
  formatLocalTime,
} from "../ui/dashboard-format.js";

test("escapeHtml safely escapes special HTML characters", () => {
  assert.equal(escapeHtml('<script>alert("xss")&</script>'), "&lt;script&gt;alert(&quot;xss&quot;)&amp;&lt;/script&gt;");
  assert.equal(escapeHtml(""), "");
  assert.equal(escapeHtml(null), "");
});

test("formatToken and formatAxisToken render compact token representations", () => {
  assert.equal(formatToken(0), "0");
  assert.equal(formatToken(1500), "1.5k");
  assert.equal(formatToken(2500000), "2.5M");
  assert.match(formatToken(200000000), /2\.0亿/);

  assert.equal(formatAxisToken(0), "0");
  assert.equal(formatAxisToken(1500), "1.5k");
  assert.equal(formatAxisToken(2500000), "2.5M");
  assert.equal(formatAxisToken(200000000), "2.0亿");
});

test("formatDual and formatDualByCurrency respect FX rate and currency preference", () => {
  assert.equal(formatDual(0, null, "CNY"), "$0");
  assert.equal(formatDual(10, 7.2, "CNY"), "¥72.00");
  assert.equal(formatDual(10, 7.2, "USD"), "$10.00");
  assert.equal(formatCny(10, 7.2), "¥72.00");
  assert.equal(formatCny(10, null), "");

  assert.equal(convertToUsd(72, "CNY", 7.2), 10);
  assert.equal(convertToUsd(72, "CNY", null), null);

  assert.equal(formatDualByCurrency(72, "CNY", null, "CNY"), "¥72.00");
  assert.equal(formatDualByCurrency(72, "CNY", 7.2, "USD"), "$10.00");
});
