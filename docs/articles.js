import { renderArticleMarkdown } from "./article-markdown.js?v=20260804-3";
import {
  articleDownloadName,
  articleHash,
  articleIdFromHash,
  deriveImportedArticle,
  filterArticleSummaries,
  preserveUnchangedMarkdown,
  proportionalScrollTop,
} from "./article-utils.js?v=20260804-2";
import {
  formatTradeReference,
  privateArticleImageIds,
  replacePrivateArticleImages,
  restorePrivateArticleImages,
  tradePickerTrades,
} from "./article-references.js?v=20260804-2";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const VDITOR_CDN = new URL("./vendor/vditor", import.meta.url).href.replace(/\/$/, "");
const AUTOSAVE_DELAY_MS = 1200;

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

function dateOnly(value) {
  return value ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(value)) : "—";
}

export function cleanArticleExcerpt(value) {
  return String(value || "")
    .replace(/<img\b[^>]*(?:>|$)/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(?:article-image|blob):\S+/gi, " ")
    .replace(/[#>*_~`|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function articleReadingMinutes(article) {
  const estimatedCharacters = Number(article?.contentLength || 0) || cleanArticleExcerpt(article?.excerpt).length * 3;
  return Math.max(1, Math.ceil(estimatedCharacters / 500));
}

export function initArticles({ apiFetch, apiBase, getToken, getDashboard, notify, prepareImage, openTrade, recordAccess }) {
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
  let autosaveTimer = null;
  let changeVersion = 0;
  let savePromise = null;
  let editorMarkdownSnapshot = null;
  let scrollSyncCleanup = null;
  const pendingPastedImages = new Map();
  const editorPrivateImageSources = new Map();
  const editorPrivateImageErrors = new Map();

  const canEdit = () => currentUser?.role === "editor";

  function revokeImages() {
    imageObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    imageObjectUrls = [];
  }

  function discardPendingImages() {
    pendingPastedImages.forEach((_image, localUrl) => URL.revokeObjectURL(localUrl));
    pendingPastedImages.clear();
  }

  function discardEditorPrivateImages() {
    for (const localUrl of editorPrivateImageSources.values()) URL.revokeObjectURL(localUrl);
    editorPrivateImageSources.clear();
    editorPrivateImageErrors.clear();
  }

  async function privateImageUrl(imageId) {
    const response = await fetch(`${apiBase}/api/article-images/${encodeURIComponent(imageId)}`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!response.ok) throw new Error("图片读取失败");
    return URL.createObjectURL(await response.blob());
  }

  async function loadPrivateImagesForEditor(storedMarkdown) {
    discardEditorPrivateImages();
    await Promise.all(privateArticleImageIds(storedMarkdown).map(async (imageId) => {
      try { editorPrivateImageSources.set(imageId, await privateImageUrl(imageId)); }
      catch (error) { editorPrivateImageErrors.set(imageId, error.message || "图片读取失败"); }
    }));
    return replacePrivateArticleImages(storedMarkdown, editorPrivateImageSources);
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
    markEditorChanged();
    scheduleLivePreview(markdown);
    notify(`${files.length} 张截图已加入，保存随笔时自动上传`);
    return null;
  }

  function setDirty(value) {
    dirty = Boolean(value);
    $("articleSaveState").textContent = dirty ? "等待自动保存…" : current ? `已自动保存 · 版本 ${current.revision}` : "自动保存已开启";
  }

  function clearAutosaveTimer() {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }

  function scheduleAutoSave() {
    clearAutosaveTimer();
    if (!dirty) return;
    if (!$("articleTitleInput").value.trim()) {
      $("articleSaveState").textContent = "填写标题后自动保存";
      return;
    }
    $("articleSaveState").textContent = "等待自动保存…";
    autosaveTimer = window.setTimeout(() => autosaveArticle(), AUTOSAVE_DELAY_MS);
  }

  function markEditorChanged() {
    changeVersion += 1;
    setDirty(true);
    scheduleAutoSave();
  }

  function syncEditorPreviewScroll() {
    const source = $("articleContentEditor").querySelector(".vditor-ir .vditor-reset");
    const target = document.querySelector(".article-preview-document");
    if (source && target) target.scrollTop = proportionalScrollTop(source, target);
  }

  function mountEditorScrollSync() {
    scrollSyncCleanup?.();
    const source = $("articleContentEditor").querySelector(".vditor-ir .vditor-reset");
    const target = document.querySelector(".article-preview-document");
    if (!source || !target) return;
    const syncPreview = () => { target.scrollTop = proportionalScrollTop(source, target); };
    source.addEventListener("scroll", syncPreview, { passive: true });
    scrollSyncCleanup = () => {
      source.removeEventListener("scroll", syncPreview);
    };
    syncPreview();
  }

  function updateLivePreview(markdown = "") {
    $("articlePreviewTitle").textContent = $("articleTitleInput").value.trim() || "无标题随笔";
    $("articleEditorPreview").innerHTML = renderArticleMarkdown(markdown);
    for (const [imageId, message] of editorPrivateImageErrors) {
      const state = $("articleEditorPreview").querySelector(`[data-article-image-id="${imageId}"] .article-image-state`);
      if (state) state.textContent = `${message}，请退出后重试`;
    }
    syncEditorPreviewScroll();
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
      mountEditorScrollSync();
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
            "upload",
            {
              name: "trade-reference",
              tip: "插入交易",
              tipPosition: "s",
              icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="15" rx="4" fill="none" stroke="currentColor" stroke-width="1.8"></rect><text x="12" y="15.5" text-anchor="middle" fill="currentColor" font-size="9" font-weight="800">TR</text></svg>',
              click: () => toggleTradePicker(),
            },
            "link", "table", "code", "|",
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
                markEditorChanged();
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
            mountTradeToolbarPopover();
            mountEditorScrollSync();
            $("articleSaveButton").disabled = false;
            updateLivePreview(pendingEditorValue);
            if (!dirty) setDirty(false);
            resolve(editor);
          },
          input: () => {
            if (!articleEditorInstance || syncingEditor) return;
            markEditorChanged();
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

  function showSection(section, { updateHistory = true, load = true, trackDashboard = true } = {}) {
    const articlesVisible = section === "articles";
    $("app").classList.toggle("app-mode-articles", articlesVisible);
    $("tradesSection").hidden = articlesVisible;
    $("articlesSection").hidden = !articlesVisible;
    $("tradeRailControls").hidden = articlesVisible;
    document.body.classList.toggle("articles-open", articlesVisible);
    $("tradesSectionButton").setAttribute("aria-pressed", String(!articlesVisible));
    $("articlesSectionButton").setAttribute("aria-pressed", String(articlesVisible));
    if (articlesVisible) {
      if (load && !loaded) loadSummaries().catch((error) => notify(error.message, true));
      if (updateHistory && !location.hash.startsWith("#essay")) setHash("#essays");
    } else {
      if (trackDashboard) recordAccess?.("dashboard", "main", "日内交易复盘台");
      if (updateHistory && location.hash.startsWith("#essay")) setHash("");
    }
    if (articlesVisible && !articleIdFromHash(location.hash) && $("articleEditor").hidden) showArticleHome();
  }

  function setJournalNav(active) {
    $("journalHomeNavButton").toggleAttribute("aria-current", active === "home");
    $("journalArticlesButton").toggleAttribute("aria-current", active === "articles");
    $("journalTagsButton").toggleAttribute("aria-current", active === "tags");
    $("journalArchiveButton").toggleAttribute("aria-current", active === "archive");
    $("journalAboutButton").toggleAttribute("aria-current", active === "about");
  }

  function showArticleHome({ clearCurrent = true } = {}) {
    if (clearCurrent) current = null;
    $("articleHome").hidden = false;
    $("articleReader").hidden = true;
    $("articleHistory").hidden = true;
    $("articleEditor").hidden = true;
    $("articleEmpty").hidden = true;
    $("articleEditor").closest(".article-layout").hidden = true;
    $("journalIntro").hidden = false;
    $("journalHomeGrid").hidden = false;
    $("journalIndexView").hidden = true;
    $("journalAbout").hidden = true;
    document.body.classList.remove("article-writing-open");
    $("articleEditor").closest(".article-layout").classList.remove("is-editing");
    setJournalNav("home");
    renderList();
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

  function topicEntries(rows) {
    const counts = new Map(["交易系统", "交易心理", "市场观察", "生活随笔"].map((tag) => [tag, 0]));
    rows.forEach((article) => (article.tags || []).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"));
  }

  function archiveEntries(rows) {
    const counts = new Map();
    rows.forEach((article) => {
      const date = new Date(article.updatedAt);
      if (Number.isNaN(date.getTime())) return;
      const key = `${date.getFullYear()}年${date.getMonth() + 1}月`;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return [...counts.entries()];
  }

  function renderJournalIndexes(rows) {
    const topics = topicEntries(rows);
    const archives = archiveEntries(rows);
    const articleDates = rows
      .map((article) => new Date(article.createdAt || article.updatedAt))
      .filter((date) => !Number.isNaN(date.getTime()))
      .sort((a, b) => a - b);
    const startedAt = articleDates[0] || null;
    const topicCount = topics.filter(([, count]) => count > 0).length;
    $("journalStats").textContent = `${rows.length} 篇文章 · ${topicCount} 个主题${startedAt ? ` · 自 ${dateOnly(startedAt)}起` : ""}`;
    $("journalTopicList").innerHTML = topics.slice(0, 4).map(([tag, count]) => `<button type="button" data-journal-topic="${esc(tag)}"><span>${esc(tag)}</span><b>${count}</b></button>`).join("");
    $("journalArchiveList").innerHTML = archives.length
      ? archives.slice(0, 3).map(([label, count]) => `<button type="button" data-journal-archive="${esc(label)}"><span>${esc(label)}</span><b>${count}</b></button>`).join("")
      : `<p>还没有归档</p>`;
  }

  function showJournalIndex(mode, filter = "") {
    const rows = summaries.filter((article) => {
      if (!filter) return true;
      if (mode === "tags") return (article.tags || []).includes(filter);
      const date = new Date(article.updatedAt);
      return `${date.getFullYear()}年${date.getMonth() + 1}月` === filter;
    });
    const entries = mode === "tags" ? topicEntries(summaries) : archiveEntries(summaries);
    const heading = filter || (mode === "tags" ? "全部主题" : "文章归档");
    $("journalIntro").hidden = true;
    $("journalHomeGrid").hidden = true;
    $("journalAbout").hidden = true;
    $("journalIndexView").hidden = false;
    $("journalIndexView").innerHTML = `
      <header><p class="journal-kicker">${mode === "tags" ? "TOPICS" : "ARCHIVE"}</p><h1>${esc(heading)}</h1><p>${mode === "tags" ? "沿着主题重新阅读那些反复出现的判断与问题。" : "按时间回看每一次记录与修正。"}</p></header>
      ${filter ? "" : `<div class="journal-index-cloud">${entries.map(([label, count]) => `<button type="button" data-journal-${mode === "tags" ? "topic" : "archive"}="${esc(label)}"><span>${esc(label)}</span><b>${count}</b></button>`).join("")}</div>`}
      <div class="journal-index-articles">${rows.length ? rows.map((article) => `<button type="button" data-article-id="${article.id}"><time>${esc(dateOnly(article.updatedAt))}</time><b>${esc(article.title)}</b><span>${esc(cleanArticleExcerpt(article.excerpt) || "打开文章继续阅读")}</span></button>`).join("") : `<p class="article-list-empty">这个分类下还没有文章。</p>`}</div>`;
    setJournalNav(mode);
    $("journalIndexView").querySelectorAll("[data-article-id]").forEach((button) => button.addEventListener("click", () => openArticle(button.dataset.articleId)));
    $("journalIndexView").querySelectorAll("[data-journal-topic]").forEach((button) => button.addEventListener("click", () => showJournalIndex("tags", button.dataset.journalTopic)));
    $("journalIndexView").querySelectorAll("[data-journal-archive]").forEach((button) => button.addEventListener("click", () => showJournalIndex("archive", button.dataset.journalArchive)));
  }

  function renderList() {
    const source = trashMode ? deletedSummaries : summaries;
    const rows = filterArticleSummaries(source, articleFilters());
    $("articleListCount").textContent = `${rows.length} 篇`;
    $("articleListMode").textContent = trashMode ? "回收站" : "按更新时间排序";
    $("articleTrashButton").textContent = trashMode ? "返回全部随笔" : `随笔回收站${deletedSummaries.length ? ` ${deletedSummaries.length}` : ""}`;
    const featured = rows[0];
    renderJournalIndexes(rows);
    $("articleFeature").hidden = trashMode;
    $("articleFeature").innerHTML = featured && !trashMode ? `
      <div class="journal-feature-heading"><p class="journal-kicker">EDITOR'S PICK</p><h2>本期推荐</h2></div>
      <button class="journal-feature-link" type="button" data-article-id="${featured.id}">
        <span class="journal-feature-cover"><img src="./assets/journal-feature-cover.webp" alt="摊开的交易笔记、钢笔和咖啡杯"></span>
        <span class="journal-feature-copy">
          <small>${featured.tags?.[0] ? esc(featured.tags[0]) : featured.status === "final" ? "已整理" : "草稿"}</small>
          <h1>${esc(featured.title)}</h1>
          <p>${esc(cleanArticleExcerpt(featured.excerpt) || "打开文章，继续这段尚未写完的思考。")}</p>
          <span class="journal-tag-row">${(featured.tags || []).slice(0, 3).map((tag) => `<i>${esc(tag)}</i>`).join("")}</span>
          <span class="journal-feature-meta"><time>${esc(dateOnly(featured.updatedAt))}</time><span>约 ${articleReadingMinutes(featured)} 分钟阅读</span><b>阅读全文</b></span>
        </span>
      </button>` : "";
    const listRows = rows;
    if (!rows.length) {
      $("articleList").innerHTML = `<div class="article-list-empty">${trashMode ? "回收站中没有文章" : "当前条件下没有文章"}</div>`;
    } else if (!listRows.length) {
      $("articleList").innerHTML = `<div class="article-list-empty">封面文章之外，暂时没有更多内容。</div>`;
    } else {
      $("articleList").innerHTML = listRows.map((article) => `
      <button class="article-list-item ${article.id === current?.id ? "active" : ""}" type="button" data-article-id="${article.id}">
        <span class="article-list-cover"><img src="./assets/${article.id === featured?.id ? "journal-feature-cover.webp" : "journal-secondary-cover.webp"}" alt=""></span>
        <span class="article-list-copy"><b>${esc(article.title)}</b><span>${esc(cleanArticleExcerpt(article.excerpt) || "打开文章，继续这段尚未写完的思考。")}</span><small>${esc(dateOnly(article.updatedAt))} · 约 ${articleReadingMinutes(article)} 分钟阅读</small></span>
        <span class="article-list-read">阅读全文</span>
      </button>`).join("");
    }
    $("articleHome").querySelectorAll("[data-article-id]").forEach((button) => button.addEventListener("click", () => openArticle(button.dataset.articleId)));
    $("journalTopicList").querySelectorAll("[data-journal-topic]").forEach((button) => button.addEventListener("click", () => showJournalIndex("tags", button.dataset.journalTopic)));
    $("journalArchiveList").querySelectorAll("[data-journal-archive]").forEach((button) => button.addEventListener("click", () => showJournalIndex("archive", button.dataset.journalArchive)));
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

  async function hydrateArticleImages(host) {
    for (const figure of host.querySelectorAll("[data-article-image-id]")) {
      try {
        const url = await privateImageUrl(figure.dataset.articleImageId);
        imageObjectUrls.push(url);
        const image = document.createElement("img");
        image.src = url;
        image.alt = figure.querySelector("figcaption")?.textContent || "随笔图片";
        figure.querySelector(".article-image-state")?.replaceWith(image);
      } catch (error) { figure.querySelector(".article-image-state").textContent = error.message; }
    }
  }

  function renderReader(article) {
    clearAutosaveTimer();
    scrollSyncCleanup?.();
    scrollSyncCleanup = null;
    discardPendingImages();
    discardEditorPrivateImages();
    revokeImages();
    document.body.classList.remove("article-writing-open");
    $("articleEditor").closest(".article-layout").classList.remove("is-editing");
    $("articleHome").hidden = true;
    $("articleEditor").closest(".article-layout").hidden = false;
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
    setJournalNav("articles");
    toggleTradePicker(false);
    hydrateArticleImages($("articleMarkdown"));
    renderList();
  }

  async function openArticle(articleId, { historyMode = "push" } = {}) {
    if (dirty && !confirm("当前编辑内容尚未保存，确定离开吗？")) return;
    const deleted = trashMode ? "?deleted=1" : "";
    const previousId = current?.id;
    const payload = await apiFetch(`/api/articles/${encodeURIComponent(articleId)}${deleted}`);
    current = payload.article;
    setDirty(false);
    renderReader(current);
    if (previousId !== current.id) recordAccess?.("article", current.id, current.title);
    if (historyMode !== "none") setHash(articleHash(articleId), historyMode);
  }

  function articleTrades() {
    return tradePickerTrades(getDashboard());
  }

  function tradeToolbarButton() {
    return document.querySelector('#articleContentEditor .vditor-toolbar button[data-type="trade-reference"]');
  }

  function mountTradeToolbarPopover() {
    const toolbar = document.querySelector("#articleContentEditor .vditor-toolbar");
    const popover = $("articleTradePopover");
    if (toolbar && popover.parentElement !== toolbar) toolbar.append(popover);
    const button = tradeToolbarButton();
    if (!button) return;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-controls", "articleTradePopover");
    button.setAttribute("aria-expanded", String(!popover.hidden));
  }

  function toggleTradePicker(forceOpen) {
    const popover = $("articleTradePopover");
    const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : popover.hidden;
    popover.hidden = !shouldOpen;
    const button = tradeToolbarButton();
    if (button) button.setAttribute("aria-expanded", String(shouldOpen));
    if (!shouldOpen) return;
    renderTradePicker();
    window.setTimeout(() => $("articleTradeSearch").focus(), 0);
  }

  function renderTradePicker() {
    const query = $("articleTradeSearch").value.trim().toLocaleLowerCase("zh-CN");
    const trades = articleTrades().filter((trade) => !query || [trade.tradeId, trade.instrument, trade.contract]
      .join(" ").toLocaleLowerCase("zh-CN").includes(query));
    const markdown = (articleEditorInstance?.getValue() || pendingEditorValue).toUpperCase();
    $("articleTradePicker").innerHTML = trades.length ? trades.map((trade) => `
      <div class="article-trade-picker-row">
        <button type="button" data-insert-article-trade="${esc(trade.tradeId)}" aria-pressed="${markdown.includes(`TRADE:${trade.tradeId}`)}"><span>${esc(trade.tradeId)} · ${esc(trade.instrument || trade.contract || "")}</span></button>
      </div>`).join("") : '<span class="article-list-empty">没有匹配的交易</span>';
    $("articleTradePicker").querySelectorAll("[data-insert-article-trade]").forEach((button) => button.addEventListener("click", () => insertTradeReference(button.dataset.insertArticleTrade)));
  }

  function insertTradeReference(tradeId) {
    const trade = articleTrades().find((row) => row.tradeId === tradeId);
    if (!trade || !articleEditorInstance) { notify("Markdown 编辑器尚未准备完成", true); return; }
    articleEditorInstance.insertValue(`\n\n${formatTradeReference(trade)}\n\n`);
    const markdown = articleEditorInstance.getValue();
    pendingEditorValue = markdown;
    markEditorChanged();
    scheduleLivePreview(markdown);
    toggleTradePicker(false);
    articleEditorInstance.focus();
    notify(`${trade.tradeId} 已插入正文`);
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

  async function editArticle(article = null) {
    if (!canEdit()) { notify("当前账号仅有浏览权限", true); return; }
    clearAutosaveTimer();
    changeVersion = 0;
    editorMarkdownSnapshot = null;
    discardPendingImages();
    discardEditorPrivateImages();
    if (!article?.id) {
      trashMode = false;
      renderList();
    }
    current = article?.id ? article : null;
    $("articleHome").hidden = true;
    $("articleEditor").closest(".article-layout").hidden = false;
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
    $("articleTradeSearch").value = "";
    renderTradePicker();
    toggleTradePicker(false);
    renderEditorImages(article?.images || []);
    $("articleTitleInput").focus();
    const storedMarkdown = article?.contentMd || "";
    syncEditorMarkdown("");
    $("articleSaveButton").disabled = true;
    $("articleContentEditor").classList.add("is-loading");
    $("articleContentEditor").setAttribute("aria-busy", "true");
    $("articleSaveState").textContent = privateArticleImageIds(storedMarkdown).length ? "正在读取随笔图片…" : "正在准备编辑器…";
    try {
      const editableMarkdown = await loadPrivateImagesForEditor(storedMarkdown);
      await ensureArticleEditor(editableMarkdown);
      editorMarkdownSnapshot = {
        stored: storedMarkdown,
        editable: articleEditorInstance?.getValue() || pendingEditorValue,
      };
      setDirty(false);
      if (editorPrivateImageErrors.size) notify(`${editorPrivateImageErrors.size} 张随笔图片读取失败，请退出后重试`, true);
    } catch (error) {
      notify(error.message, true);
    } finally {
      $("articleContentEditor").classList.remove("is-loading");
      $("articleContentEditor").removeAttribute("aria-busy");
      $("articleSaveButton").disabled = false;
    }
  }

  function editorPayload() {
    const editableContent = articleEditorInstance ? articleEditorInstance.getValue() : pendingEditorValue;
    const unchangedAwareContent = editorMarkdownSnapshot
      ? preserveUnchangedMarkdown(editorMarkdownSnapshot.stored, editorMarkdownSnapshot.editable, editableContent)
      : editableContent;
    const contentMd = restorePrivateArticleImages(unchangedAwareContent, editorPrivateImageSources);
    return {
      title: $("articleTitleInput").value,
      contentMd,
      status: $("articleStatusInput").value,
      tags: $("articleTagsInput").value.split(/[，,]/).map((tag) => tag.trim()).filter(Boolean),
      tradeIds: [],
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
      const imageId = remoteSource.slice("article-image:".length).toLowerCase();
      editorPrivateImageSources.set(imageId, localUrl);
      current.images = [...(current.images || []), result.image];
      pendingPastedImages.delete(localUrl);
      renderEditorImages(current.images);
      syncEditorMarkdown(replacePrivateArticleImages(contentMd, editorPrivateImageSources));
    }
    return contentMd;
  }

  async function persistArticle({ closeAfterSave }) {
    if (savePromise) return savePromise;
    if (!$("articleTitleInput").value.trim()) {
      $("articleSaveState").textContent = "填写标题后自动保存";
      if (closeAfterSave) $("articleTitleInput").reportValidity();
      return null;
    }
    clearAutosaveTimer();
    const button = $("articleSaveButton");
    button.disabled = true;
    button.textContent = closeAfterSave ? "正在保存…" : "自动保存中…";
    $("articleSaveState").textContent = closeAfterSave ? "正在保存…" : "正在自动保存…";
    const savedChangeVersion = changeVersion;
    savePromise = (async () => {
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
      return current;
    })();
    try {
      await savePromise;
      editorMarkdownSnapshot = {
        stored: current.contentMd,
        editable: articleEditorInstance?.getValue() || pendingEditorValue,
      };
      if (savedChangeVersion === changeVersion) setDirty(false);
      else scheduleAutoSave();
      await loadSummaries();
      setHash(articleHash(current.id), "replace");
      if (closeAfterSave && !dirty) {
        renderReader(current);
        notify("随笔已保存到云端");
      }
      return current;
    } catch (error) {
      dirty = true;
      $("articleSaveState").textContent = "自动保存失败，继续输入后重试";
      const message = current?.id && pendingPastedImages.size ? `${error.message}；文章已保留，可再次保存重试图片上传` : error.message;
      notify(closeAfterSave ? message : `自动保存失败：${message}`, true);
      return null;
    } finally {
      savePromise = null;
      button.disabled = false;
      button.textContent = "立即保存";
    }
  }

  async function autosaveArticle() {
    autosaveTimer = null;
    if (!dirty || savePromise || !$("articleTitleInput").value.trim()) return;
    await persistArticle({ closeAfterSave: false });
  }

  async function saveArticle(event) {
    event.preventDefault();
    await persistArticle({ closeAfterSave: true });
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
        const remoteSource = result.markdown?.match(/\]\((article-image:[^)]+)\)/)?.[1];
        if (!remoteSource) throw new Error("图片上传完成，但没有返回有效的 Markdown 引用");
        const imageId = remoteSource.slice("article-image:".length).toLowerCase();
        const localUrl = URL.createObjectURL(prepared.blob);
        editorPrivateImageSources.set(imageId, localUrl);
        articleEditorInstance.insertValue(`\n\n${result.markdown.replace(remoteSource, localUrl)}\n`);
        current.images = [...(current.images || []), result.image];
        renderEditorImages(current.images);
        markEditorChanged();
        scheduleLivePreview(articleEditorInstance.getValue());
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
      await loadSummaries();
      setHash("#essays", "replace");
      showArticleHome();
      notify("随笔已移入回收站");
    } catch (error) { notify(error.message, true); }
  }

  async function toggleTrash() {
    discardPendingImages();
    discardEditorPrivateImages();
    trashMode = !trashMode;
    current = null;
    setHash("#essays", "replace");
    showArticleHome();
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
    clearAutosaveTimer();
    scrollSyncCleanup?.();
    scrollSyncCleanup = null;
    toggleTradePicker(false);
    setDirty(false);
    if (current) renderReader(current);
    else {
      discardPendingImages();
      discardEditorPrivateImages();
      showArticleHome();
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
      if (!$("articlesSection").hidden) showSection("trades", { updateHistory: false, trackDashboard: false });
      return;
    }
    showSection("articles", { updateHistory: false });
    if (!loaded) await loadSummaries();
    const id = articleIdFromHash(location.hash);
    if (id) await openArticle(id, { historyMode: "none" });
    else showArticleHome();
  }

  $("tradesSectionButton").addEventListener("click", () => showSection("trades"));
  $("articlesSectionButton").addEventListener("click", () => showSection("articles"));
  $("journalHomeButton").addEventListener("click", () => { setHash("#essays"); showArticleHome(); });
  $("journalHomeNavButton").addEventListener("click", () => { setHash("#essays"); showArticleHome(); });
  $("journalArticlesButton").addEventListener("click", () => {
    setHash("#essays");
    showArticleHome({ clearCurrent: false });
    setJournalNav("articles");
    $("journalRecent").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("journalTradesButton").addEventListener("click", () => showSection("trades"));
  $("journalWriteButton").addEventListener("click", () => editArticle(null).catch((error) => notify(error.message, true)));
  $("journalTagsButton").addEventListener("click", () => {
    setHash("#essays");
    showArticleHome({ clearCurrent: false });
    showJournalIndex("tags");
  });
  $("journalArchiveButton").addEventListener("click", () => {
    setHash("#essays");
    showArticleHome({ clearCurrent: false });
    showJournalIndex("archive");
  });
  $("journalAllTopicsButton").addEventListener("click", () => showJournalIndex("tags"));
  $("journalAllArchiveButton").addEventListener("click", () => showJournalIndex("archive"));
  $("journalSearchButton").addEventListener("click", () => {
    $("journalAccount").open = true;
    window.setTimeout(() => $("articleSearch").focus(), 0);
  });
  $("journalAboutButton").addEventListener("click", () => {
    setHash("#essays");
    showArticleHome({ clearCurrent: false });
    $("journalIntro").hidden = true;
    $("journalHomeGrid").hidden = true;
    $("journalIndexView").hidden = true;
    $("journalAbout").hidden = false;
    setJournalNav("about");
    $("journalAbout").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("articleReaderBack").addEventListener("click", () => { setHash("#essays"); showArticleHome(); });
  ["articleSearch", "articleStatusFilter", "articleTagFilter"].forEach((id) => $(id).addEventListener(id === "articleSearch" ? "input" : "change", renderList));
  $("newArticleButton").addEventListener("click", () => editArticle(null).catch((error) => notify(error.message, true)));
  $("articleImportInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { await editArticle(deriveImportedArticle(file.name, await file.text())); markEditorChanged(); }
    catch (error) { notify(error.message, true); }
    event.target.value = "";
  });
  $("articleTrashButton").addEventListener("click", toggleTrash);
  $("articleEditButton").addEventListener("click", () => editArticle(current).catch((error) => notify(error.message, true)));
  $("articleDownloadButton").addEventListener("click", exportCurrent);
  $("articleHistoryButton").addEventListener("click", openHistory);
  $("articleDeleteButton").addEventListener("click", () => current?.deletedAt ? restoreCurrent() : deleteCurrent());
  $("articleEditor").addEventListener("submit", saveArticle);
  $("articleTradeSearch").addEventListener("input", () => renderTradePicker());
  $("articleTradePopoverClose").addEventListener("click", () => toggleTradePicker(false));
  $("articleMarkdown").addEventListener("click", (event) => {
    const reference = event.target.closest?.("[data-article-trade-id]");
    if (reference) openTrade(reference.dataset.articleTradeId);
  });
  $("articleEditor").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      $("articleEditor").requestSubmit();
    }
    if (event.key === "Escape" && !$("articleTradePopover").hidden) {
      event.preventDefault();
      toggleTradePicker(false);
      articleEditorInstance?.focus();
      return;
    }
    if (event.key === "Escape") cancelEditor();
  });
  document.addEventListener("pointerdown", (event) => {
    if ($("articleTradePopover").hidden) return;
    if (event.target.closest?.("#articleTradePopover") || event.target.closest?.('[data-type="trade-reference"]')) return;
    toggleTradePicker(false);
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
  $("articleTitleInput").addEventListener("input", () => { markEditorChanged(); updateLivePreview(articleEditorInstance?.getValue() || pendingEditorValue); });
  ["articleStatusInput", "articleTagsInput"].forEach((id) => $(id).addEventListener("input", markEditorChanged));
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
      $("journalWriteButton").hidden = !canEdit();
      $("journalUserName").textContent = user?.name || user?.login || "私人手记";
      const initial = (user?.name || user?.login || "我").trim().slice(0, 1).toUpperCase();
      $("journalUserInitial").textContent = initial;
      $("journalBrandFallback").textContent = initial;
      $("journalProfileFallback").textContent = initial;
      for (const imageId of ["journalBrandAvatar", "journalProfileAvatar"]) {
        const image = $(imageId);
        const fallback = image.nextElementSibling;
        image.hidden = !user?.avatar;
        fallback.hidden = Boolean(user?.avatar);
        if (user?.avatar) image.src = user.avatar;
      }
      $("articleEmpty").querySelector("p").textContent = canEdit()
        ? "也可以新建或导入 Markdown 文件。"
        : "请选择一篇手记进行阅读。";
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
