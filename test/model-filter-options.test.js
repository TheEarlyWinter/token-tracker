import test from "node:test";
import assert from "node:assert/strict";
import "../ui/model-filter-options.js";

const { normalizeModelOptions } = globalThis.TokenTrackerModelOptions;

test("模型筛选支持后端返回的字符串 modelOptions", () => {
  assert.deepEqual(
    normalizeModelOptions(["deepseek-chat", "gpt-5.6-luna"]),
    ["deepseek-chat", "gpt-5.6-luna"],
  );
});

test("兼容模型对象，并跳过缺少有效 id 的条目和重复项", () => {
  assert.deepEqual(
    normalizeModelOptions(["deepseek-chat", null, {}, { id: "gpt-5.6-luna" }, { id: "deepseek-chat" }, { id: "" }]),
    ["deepseek-chat", "gpt-5.6-luna"],
  );
});

test("modelOptions 缺失时可回退到模型对象列表", () => {
  assert.deepEqual(
    normalizeModelOptions(undefined, [{ id: "claude-sonnet" }, { modelId: "ignored-without-id" }]),
    ["claude-sonnet"],
  );
});

test("字符串模型 ID 渲染为可见选项，不泄漏 undefined", () => {
  const html = globalThis.TokenTrackerModelOptions.renderModelFilterOptions(
    ["deepseek-chat", "gpt-5.6-luna"],
    [],
    "",
  );

  assert.match(html, /data-v="deepseek-chat">deepseek-chat/);
  assert.match(html, /data-v="gpt-5\.6-luna">gpt-5\.6-luna/);
  assert.doesNotMatch(html, />undefined</);
});

test("模型 ID 按 HTML 文本和属性值转义，并保留选中项", () => {
  const id = 'model"><img src=x>';
  const html = globalThis.TokenTrackerModelOptions.renderModelFilterOptions(
    [{ id }],
    [],
    id,
  );

  assert.match(html, /class="cs-opt sel" data-v="model&quot;&gt;&lt;img src=x&gt;">/);
  assert.doesNotMatch(html, /<img/);
});
