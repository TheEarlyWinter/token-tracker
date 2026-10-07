(function (root) {
  function normalizeModelOptions(options, fallbackModels) {
    var source = Array.isArray(options)
      ? options
      : Array.isArray(fallbackModels)
        ? fallbackModels
        : [];
    var seen = new Set();
    var modelIds = [];

    for (var i = 0; i < source.length; i++) {
      var option = source[i];
      var id = typeof option === "string" ? option : option && option.id;
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      modelIds.push(id);
    }

    return modelIds;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;");
  }

  function renderModelFilterOptions(options, fallbackModels, selectedModel) {
    var html = '<div class="cs-opt' + (selectedModel === "" ? " sel" : "") + '" data-v="">全部模型</div>';
    var modelIds = normalizeModelOptions(options, fallbackModels);

    for (var i = 0; i < modelIds.length; i++) {
      var id = modelIds[i];
      var safeId = escapeHtml(id);
      html += '<div class="cs-opt' + (selectedModel === id ? " sel" : "") + '" data-v="' + safeId + '">' + safeId + '</div>';
    }

    return html;
  }

  root.TokenTrackerModelOptions = Object.freeze({
    normalizeModelOptions: normalizeModelOptions,
    renderModelFilterOptions: renderModelFilterOptions,
  });
})(typeof window === "undefined" ? globalThis : window);
