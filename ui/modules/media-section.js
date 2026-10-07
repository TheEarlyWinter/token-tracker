// ui/modules/media-section.js — 多媒体生成统计区块组件

export function renderMediaSection({
  container,
  mediaGen = [],
  costs = [],
  dual = (v) => `$${v}`,
  escHTML = (s) => String(s ?? ""),
} = {}) {
  if (!container) return;
  if (!mediaGen || !mediaGen.length) {
    container.style.display = "none";
    return;
  }

  const imgItems = [];
  const vidItems = [];
  let imgTotal = 0;
  let vidTotal = 0;
  let imgCost = 0;
  let vidCost = 0;

  for (let i = 0; i < mediaGen.length; i++) {
    const g = mediaGen[i];
    const key = `${g.provider}/${g.model}`;
    let costEntry = null;
    for (let k = 0; k < costs.length; k++) {
      if (`${costs[k].provider}/${costs[k].model}` === key) {
        costEntry = costs[k];
        break;
      }
    }
    const cost = costEntry ? costEntry.cost : 0;
    const item = {
      provider: g.provider,
      model: g.model,
      callCount: g.callCount || 0,
      successCount: g.successCount || 0,
      cost,
    };
    if (g.kind === "video") {
      vidItems.push(item);
      vidTotal += g.callCount || 0;
      vidCost += cost;
    } else {
      imgItems.push(item);
      imgTotal += g.callCount || 0;
      imgCost += cost;
    }
  }

  if (!imgTotal && !vidTotal) {
    container.style.display = "none";
    return;
  }

  container.style.display = "";
  let h = '<div class="media-sec">';

  if (imgTotal) {
    h +=
      '<div class="media-cat"><div class="media-cat-hdr"><span class="media-cat-icon">IMAGE</span><span class="media-cat-title">图片生成</span><span class="media-cat-sum">' +
      imgTotal +
      "张" +
      (imgCost > 0 ? " · " + dual(imgCost) : "") +
      "</span></div>";
    h += '<div class="media-cat-grid">';
    for (let i = 0; i < imgItems.length; i++) {
      const it = imgItems[i];
      h +=
        '<div class="media-item"><div class="media-item-model">' +
        escHTML(it.provider) +
        "/" +
        escHTML(it.model) +
        '</div><div class="media-item-stats"><span>' +
        it.callCount +
        "次</span>" +
        (it.successCount > 0 && it.successCount !== it.callCount
          ? '<span class="media-item-succ">成功' + it.successCount + "</span>"
          : "") +
        (it.cost > 0 ? '<span class="media-item-cost">' + dual(it.cost) + "</span>" : "") +
        "</div></div>";
    }
    h += "</div></div>";
  }

  if (vidTotal) {
    h +=
      '<div class="media-cat"><div class="media-cat-hdr"><span class="media-cat-icon">VIDEO</span><span class="media-cat-title">视频生成</span><span class="media-cat-sum">' +
      vidTotal +
      "个" +
      (vidCost > 0 ? " · " + dual(vidCost) : "") +
      "</span></div>";
    h += '<div class="media-cat-grid">';
    for (let i = 0; i < vidItems.length; i++) {
      const it = vidItems[i];
      h +=
        '<div class="media-item"><div class="media-item-model">' +
        escHTML(it.provider) +
        "/" +
        escHTML(it.model) +
        '</div><div class="media-item-stats"><span>' +
        it.callCount +
        "次</span>" +
        (it.successCount > 0 && it.successCount !== it.callCount
          ? '<span class="media-item-succ">成功' + it.successCount + "</span>"
          : "") +
        (it.cost > 0 ? '<span class="media-item-cost">' + dual(it.cost) + "</span>" : "") +
        "</div></div>";
    }
    h += "</div></div>";
  }

  h += "</div>";
  container.innerHTML = h;
}
