import { renderArticleMarkdown } from "./article-markdown.js?v=20260803-2";
import {
  articleDownloadName,
  articleHash,
  articleIdFromHash,
  deriveImportedArticle,
  filterArticleSummaries,
} from "./article-utils.js?v=20260803-1";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const VDITOR_CDN = new URL("./vendor/vditor", import.meta.url).href.replace(/\/$/, "");

export function dismissVditorImagePreview(root = document) {
  const preview = root.querySelector?.(".vditor-img");
  if (!preview) return false;
  preview.remove();
  if (root.body) root.body.style.overflow = "";
  return true;
}

function downloadBlob(blob, fileName) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function dateTime(value) {
  return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}

export function initArticles({ apiFetch, apiBase, getToken, getDashboard, notify, prepareImage, openTrade }) {
  let summaries = [];
  let deletedSummaries = [];
  let current = null;
  let currentUser = null;
  let summaryLoadPromise = null;
  let trashMode = false;
  let dirty = false;
  let imageObjectUrls = [];
  let loaded = false;
  let articleEditorInstance = null;
  let articleEditorPromise = null;
  let pendingEditorValue = "";
  let syncingEditor = false;
  let previewTimer = null;
  const pendingPastedImages = new Map();

  const canEdit = () => currentUser?.role === "editor";

  function revokeImages() {
    imageObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    imageObjectUrls = [];
  }

  function discardPendingImages() {
    pendingPastedImages.forEach((_image, localUrl) => URL.revokeObjectURL(localUrl));
    pendingPastedImages.clear();
  }

  function safeImageName(file, index = 0) {
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[file.type] || "png";
    return String(file.name || `截图-${index + 1}.${extension}`).replace(/[\[\]\r\n]/g, "_");
  }

  function trackPendingImage(file, index = 0) {
    const localUrl = URL.createObjectURL(file);
    pendingPastedImages.set(localUrl, { file, fileName: safeImageName(file, index) });
    return localUrl;
  }

  function validatePastedImages(files) {
    const images = [...files];
    if (!images.length) return "没有读取到图片";
    if (images.some((file) => !["image/png", "image/jpeg", "image/webp"].includes(file.type))) return "仅支持 PNG、JPEG 或 WebP 图片";
    if ((current?.images?.length || 0) + pendingPastedImages.size + images.length > 20) return "每篇随笔最多保存 20 张图片";
    return "";
  }

  function insertPastedImages(files) {
    const validationError = validatePastedImages(files);
    if (validationError) return validationError;
    [...files].forEach((file, index) => {
      const localUrl = trackPendingImage(file, index);
      articleEditorInstance.insertValue(`\n\n![${safeImageName(file, index)}](${localUrl})\n`);
    });
    const markdown = articleEditorInstance.getValue();
    pendingEditorValue = markdown;
    setDirty(true);
    scheduleLivePreview(markdown);
    notify(`${files.length} 张截图已加入，保存随笔时自动上传`);
    return null;
  }

  function setDirty(value) {
    dirty = Boolean(value);
    $("articleSaveState").textContent = dirty ? "有未保存修改" : current ? `云端版本 ${current.revision}` : "尚未保存";
  }

  function updateLivePreview(markdown = "") {
    $("articlePreviewTitle").textContent = $("articleTitleInput").value.trim() || "无标题随笔";
    $("articleEditorPreview").innerHTML = renderArticleMarkdown(markdown);
  }

  function scheduleLivePreview(markdown) {
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => updateLivePreview(markdown), 160);
  }

  function ensureArticleEditor(value = "") {
    pendingEditorValue = value;
    if (articleEditorInstance) {
      syncingEditor = true;
      articleEditorInstance.setValue(value, true);
      syncingEditor = false;
      updateLivePreview(value);
      return Promise.resolve(articleEditorInstance);
    }
    if (articleEditorPromise) return articleEditorPromise;
    if (!window.Vditor) return Promise.reject(new Error("Markdown 编辑器资源加载失败，请刷新页面重试"));

    $("articleSaveButton").disabled = true;
    $("articleSaveState").textContent = "正在加载专业编辑器…";
    articleEditorPromise = new Promise((resolve, reject) => {
      try {
        syncingEditor = true;
        const editor = new window.Vditor("articleContentEditor", {
          cdn: VDITOR_CDN,
          lang: "zh_CN",
          mode: "ir",
          theme: "classic",
          height: Math.max(580, window.innerHeight - 270),
          minHeight: 560,
          placeholder: "从一个想法开始……",
          typewriterMode: true,
          cache: { enable: false },
          counter: { enable: true, type: "text" },
          resize: { enable: false },
          outline: { enable: false },
          toolbarConfig: { pin: true },
          toolbar: [
            "headings", "bold", "italic", "|",
            "quote", "list", "ordered-list", "check", "|",
            "upload", "link", "table", "code", "|",
            "undo", "redo", "fullscreen",
          ],
          upload: {
            accept: "image/png,image/jpeg,image/webp",
            multiple: true,
            handler: async (files) => insertPastedImages(files),
            base64ToLink: async (dataUrl) => {
              const response = await fetch(dataUrl);
              const blob = await response.blob();
              const file = new File([blob], `截图-${pendingPastedImages.size + 1}.${blob.type === "image/jpeg" ? "jpg" : blob.type.split("/")[1] || "png"}`, { type: blob.type });
              const validationError = validatePastedImages([file]);
              if (validationError) throw new Error(validationError);
              const localUrl = trackPendingImage(file);
              window.setTimeout(() => {
                const markdown = articleEditorInstance?.getValue() || pendingEditorValue;
                pendingEditorValue = markdown;
                setDirty(true);
                scheduleLivePreview(markdown);
              }, 0);
              return localUrl;
            },
          },
          preview: {
            delay: 250,
            hljs: { enable: true, lineNumber: true, style: "github" },
            markdown: { autoSpace: true, fixTermTypo: true, toc: true, footnotes: true },
          },
          after: () => {
            articleEditorInstance = editor;
            articleEditorInstance.setValue(pendingEditorValue, true);
            syncingEditor = false;
            $("articleSaveButton").disabled = false;
            updateLivePreview(pendingEditorValue);
            if (!dirty) setDirty(false);
            resolve(editor);
          },
          input: () => {
            if (!articleEditorInstance || syncingEditor) return;
            setDirty(true);
            scheduleLivePreview(articleEditorInstance.getValue());
          },
          ctrlEnter: () => $("articleEditor").requestSubmit(),
        });
      } catch (error) {
        syncingEditor = false;
        articleEditorPromise = null;
        reject(error);
      }
    });
    return articleEditorPromise;
  }

  function setHash(hash, mode = "push") {
    const target = `${location.pathname}${location.search}${hash}`;
    history[mode === "replace" ? "replaceState" : "pushState"]({ articleSection: true }, "", target);
  }

  function showSection(section, { updateHistory = true, load = true } = {}) {
    const articlesVisible = section === "articles";
    $("tradesSection").hidden = articlesVisible;
    $("articlesSection").hidden = !articlesVisible;
    $("tradeRailControls").hidden = articlesVisible;
    $("articleRailControls").hidden = !articlesVisible;
    $("tradesSectionButton").setAttribute("aria-pressed", String(!articlesVisible));
    $("articlesSectionButton").setAttribute("aria-pressed", String(articlesVisible));
    if (articlesVisible) {
      if (load && !loaded) loadSummaries().catch((error) => notify(error.message, true));
      if (updateHistory && !location.hash.startsWith("#essay")) setHash("#essays");
    } else if (updateHistory && location.hash.startsWith("#essay")) setHash("");
  }

  function articleFilters() {
    return {
      query: $("articleSearch").value,
      tag: $("articleTagFilter").value,
      status: $("articleStatusFilter").value,
      deleted: trashMode,
    };
  }

  function refreshTagOptions() {
    const selected = $("articleTagFilter").value;
    const tags = [...new Set(summaries.flatMap((article) => article.tags || []))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    $("articleTagFilter").replaceChildren(new Option("全部标签", ""), ...tags.map((tag) => new Option(tag, tag)));
    if (tags.includes(selected)) $("articleTagFilter").value = selected;
  }

  function renderList() {
    const source = trashMode ? deletedSummaries : summaries;
    const rows = filterArticleSummaries(source, articleFilters());
    $("articleListCount").textContent = `${rows.length} 篇`;
    $("articleListMode").textContent = trashMode ? "回收站" : "按更新时间排序";
    $("articleTrashButton").textContent = trashMode ? "返回全部随笔" : `随笔回收站${deletedSummaries.length ? ` ${deletedSummaries.length}` : ""}`;
    if (!rows.length) {
      $("articleList").innerHTML = `<div class="article-list-empty">${trashMode ? "回收站中没有随笔" : "当前条件下没有随笔"}</div>`;
      return;
    }
    $("articleList").innerHTML = rows.map((article) => `
      <button class="article-list-item ${article.id === current?.id ? "active" : ""}" type="button" data-article-id="${article.id}">
        <small>${article.status === "final" ? "已整理" : "草稿"}${article.deletedAt ? " · 已删除" : ""}</small>
        <b>${esc(article.title)}</b><p>${esc(article.excerpt || "暂无摘要")}</p><span>${esc(dateTime(article.updatedAt))}</span>
      </button>`).join("");
    $("articleList").querySelectorAll("[data-article-id]").forEach((button) => button.addEventListener("click", () => openArticle(button.dataset.articleId)));
  }

  async function loadSummaries() {
    if (summaryLoadPromise) return summaryLoadPromise;
    summaryLoadPromise = (async () => {
      const [active, deleted] = await Promise.all([
        apiFetch("/api/articles"),
        canEdit() ? apiFetch("/api/articles?deleted=1") : Promise.resolve({ articles: [] }),
      ]);
      summaries = active.articles || [];
      deletedSummaries = deleted.articles || [];
      loaded = true;
      refreshTagOptions();
      renderList();
    })();
    try { return await summaryLoadPromise; }
    finally { summaryLoadPromise = null; }
  }

  function renderTradeLinks(article) {
    const trades = getDashboard()?.trades || [];
    const linked = (article.tradeIds || []).map((tradeId) => trades.find((trade) => trade.tradeId === tradeId) || { tradeId });
    $("articleTradeLinks").innerHTML = linked.length ? linked.map((trade) => `<button class="article-trade-link" type="button" data-related-trade="${esc(trade.tradeId)}">${esc(trade.tradeId)}${trade.instrument ? ` · ${esc(trade.instrument)}` : ""}</button>`).join("") : '<span class="article-list-empty">尚未关联交易</span>';
    $("articleTradeLinks").querySelectorAll("[data-related-trade]").forEach((button) => button.addEventListener("click", () => openTrade(button.dataset.relatedTrade)));
  }

  async function hydrateArticleImages(host) {
    for (const figure of host.querySelectorAll("[data-article-image-id]")) {
      try {
        const response = await fetch(`${apiBase}/api/article-images/${encodeURIComponent(figure.dataset.articleImageId)}`, { headers: { Authorization: `Bearer ${getToken()}` } });
        if (!response.ok) throw new Error("图片读取失败");
        const url = URL.createObjectURL(await response.blob());
        imageObjectUrls.push(url);
        const image = document.createElement("img");
        image.src = url;
        image.alt = figure.querySelector("figcaption")?.textContent || "随笔图片";
        figure.querySelector(".article-image-state")?.replaceWith(image);
      } catch (error) { figure.querySelector(".article-image-state").textContent = error.message; }
    }
  }

  function renderReader(article) {
    discardPendingImages();
    revokeImages();
    document.body.classList.remove("article-writing-open");
    $("articleEditor").closest(".article-layout").classList.remove("is-editing");
    $("articleEmpty").hidden = true;
    $("articleEditor").hidden = true;
    $("articleHistory").hidden = true;
    $("articleReader").hidden = false;
    $("articleReaderStatus").textContent = article.status === "final" ? "已整理" : "草稿";
    $("articleReaderTitle").textContent = article.title;
    $("articleReaderMeta").textContent = `版本 ${article.revision} · ${article.updatedBy} 更新于 ${dateTime(article.updatedAt)}`;
    $("articleReaderTags").innerHTML = (article.tags || []).map((tag) => `<span>${esc(tag)}</span>`).join("");
    $("articleMarkdown").innerHTML = renderArticleMarkdown(article.contentMd);
    $("articleEditButton").hidden = !canEdit() || Boolean(article.deletedAt);
    $("articleDeleteButton").hidden = !canEdit();
    $("articleDeleteButton").textContent = article.deletedAt ? "恢复随笔" : "移入回收站";
    $("articleHistoryButton").hidden = !canEdit() || Boolean(article.deletedAt);
    renderTradeLinks(article);
    hydrateArticleImages($("articleMarkdown"));
    renderList();
  }

  async function openArticle(articleId, { historyMode = "push" } = {}) {
    if (dirty && !confirm("当前编辑内容尚未保存，确定离开吗？")) return;
    const deleted = trashMode ? "?deleted=1" : "";
    const payload = await apiFetch(`/api/articles/${encodeURIComponent(articleId)}${deleted}`);
    current = payload.article;
    setDirty(false);
    renderReader(current);
    if (historyMode !== "none") setHash(articleHash(articleId), historyMode);
  }

  function renderTradePicker(selectedIds) {
    const selected = new Set(selectedIds || []);
    const trades = [...(getDashboard()?.trades || []), ...(getDashboard()?.deletedTrades || [])];
    $("articleTradePicker").innerHTML = trades.length ? trades.map((trade) => `<label><input type="checkbox" value="${esc(trade.tradeId)}" ${selected.has(trade.tradeId) ? "checked" : ""}><span>${esc(trade.tradeId)} · ${esc(trade.instrument || "")}</span></label>`).join("") : '<span class="article-list-empty">暂无可关联交易</span>';
  }

  function renderEditorImages(images) {
    $("articleImages").innerHTML = (images || []).map((image) => `<div class="article-image-row"><span>${esc(image.fileName)} · ${Math.max(1, Math.round(image.byteSize / 1024))} KB</span><button type="button" data-delete-article-image="${image.id}">删除</button></div>`).join("");
    $("articleImages").querySelectorAll("[data-delete-article-image]").forEach((button) => button.addEventListener("click", async () => {
      if (!confirm("删除这张随笔图片？正文中的引用不会自动移除。")) return;
      try {
        await apiFetch(`/api/article-images/${encodeURIComponent(button.dataset.deleteArticleImage)}`, { method: "DELETE" });
        current.images = current.images.filter((image) => image.id !== button.dataset.deleteArticleImage);
        renderEditorImages(current.images);
        notify("随笔图片已删除");
      } catch (error) { notify(error.message, true); }
    }));
  }

  function editArticle(article = null) {
    if (!canEdit()) { notify("当前账号仅有浏览权限", true); return; }
    discardPendingImages();
    if (!article?.id) {
      trashMode = false;
      renderList();
    }
    current = article?.id ? article : null;
    $("articleEmpty").hidden = true;
    $("articleReader").hidden = true;
    $("articleHistory").hidden = true;
    $("articleEditor").hidden = false;
    document.body.classList.add("article-writing-open");
    $("articleEditor").closest(".article-layout").classList.add("is-editing");
    $("articleEditorHeading").textContent = article ? "编辑随笔" : "新建随笔";
    $("articleTitleInput").value = article?.title || "";
    $("articleStatusInput").value = article?.status || "draft";
    $("articleTagsInput").value = (article?.tags || []).join("，");
    renderTradePicker(article?.tradeIds || []);
    renderEditorImages(article?.images || []);
    updateLivePreview(article?.contentMd || "");
    setDirty(false);
    $("articleTitleInput").focus();
    ensureArticleEditor(article?.contentMd || "").catch((error) => notify(error.message, true));
  }

  function editorPayload() {
    return {
      title: $("articleTitleInput").value,
      contentMd: articleEditorInstance ? articleEditorInstance.getValue() : pendingEditorValue,
      status: $("articleStatusInput").value,
      tags: $("articleTagsInput").value.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean),
      tradeIds: [...$("articleTradePicker").querySelectorAll("input:checked")].map((input) => input.value),
      ...(current?.revision ? { revision: current.revision } : {}),
    };
  }

  function syncEditorMarkdown(markdown) {
    pendingEditorValue = markdown;
    if (articleEditorInstance) {
      syncingEditor = true;
      articleEditorInstance.setValue(markdown, true);
      syncingEditor = false;
    }
    updateLivePreview(markdown);
  }

  async function persistPendingImages(articleId, markdown) {
    let contentMd = markdown;
    for (const [localUrl, pendingImage] of [...pendingPastedImages]) {
      if (!contentMd.includes(localUrl)) {
        URL.revokeObjectURL(localUrl);
        pendingPastedImages.delete(localUrl);
        continue;
      }
      const prepared = await prepareImage(pendingImage.file);
      const result = await apiFetch(`/api/articles/${encodeURIComponent(articleId)}/images`, {
        method: "POST",
        body: prepared.blob,
        headers: { "Content-Type": prepared.blob.type, "X-File-Name": encodeURIComponent(prepared.fileName) },
      });
      const remoteSource = result.markdown?.match(/\]\((article-image:[^)]+)\)/)?.[1];
      if (!remoteSource) throw new Error("图片上传完成，但没有返回有效的 Markdown 引用");
      contentMd = contentMd.split(localUrl).join(remoteSource);
      current.images = [...(current.images || []), result.image];
      URL.revokeObjectURL(localUrl);
      pendingPastedImages.delete(localUrl);
      renderEditorImages(current.images);
      syncEditorMarkdown(contentMd);
    }
    return contentMd;
  }

  async function saveArticle(event) {
    event.preventDefault();
    const button = $("articleSaveButton");
    button.disabled = true;
    button.textContent = "正在保存…";
    try {
      let payload = editorPayload();
      const isNewArticle = !current?.id;
      if (isNewArticle) {
        const created = await apiFetch("/api/articles", { method: "POST", body: JSON.stringify(payload) });
        current = created.article;
      }
      if (pendingPastedImages.size) {
        payload = { ...payload, contentMd: await persistPendingImages(current.id, payload.contentMd), revision: current.revision };
      }
      if (!isNewArticle || payload.contentMd !== current.contentMd) {
        const updated = await apiFetch(`/api/articles/${encodeURIComponent(current.id)}`, {
          method: "PUT",
          body: JSON.stringify({ ...payload, revision: current.revision }),
        });
        current = updated.article;
      }
      setDirty(false);
      await loadSummaries();
      renderReader(current);
      setHash(articleHash(current.id), "replace");
      notify("随笔已保存到云端");
    } catch (error) {
      setDirty(true);
      notify(current?.id && pendingPastedImages.size ? `${error.message}；文章已保留，可再次保存重试图片上传` : error.message, true);
    }
    finally { button.disabled = false; button.textContent = "保存随笔"; }
  }

  async function uploadImages(files) {
    if (!current?.id) { notify("请先保存随笔，再上传图片", true); return; }
    for (const file of files) {
      try {
        const prepared = await prepareImage(file);
        const result = await apiFetch(`/api/articles/${encodeURIComponent(current.id)}/images`, {
          method: "POST",
          body: prepared.blob,
          headers: { "Content-Type": prepared.blob.type, "X-File-Name": encodeURIComponent(prepared.fileName) },
        });
        if (!articleEditorInstance) throw new Error("Markdown 编辑器尚未准备完成");
        articleEditorInstance.insertValue(`\n\n${result.markdown}\n`);
        current.images = [...(current.images || []), result.image];
        renderEditorImages(current.images);
        setDirty(true);
      } catch (error) { notify(error.message, true); }
    }
  }

  async function openHistory() {
    if (!current?.id) return;
    const payload = await apiFetch(`/api/articles/${encodeURIComponent(current.id)}/versions`);
    $("articleHistoryList").innerHTML = (payload.versions || []).map((version) => `<div class="article-version"><div><b>版本 ${version.revision} · ${esc(version.title)}</b><small>${esc(version.createdBy)} · ${esc(dateTime(version.createdAt))}</small></div><div class="article-version-actions"><button type="button" data-view-version="${version.revision}">查看</button>${canEdit() && version.revision !== current.revision ? `<button type="button" data-restore-version="${version.revision}">恢复</button>` : ""}</div></div>`).join("");
    $("articleHistory").hidden = false;
    $("articleHistoryList").querySelectorAll("[data-view-version]").forEach((button) => button.addEventListener("click", async () => {
      try {
        const result = await apiFetch(`/api/articles/${encodeURIComponent(current.id)}/versions/${button.dataset.viewVersion}`);
        const oldPreview = button.closest(".article-version").nextElementSibling;
        if (oldPreview?.classList.contains("article-version-preview")) oldPreview.remove();
        const preview = document.createElement("div");
        preview.className = "article-markdown article-version-preview";
        preview.innerHTML = renderArticleMarkdown(result.version.contentMd);
        button.closest(".article-version").after(preview);
        hydrateArticleImages(preview);
      } catch (error) { notify(error.message, true); }
    }));
    $("articleHistoryList").querySelectorAll("[data-restore-version]").forEach((button) => button.addEventListener("click", async () => {
      if (!confirm(`恢复版本 ${button.dataset.restoreVersion}？当前内容会先作为一个历史版本保留。`)) return;
      try {
        const result = await apiFetch(`/api/articles/${encodeURIComponent(current.id)}/versions/${button.dataset.restoreVersion}/restore`, { method: "POST" });
        current = result.article;
        await loadSummaries();
        renderReader(current);
        notify("历史版本已恢复为新版本");
      } catch (error) { notify(error.message, true); }
    }));
  }

  async function deleteCurrent() {
    if (!current?.id || !confirm(`将《${current.title}》移入回收站？`)) return;
    try {
      await apiFetch(`/api/articles/${encodeURIComponent(current.id)}`, { method: "DELETE" });
      current = null;
      $("articleReader").hidden = true;
      $("articleEmpty").hidden = false;
      await loadSummaries();
      setHash("#essays", "replace");
      notify("随笔已移入回收站");
    } catch (error) { notify(error.message, true); }
  }

  async function toggleTrash() {
    discardPendingImages();
    trashMode = !trashMode;
    current = null;
    $("articleReader").hidden = true;
    $("articleEditor").hidden = true;
    document.body.classList.remove("article-writing-open");
    $("articleEditor").closest(".article-layout").classList.remove("is-editing");
    $("articleEmpty").hidden = false;
    renderList();
  }

  async function restoreCurrent() {
    if (!current?.deletedAt) return;
    try {
      const result = await apiFetch(`/api/articles/${encodeURIComponent(current.id)}/restore`, { method: "POST" });
      trashMode = false;
      current = result.article;
      await loadSummaries();
      renderReader(current);
      notify("随笔已恢复");
    } catch (error) { notify(error.message, true); }
  }

  function cancelEditor() {
    if (dirty && !confirm("放弃尚未保存的修改？")) return;
    setDirty(false);
    if (current) renderReader(current);
    else {
      discardPendingImages();
      $("articleEditor").hidden = true;
      document.body.classList.remove("article-writing-open");
      $("articleEditor").closest(".article-layout").classList.remove("is-editing");
      $("articleEmpty").hidden = false;
    }
  }

  function exportCurrent() {
    if (!current) return;
    downloadBlob(new Blob([current.contentMd], { type: "text/markdown;charset=utf-8" }), articleDownloadName(current.title));
  }

  async function exportAll() {
    try {
      const backup = await apiFetch("/api/articles/export");
      downloadBlob(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8" }), `trade-review-articles-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (error) { notify(error.message, true); }
  }

  async function route() {
    if (!location.hash.startsWith("#essay")) {
      if (!$("articlesSection").hidden) showSection("trades", { updateHistory: false });
      return;
    }
    showSection("articles", { updateHistory: false });
    if (!loaded) await loadSummaries();
    const id = articleIdFromHash(location.hash);
    if (id) await openArticle(id, { historyMode: "none" });
  }

  $("tradesSectionButton").addEventListener("click", () => showSection("trades"));
  $("articlesSectionButton").addEventListener("click", () => showSection("articles"));
  ["articleSearch", "articleStatusFilter", "articleTagFilter"].forEach((id) => $(id).addEventListener(id === "articleSearch" ? "input" : "change", renderList));
  $("newArticleButton").addEventListener("click", () => editArticle(null));
  $("articleImportInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { editArticle(deriveImportedArticle(file.name, await file.text())); setDirty(true); }
    catch (error) { notify(error.message, true); }
    event.target.value = "";
  });
  $("articleTrashButton").addEventListener("click", toggleTrash);
  $("articleEditButton").addEventListener("click", () => editArticle(current));
  $("articleDownloadButton").addEventListener("click", exportCurrent);
  $("articleHistoryButton").addEventListener("click", openHistory);
  $("articleDeleteButton").addEventListener("click", () => current?.deletedAt ? restoreCurrent() : deleteCurrent());
  $("articleEditor").addEventListener("submit", saveArticle);
  $("articleEditor").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      $("articleEditor").requestSubmit();
    }
    if (event.key === "Escape") cancelEditor();
  });
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!target?.closest?.(".vditor-img")) return;
    const imageStage = target.closest(".vditor-img__img");
    const toolbarButton = target.closest(".vditor-img__btn");
    if (!imageStage && (!toolbarButton || toolbarButton.hasAttribute("data-deg"))) return;
    event.preventDefault();
    event.stopPropagation();
    if (dismissVditorImagePreview()) articleEditorInstance?.focus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !dismissVditorImagePreview()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    articleEditorInstance?.focus();
  }, true);
  $("articleCancelButton").addEventListener("click", cancelEditor);
  $("articleHistoryClose").addEventListener("click", () => { $("articleHistory").hidden = true; });
  $("articleImageInput").addEventListener("change", (event) => { uploadImages(event.target.files || []); event.target.value = ""; });
  $("articleExportAll").addEventListener("click", exportAll);
  $("articleTitleInput").addEventListener("input", () => { setDirty(true); updateLivePreview(articleEditorInstance?.getValue() || pendingEditorValue); });
  ["articleStatusInput", "articleTagsInput", "articleTradePicker"].forEach((id) => $(id).addEventListener("input", () => setDirty(true)));
  window.addEventListener("beforeunload", (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
  window.addEventListener("popstate", () => { route().catch((error) => notify(error.message, true)); });

  return {
    setSession(user) {
      currentUser = user;
      $("newArticleButton").hidden = !canEdit();
      $("articleImportInput").closest("label").hidden = !canEdit();
      $("articleTrashButton").hidden = !canEdit();
      $("articleExportAll").hidden = !canEdit();
      $("articleImageInput").disabled = !canEdit();
      $("articleEmpty").querySelector("p").textContent = canEdit()
        ? "也可以新建或导入 Markdown 文件。"
        : "请选择左侧随笔进行阅读。";
    },
    route,
    showSection,
    async open(articleId) {
      showSection("articles", { updateHistory: false });
      if (!loaded) await loadSummaries();
      await openArticle(articleId);
    },
    restoreCurrent,
  };
}
