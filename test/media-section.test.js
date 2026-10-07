import test from "node:test";
import assert from "node:assert/strict";
import { renderMediaSection } from "../ui/modules/media-section.js";

test("renderMediaSection hides container when mediaGen is empty", () => {
  const container = { style: { display: "" }, innerHTML: "" };
  renderMediaSection({ container, mediaGen: [] });
  assert.equal(container.style.display, "none");
});

test("renderMediaSection renders image and video categories with statistics", () => {
  const container = { style: { display: "none" }, innerHTML: "" };
  const mediaGen = [
    { provider: "openai", model: "dall-e-3", kind: "image", callCount: 5, successCount: 5 },
    { provider: "luma", model: "dream-machine", kind: "video", callCount: 2, successCount: 1 },
  ];
  const costs = [
    { provider: "openai", model: "dall-e-3", cost: 0.2 },
    { provider: "luma", model: "dream-machine", cost: 1.5 },
  ];

  renderMediaSection({
    container,
    mediaGen,
    costs,
    dual: (v) => `$${v}`,
    escHTML: (s) => s,
  });

  assert.equal(container.style.display, "");
  assert.match(container.innerHTML, /图片生成/);
  assert.match(container.innerHTML, /5张/);
  assert.match(container.innerHTML, /openai\/dall-e-3/);
  assert.match(container.innerHTML, /视频生成/);
  assert.match(container.innerHTML, /2个/);
  assert.match(container.innerHTML, /成功1/);
});
