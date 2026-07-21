import { buildEquityChartModel, tooltipPlacement } from "./equity-chart.js?v=20260721-1";

(() => {
  const CONFIG = window.TRADE_CONFIG || {};
  const API = String(CONFIG.apiBase || "").replace(/\/$/, "");
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = "tradeReviewToken";
  const RENEW_INTERVAL_MS = 12 * 60 * 60 * 1000;
  const filters = ["instrument", "direction", "session", "result"];
  const selects = Object.fromEntries(filters.map((name) => [name, $(`${name}Filter`)]));
  let dashboard = null;
  let token = readToken();
  let toastTimer = null;
  let attachmentObjectUrls = [];
  let activeTradeId = null;
  let attachmentUploadBusy = false;
  let lightboxTrigger = null;
  let lightboxItems = [];
  let lightboxIndex = -1;
  let lightboxZoom = 1;
  let dashboardScrollY = 0;
  let workspaceTrigger = null;

  function readToken() {
    try { return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || ""; }
    catch { return sessionStorage.getItem(TOKEN_KEY) || ""; }
  }

  function saveToken(value) {
    token = value || "";
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
      return;
    } catch {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    }
  }

  function clearToken() { saveToken(""); }

  const money = (value) => new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0));
  const pct = (value) => `${(Number(value || 0) * 100).toFixed(1)}%`;
  const num = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const signedClass = (value) => Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "";
  const optionList = (values, current, empty = "待补充") => [`<option value="">${empty}</option>`, ...values.map((value) => `<option value="${esc(value)}" ${String(value) === String(current || "") ? "selected" : ""}>${esc(value)}</option>`)].join("");
  const durationText = (seconds) => {
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.round(seconds % 60);
    return h ? `${h}时${m}分` : m ? `${m}分${s}秒` : `${s}秒`;
  };
  const formatBytes = (bytes) => Number(bytes || 0) >= 1024 * 1024 ? `${(Number(bytes) / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(Number(bytes || 0) / 1024))} KB`;
  const formatCloudTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", { timeZone: dashboard?.meta?.timezone || "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";

  function clearAttachmentUrls() {
    attachmentObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    attachmentObjectUrls = [];
    lightboxItems = [];
    lightboxIndex = -1;
  }

  function setLightboxZoom(value) {
    lightboxZoom = Math.min(3, Math.max(.5, Math.round(value * 10) / 10));
    $("imageLightboxFigure").style.setProperty("--lightbox-zoom", lightboxZoom);
    $("imageLightboxZoomReset").textContent = `${Math.round(lightboxZoom * 100)}%`;
  }

  function renderLightboxItem() {
    const item = lightboxItems[lightboxIndex];
    if (!item) return;
    $("imageLightboxImage").src = item.url;
    $("imageLightboxImage").alt = item.attachment.fileName || "交易复盘图";
    $("imageLightboxCaption").textContent = `${item.attachment.fileName || "交易复盘图"} · ${lightboxIndex + 1} / ${lightboxItems.length}`;
    $("imageLightboxPrevious").disabled = lightboxItems.length < 2;
    $("imageLightboxNext").disabled = lightboxItems.length < 2;
    $("imageLightboxStage").scrollTo({ top: 0, left: 0 });
    setLightboxZoom(1);
  }

  function switchLightboxItem(direction) {
    if (lightboxItems.length < 2) return;
    lightboxIndex = (lightboxIndex + direction + lightboxItems.length) % lightboxItems.length;
    renderLightboxItem();
  }

  function openImageLightbox(url, attachment, trigger) {
    lightboxTrigger = trigger || null;
    lightboxIndex = lightboxItems.findIndex((item) => item.url === url);
    if (lightboxIndex < 0) {
      lightboxItems.push({ url, attachment });
      lightboxIndex = lightboxItems.length - 1;
    }
    renderLightboxItem();
    $("imageLightbox").hidden = false;
    document.body.classList.add("lightbox-open");
    $("imageLightboxClose").focus();
  }

  function closeImageLightbox() {
    if ($("imageLightbox").hidden) return;
    $("imageLightbox").hidden = true;
    document.body.classList.remove("lightbox-open");
    $("imageLightboxImage").removeAttribute("src");
    setLightboxZoom(1);
    if (lightboxTrigger?.isConnected) lightboxTrigger.focus();
    lightboxTrigger = null;
  }

  async function prepareAttachment(file) {
    const maxBytes = 1_700_000;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("仅支持 PNG、JPEG 或 WebP 图片");
    if (file.size <= maxBytes) return { blob: file, fileName: file.name };

    const sourceUrl = URL.createObjectURL(file);
    try {
      const source = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("无法读取这张图片"));
        image.src = sourceUrl;
      });
      let scale = Math.min(1, 2400 / Math.max(source.naturalWidth, source.naturalHeight));
      let result = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
        const context = canvas.getContext("2d", { alpha: false });
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const quality = Math.max(.68, .92 - attempt * .05);
        result = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
        if (result && result.size <= maxBytes) break;
        scale *= .82;
      }
      if (!result || result.size > maxBytes) throw new Error("图片压缩后仍然过大，请先裁剪后上传");
      return { blob: result, fileName: file.name.replace(/\.[^.]+$/, "") + ".webp" };
    } finally { URL.revokeObjectURL(sourceUrl); }
  }

  async function loadAttachmentPreviews(trade) {
    for (const attachment of trade.attachments || []) {
      const host = document.querySelector(`[data-attachment-id="${attachment.id}"] .evidence-preview`);
      if (!host) continue;
      try {
        const response = await fetch(`${API}/api/attachments/${encodeURIComponent(attachment.id)}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error("图片读取失败");
        const url = URL.createObjectURL(await response.blob());
        attachmentObjectUrls.push(url);
        lightboxItems.push({ url, attachment });
        const image = document.createElement("img");
        image.src = url;
        image.alt = `${trade.tradeId} ${attachment.fileName}`;
        host.replaceChildren(image);
        host.classList.add("loaded");
        host.addEventListener("click", () => openImageLightbox(url, attachment, host));
      } catch (error) { host.textContent = error.message; host.classList.add("failed"); }
    }
  }

  function clipboardFileName(mimeType, index = 0) {
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[mimeType] || "png";
    const stamp = new Date().toLocaleString("sv-SE", { hour12: false }).replace(/[\s:]/g, "-");
    return `剪贴板-${stamp}${index ? `-${index + 1}` : ""}.${extension}`;
  }

  function clipboardEventImages(clipboardData) {
    return [...(clipboardData?.items || [])]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item, index) => {
        const blob = item.getAsFile();
        return blob ? new File([blob], blob.name || clipboardFileName(blob.type, index), { type: blob.type }) : null;
      })
      .filter(Boolean);
  }

  async function uploadAttachmentFiles(inputFiles, trade) {
    const files = [...inputFiles].filter((file) => file.type.startsWith("image/"));
    if (!files.length) { notify("剪贴板中没有可用的图片", true); return; }
    if (attachmentUploadBusy) { notify("上一批图片仍在处理中"); return; }
    const currentTrade = dashboard?.trades?.find((row) => row.tradeId === trade.tradeId) || trade;
    const existingCount = (currentTrade.attachments || []).length;
    if (existingCount + files.length > 5) { notify(`这笔交易还可以添加 ${Math.max(0, 5 - existingCount)} 张复盘图`, true); return; }

    attachmentUploadBusy = true;
    document.querySelectorAll("#attachmentInput, #pasteAttachment").forEach((control) => { control.disabled = true; });
    $("uploadState").textContent = `正在处理 1 / ${files.length}…`;
    try {
      for (let index = 0; index < files.length; index += 1) {
        $("uploadState").textContent = `正在处理 ${index + 1} / ${files.length}…`;
        const prepared = await prepareAttachment(files[index]);
        await apiFetch(`/api/trades/${encodeURIComponent(trade.tradeId)}/attachments`, {
          method: "POST",
          body: prepared.blob,
          headers: { "Content-Type": prepared.blob.type, "X-File-Name": encodeURIComponent(prepared.fileName || clipboardFileName(prepared.blob.type, index)) },
        });
      }
      await refreshDashboard();
      openTradeWorkspace(dashboard.trades.find((row) => row.tradeId === trade.tradeId), { historyMode: "none", scrollTop: $("tradeWorkspace").scrollTop });
      notify(`${files.length} 张复盘图已保存到云端`);
    } catch (error) {
      document.querySelectorAll("#attachmentInput, #pasteAttachment").forEach((control) => { control.disabled = false; });
      $("uploadState").textContent = "上传失败";
      notify(error.message, true);
    } finally { attachmentUploadBusy = false; }
  }

  async function readClipboardImages() {
    if (!navigator.clipboard?.read) throw new Error("当前浏览器不支持按钮读取，请直接按 Ctrl+V 粘贴");
    const items = await navigator.clipboard.read();
    const files = [];
    for (const item of items) {
      const mimeType = item.types.find((type) => type.startsWith("image/"));
      if (!mimeType) continue;
      const blob = await item.getType(mimeType);
      files.push(new File([blob], clipboardFileName(mimeType, files.length), { type: mimeType }));
    }
    return files;
  }

  function notify(message, error = false) {
    const node = $("toast");
    node.textContent = message;
    node.classList.toggle("error", error);
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), 2800);
  }

  function setAuthVisible(visible, message = "") {
    if (visible) {
      document.body.classList.remove("drawer-open");
      if (!$("tradeWorkspace").hidden) hideTradeWorkspace({ restoreFocus: false, restoreScroll: false });
    }
    $("authScreen").hidden = !visible;
    $("app").hidden = visible;
    $("authError").hidden = !message;
    $("authError").textContent = message;
  }

  async function apiFetch(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
    });
    const contentType = response.headers.get("Content-Type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    if (response.status === 401) {
      clearToken();
      setAuthVisible(true, "登录已过期，请重新使用 GitHub 登录。");
      throw new Error("登录已过期");
    }
    if (!response.ok) throw new Error(payload.error || payload || "云端请求失败");
    return payload;
  }

  function parseLoginToken() {
    const match = location.hash.match(/(?:^#|&)token=([^&]+)/);
    if (!match) return;
    saveToken(decodeURIComponent(match[1]));
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }

  async function renewSession() {
    if (!token) return;
    const renewed = await apiFetch("/api/session/refresh", { method: "POST" });
    if (renewed.token) saveToken(renewed.token);
  }

  function login() {
    if (!API || API.includes("__API_BASE__")) {
      setAuthVisible(true, "云端服务尚未完成配置。");
      return;
    }
    const returnUrl = `${location.origin}${location.pathname}`;
    location.href = `${API}/auth/login?return=${encodeURIComponent(returnUrl)}`;
  }

  function selectedTrades() {
    return (dashboard?.trades || []).filter((trade) => filters.every((key) => !selects[key].value || trade[key] === selects[key].value));
  }

  function stats(trades) {
    const wins = trades.filter((trade) => trade.netPnl > 0), losses = trades.filter((trade) => trade.netPnl < 0);
    const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
    const grossWins = sum(wins, "netPnl"), grossLosses = Math.abs(sum(losses, "netPnl"));
    let cumulative = 0, high = 0, maxDrawdown = 0;
    trades.forEach((trade) => { cumulative += trade.netPnl; high = Math.max(high, cumulative, 0); maxDrawdown = Math.min(maxDrawdown, cumulative - high); });
    const net = sum(trades, "netPnl"), gross = sum(trades, "grossPnl"), fees = sum(trades, "fees");
    const avgWin = wins.length ? grossWins / wins.length : 0, avgLoss = losses.length ? grossLosses / losses.length : 0;
    return {
      count: trades.length, wins: wins.length, losses: losses.length, net, gross, fees,
      winRate: trades.length ? wins.length / trades.length : 0,
      payoff: avgLoss ? avgWin / avgLoss : null,
      factor: grossLosses ? grossWins / grossLosses : null,
      expectancy: trades.length ? net / trades.length : 0,
      maxDrawdown,
    };
  }

  function setMetric(id, value, sign = null) {
    const node = $(id);
    node.textContent = value;
    node.classList.remove("positive", "negative");
    if (sign !== null) node.classList.add(signedClass(sign));
  }

  function renderKpis(trades, summary) {
    setMetric("kpiNet", `¥ ${money(summary.net)}`, summary.net);
    $("kpiGross").textContent = `毛盈亏 ¥${money(summary.gross)}`;
    setMetric("kpiWinRate", pct(summary.winRate), summary.winRate >= .5 ? 1 : -1);
    $("kpiWins").textContent = `${summary.wins} 盈 / ${summary.losses} 亏`;
    setMetric("kpiPayoff", summary.payoff === null ? "—" : num(summary.payoff), summary.payoff === null ? null : summary.payoff - 1);
    setMetric("kpiFactor", summary.factor === null ? "—" : num(summary.factor), summary.factor === null ? null : summary.factor - 1);
    setMetric("kpiTrades", String(summary.count));
    const longs = trades.filter((trade) => trade.direction === "多").length;
    $("kpiDirections").textContent = `${longs} 多 / ${summary.count - longs} 空`;
    setMetric("kpiFees", `¥ ${money(summary.fees)}`, -summary.fees);
    $("kpiFeeShare").textContent = summary.gross ? `占毛盈亏 ${pct(Math.abs(summary.fees / summary.gross))}` : "暂无毛盈亏";
    setMetric("kpiExpectancy", `¥ ${money(summary.expectancy)}`, summary.expectancy);
    setMetric("kpiDrawdown", `¥ ${money(summary.maxDrawdown)}`, summary.maxDrawdown);
  }

  function renderChart(trades) {
    const svg = $("equityChart");
    const shell = $("equityChartShell");
    const tooltip = $("equityTooltip");
    const openButton = $("equityTooltipOpen");
    const model = buildEquityChartModel(trades);
    const { width: W, height: H, pad, values, points, hitBounds, ticks, line, area } = model;
    tooltip.hidden = true;
    shell.onmouseleave = null;
    shell.onfocusout = null;
    openButton.onclick = null;
    if (!trades.length) {
      svg.innerHTML = `<text x="450" y="140" text-anchor="middle" class="axis-label">暂无交易</text>`;
      $("chartCaption").textContent = "0 笔完整交易";
      return;
    }
    svg.innerHTML = `<defs><linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c94338" stop-opacity=".23"/><stop offset="1" stop-color="#c94338" stop-opacity="0"/></linearGradient></defs>
      <title>累计净盈亏折线图</title><desc>悬停或点击节点查看交易数据；使用左右方向键切换节点，按回车打开交易详情。</desc>
      ${ticks.map((value, index) => `<line class="axis" x1="${pad.l}" y1="${points.length ? pad.t + index / 4 * (H - pad.t - pad.b) : 0}" x2="${W - pad.r}" y2="${points.length ? pad.t + index / 4 * (H - pad.t - pad.b) : 0}"/><text class="axis-label" x="${pad.l - 9}" y="${pad.t + index / 4 * (H - pad.t - pad.b) + 3}" text-anchor="end">${Math.round(value)}</text>`).join("")}
      <path class="equity-area" d="${area}"/><path class="equity-line" d="${line}"/>
      <line class="equity-guide" x1="0" y1="${pad.t}" x2="0" y2="${H - pad.b}"/>
      ${values.map((point, index) => `<g class="chart-target" data-index="${index}" role="button" tabindex="0" aria-label="${esc(`${point.id}，${point.date}，单笔盈亏 ${money(point.pnl)} 元，累计净盈亏 ${money(point.value)} 元`)}"><rect class="chart-hit" x="${hitBounds[index].start}" y="${pad.t}" width="${hitBounds[index].end - hitBounds[index].start}" height="${H - pad.t - pad.b}"/><circle class="point" cx="${points[index][0]}" cy="${points[index][1]}" r="3.3"><title>${esc(point.id)}｜单笔 ¥${money(point.pnl)}｜累计 ¥${money(point.value)}</title></circle></g>`).join("")}
      ${values.map((point, index) => values.length <= 12 ? `<text class="axis-label" x="${points[index][0]}" y="${H - 12}" text-anchor="middle">${esc(point.id.replace("TR-", "#"))}</text>` : "").join("")}`;
    svg.setAttribute("aria-label", `累计净盈亏折线图，共 ${values.length} 笔交易。使用左右方向键切换节点，按回车打开交易详情。`);
    const guide = svg.querySelector(".equity-guide");
    const targets = [...svg.querySelectorAll(".chart-target")];
    let activeIndex = -1;

    const hideTooltip = () => {
      activeIndex = -1;
      tooltip.hidden = true;
      guide.classList.remove("is-visible");
      targets.forEach((target) => target.classList.remove("is-active"));
    };
    const activatePoint = (index, { focus = false } = {}) => {
      if (index < 0 || index >= values.length) return;
      activeIndex = index;
      const point = values[index];
      const [pointX, pointY] = points[index];
      const placement = tooltipPlacement(points[index], W, H);
      targets.forEach((target, targetIndex) => target.classList.toggle("is-active", targetIndex === index));
      guide.classList.add("is-visible");
      guide.setAttribute("x1", pointX);
      guide.setAttribute("x2", pointX);
      $("equityTooltipId").textContent = point.id;
      $("equityTooltipDate").textContent = point.date;
      $("equityTooltipSummary").textContent = point.summary;
      $("equityTooltipPnl").textContent = `¥${money(point.pnl)}`;
      $("equityTooltipPnl").className = signedClass(point.pnl);
      $("equityTooltipTotal").textContent = `¥${money(point.value)}`;
      $("equityTooltipTotal").className = signedClass(point.value);
      openButton.setAttribute("aria-label", `打开 ${point.id} 交易详情`);
      tooltip.dataset.horizontal = placement.horizontal;
      tooltip.dataset.vertical = placement.vertical;
      tooltip.style.left = `${pointX / W * 100}%`;
      tooltip.style.top = `${pointY / H * 100}%`;
      tooltip.hidden = false;
      if (focus) targets[index].focus();
    };
    const openTradeAt = (index, trigger) => {
      const trade = trades[index];
      if (!trade) return;
      workspaceTrigger = trigger || targets[index];
      openTradeWorkspace(trade);
    };
    const moveFocus = (fromIndex, direction) => activatePoint(Math.max(0, Math.min(values.length - 1, fromIndex + direction)), { focus: true });

    targets.forEach((target, index) => {
      target.addEventListener("mouseenter", () => activatePoint(index));
      target.addEventListener("pointerup", (event) => {
        if (event.pointerType === "touch") { event.preventDefault(); activatePoint(index); return; }
        openTradeAt(index, target);
      });
      target.addEventListener("focus", () => activatePoint(index));
      target.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          moveFocus(index, event.key === "ArrowLeft" ? -1 : 1);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openTradeAt(index, target);
        } else if (event.key === "Escape") {
          event.preventDefault();
          hideTooltip();
          target.blur();
        }
      });
    });
    shell.onmouseleave = () => { if (!shell.contains(document.activeElement)) hideTooltip(); };
    shell.onfocusout = () => requestAnimationFrame(() => { if (!shell.contains(document.activeElement)) hideTooltip(); });
    openButton.onclick = () => openTradeAt(activeIndex, openButton);
    $("chartCaption").textContent = `${values.length} 笔完整交易 · 悬停或点击查看`;
  }

  function aggregate(trades, key) {
    const map = new Map();
    trades.forEach((trade) => map.set(trade[key] || "待补充", (map.get(trade[key] || "待补充") || 0) + trade.netPnl));
    return [...map.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  }

  function renderBars(id, rows) {
    const host = $(id); host.innerHTML = "";
    if (!rows.length) { host.innerHTML = `<div class="empty">暂无数据</div>`; return; }
    const max = Math.max(1, ...rows.map(([, value]) => Math.abs(value)));
    rows.forEach(([label, value]) => {
      const row = document.createElement("div"); row.className = "bar-row";
      row.innerHTML = `<div class="bar-label">${esc(label)}</div><div class="bar-track"><div class="bar-fill ${value < 0 ? "loss" : ""}" style="width:${Math.abs(value) / max * 100}%"></div></div><div class="bar-value ${signedClass(value)}">¥${money(value)}</div>`;
      host.append(row);
    });
  }

  function renderBrief(trades, summary) {
    if (!trades.length) return;
    const best = [...trades].sort((a, b) => b.netPnl - a.netPnl)[0];
    const worst = [...trades].sort((a, b) => a.netPnl - b.netPnl)[0];
    const averageDuration = trades.reduce((sum, trade) => sum + trade.holdingSeconds, 0) / trades.length;
    $("briefIndex").textContent = String(Math.min(99, trades.length)).padStart(2, "0");
    $("briefTitle").textContent = summary.losses === 0 ? "当前样本全部盈利，仍需等待亏损样本" : summary.winRate >= .6 ? "当前胜率较高，继续验证可重复性" : "优先检查亏损交易的共同结构";
    $("briefText").textContent = `净盈亏 ${money(summary.net)} 元，手续费占毛盈亏约 ${pct(summary.gross ? Math.abs(summary.fees / summary.gross) : 0)}。${summary.payoff ? `平均盈利约为平均亏损的 ${num(summary.payoff)} 倍。` : "当前亏损样本不足，盈亏比暂不具备统计意义。"}`;
    $("bestTrade").textContent = `${best.tradeId} · ¥${money(best.netPnl)}`;
    $("worstTrade").textContent = `${worst.tradeId} · ¥${money(worst.netPnl)}`;
    $("avgDuration").textContent = durationText(averageDuration);
  }

  function renderRows(trades) {
    const body = $("tradeRows"); body.innerHTML = ""; $("emptyState").hidden = trades.length > 0;
    [...trades].reverse().forEach((trade) => {
      const row = document.createElement("tr"); row.tabIndex = 0;
      row.innerHTML = `<td>${esc(trade.tradeId)}</td><td>${esc(trade.dateLabel)}</td><td>${esc(trade.instrument)} / ${esc(trade.contract)}</td><td><span class="direction-pill ${trade.direction === "多" ? "long" : "short"}">${esc(trade.direction)}</span></td><td>${esc(trade.entryTime)} → ${esc(trade.exitTime)}</td><td>${esc(trade.holdingLabel)}</td><td>${trade.entryQty}</td><td class="${signedClass(trade.grossPnl)}">${money(trade.grossPnl)}</td><td>${money(trade.fees)}</td><td class="${signedClass(trade.netPnl)}">${money(trade.netPnl)}</td><td>${esc(trade.result)}</td><td><span class="evidence-count ${(trade.attachments || []).length ? "has-evidence" : ""}">${(trade.attachments || []).length || "—"}</span></td>`;
      row.addEventListener("click", () => { workspaceTrigger = row; openTradeWorkspace(trade); });
      row.addEventListener("keydown", (event) => { if (event.key === "Enter") { workspaceTrigger = row; openTradeWorkspace(trade); } });
      body.append(row);
    });
  }

  function render() {
    const trades = selectedTrades(), summary = stats(trades);
    renderKpis(trades, summary); renderChart(trades); renderBrief(trades, summary); renderBars("instrumentBars", aggregate(trades, "instrument")); renderBars("sessionBars", aggregate(trades, "session")); renderRows(trades);
    const pending = (dashboard?.trades || []).filter((trade) => trade.dateStatus !== "已确认").length;
    $("notice").classList.toggle("ok", pending === 0);
    $("noticeText").textContent = pending ? `有 ${pending} 笔交易日期待确认；盈亏已计入总览，日期维度暂不作为结论。` : "所有交易日期已确认，日期维度统计可用。";
    const updated = dashboard?.meta?.cloudUpdatedAt ? new Intl.DateTimeFormat("zh-CN", { timeZone: dashboard.meta.timezone || "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(dashboard.meta.cloudUpdatedAt)) : dashboard?.meta?.lastUpdated || "—";
    $("footerMeta").textContent = `云端更新：${updated} · ${dashboard?.meta?.fillCount || 0} 条成交 · ${dashboard?.trades?.length || 0} 笔完整交易`;
    $("trashCount").textContent = String(dashboard?.deletedTrades?.length || 0);
  }

  function openTrashDrawer() {
    clearAttachmentUrls();
    activeTradeId = null;
    const deletedTrades = dashboard?.deletedTrades || [];
    const cards = deletedTrades.map((trade) => `<article class="trash-card">
      <div class="trash-card-main"><span>${esc(trade.tradeId)} · ${esc(trade.dateLabel)}</span><h3>${esc(trade.instrument)} ${esc(trade.contract)} · ${esc(trade.direction)}单</h3><p>${esc(trade.entryTime)} → ${esc(trade.exitTime)} · ${esc(trade.result)} · 删除于 ${esc(formatCloudTime(trade.deletedAt))}</p></div>
      <div class="trash-card-side"><b class="${signedClass(trade.netPnl)}">¥${money(trade.netPnl)}</b><button class="ghost-button restore-button" type="button" data-restore-trade="${esc(trade.tradeId)}">恢复交易</button></div>
    </article>`).join("");
    $("drawerContent").innerHTML = `<div class="drawer-sub">RECYCLE BIN · ${deletedTrades.length} 笔</div><h2>交易回收站</h2><p class="trash-intro">这里的交易不参与胜率、盈亏与图表统计。恢复后，原有复盘文字和截图会一起回来。</p><div class="trash-list">${cards || `<div class="trash-empty"><b>回收站是空的</b><span>从交易详情中移除的记录会出现在这里。</span></div>`}</div>`;
    document.body.classList.add("drawer-open");
    document.querySelectorAll("[data-restore-trade]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "正在恢复…";
        try {
          await apiFetch(`/api/trades/${encodeURIComponent(button.dataset.restoreTrade)}/restore`, { method: "POST" });
          await refreshDashboard();
          openTrashDrawer();
          notify(`${button.dataset.restoreTrade} 已恢复，统计已更新`);
        } catch (error) { button.disabled = false; button.textContent = "恢复交易"; notify(error.message, true); }
      });
    });
  }

  function tradeRouteId() {
    const match = location.hash.match(/^#trade=(TR-\d+)$/);
    return match ? match[1] : "";
  }

  function setTradeRoute(tradeId, mode = "push") {
    const target = `${location.pathname}${location.search}${tradeId ? `#trade=${tradeId}` : ""}`;
    const fromDashboard = tradeId ? mode === "push" || Boolean(history.state?.fromDashboard) : false;
    history[`${mode}State`]({ tradeDetail: tradeId || null, fromDashboard }, "", target);
  }

  function hideTradeWorkspace({ restoreFocus = true, restoreScroll = true } = {}) {
    if ($("tradeWorkspace").hidden) return;
    closeImageLightbox();
    $("tradeWorkspace").hidden = true;
    document.body.classList.remove("workspace-open");
    $("app").inert = false;
    $("app").removeAttribute("aria-hidden");
    activeTradeId = null;
    clearAttachmentUrls();
    if (restoreScroll) requestAnimationFrame(() => window.scrollTo({ top: dashboardScrollY, behavior: "auto" }));
    if (restoreFocus && workspaceTrigger?.isConnected) workspaceTrigger.focus();
    workspaceTrigger = null;
  }

  function requestCloseTradeWorkspace() {
    if (history.state?.tradeDetail && history.state?.fromDashboard) history.back();
    else {
      setTradeRoute("", "replace");
      hideTradeWorkspace();
    }
  }

  function openTradeWorkspace(trade, { historyMode = "push", scrollTop = null, evidenceScrollTop = null, reviewScrollTop = null } = {}) {
    if (!trade) return;
    const workspace = $("tradeWorkspace");
    const wasHidden = workspace.hidden;
    const sameTrade = !wasHidden && activeTradeId === trade.tradeId;
    const nextWorkspaceScroll = scrollTop ?? (sameTrade ? workspace.scrollTop : 0);
    const nextEvidenceScroll = evidenceScrollTop ?? (sameTrade ? document.querySelector(".workspace-evidence")?.scrollTop || 0 : 0);
    const nextReviewScroll = reviewScrollTop ?? (sameTrade ? document.querySelector(".workspace-review-rail")?.scrollTop || 0 : 0);
    if (wasHidden) dashboardScrollY = window.scrollY;
    document.body.classList.remove("drawer-open");
    clearAttachmentUrls();
    activeTradeId = trade.tradeId;
    if (historyMode !== "none") setTradeRoute(trade.tradeId, historyMode);
    const attachments = trade.attachments || [];
    const evidenceCards = attachments.map((attachment, index) => `<article class="evidence-card ${index === 0 ? "featured" : ""}" data-attachment-id="${esc(attachment.id)}">
      <button class="evidence-preview" type="button" aria-label="查看 ${esc(attachment.fileName)}"><span>正在读取图表…</span></button>
      <div class="evidence-meta"><div><b>${esc(attachment.fileName)}</b><small>${formatBytes(attachment.byteSize)}</small></div><button class="evidence-delete" type="button" data-delete-attachment="${esc(attachment.id)}">删除</button></div>
    </article>`).join("");
    const tradeIndex = (dashboard?.trades || []).findIndex((row) => row.tradeId === trade.tradeId);
    const previous = tradeIndex > 0 ? dashboard.trades[tradeIndex - 1] : null;
    const next = tradeIndex >= 0 && tradeIndex < dashboard.trades.length - 1 ? dashboard.trades[tradeIndex + 1] : null;
    $("workspaceKicker").textContent = `${trade.tradeId} · ${trade.dateLabel} · ${trade.session}`;
    $("workspaceTitle").textContent = `${trade.instrument} ${trade.contract} · ${trade.direction}单`;
    $("previousTrade").disabled = !previous;
    $("nextTrade").disabled = !next;
    $("workspaceSave").disabled = false;
    $("workspaceSave").textContent = "保存复盘";
    $("tradeWorkspaceContent").innerHTML = `<div class="workspace-primary-grid">
      <section class="workspace-panel workspace-evidence"><div class="evidence-heading"><div><small>CHART EVIDENCE</small><h2>图表证据</h2></div><span>${attachments.length} / 5 张</span></div>
        <p class="edit-hint">保存标有入场、止盈、止损和交易想法的 K 线截图。打开本交易后，随时可按 <kbd>Ctrl</kbd> + <kbd>V</kbd> 粘贴。</p>
        <div class="evidence-grid">${evidenceCards || `<div class="evidence-empty">这笔交易还没有复盘图</div>`}</div>
        <div class="evidence-actions">
          <label class="evidence-upload ${attachments.length >= 5 ? "disabled" : ""}"><span>＋ 选择图片</span><small>支持多选</small><input id="attachmentInput" type="file" accept="image/png,image/jpeg,image/webp" multiple ${attachments.length >= 5 ? "disabled" : ""}></label>
          <button class="evidence-paste" id="pasteAttachment" type="button" ${attachments.length >= 5 ? "disabled" : ""}><span>粘贴剪贴板图片</span><small>也可直接按 Ctrl+V</small></button>
        </div>
        <div class="upload-state" id="uploadState"></div>
      </section>
      <div class="workspace-review-rail" aria-label="交易摘要与复盘表单">
        <aside class="workspace-panel workspace-summary"><div class="summary-label">TRADE SNAPSHOT</div><div class="workspace-result"><span>净盈亏</span><b class="${signedClass(trade.netPnl)}">¥${money(trade.netPnl)}</b><small>${esc(trade.result)} · ${num(trade.points)} 点</small></div>
          <dl class="workspace-facts"><div><dt>开仓</dt><dd>${esc(trade.entryTime)} · ${trade.entryQty}手</dd><small>加权价 ${num(trade.entryPrice)}</small></div><div><dt>平仓</dt><dd>${esc(trade.exitTime)} · ${trade.exitQty}手</dd><small>加权价 ${num(trade.exitPrice)}</small></div><div><dt>持仓时长</dt><dd>${esc(trade.holdingLabel)}</dd></div><div><dt>毛盈亏</dt><dd class="${signedClass(trade.grossPnl)}">¥${money(trade.grossPnl)}</dd></div><div><dt>手续费</dt><dd>¥${money(trade.fees)}</dd></div><div><dt>计划风险</dt><dd>${trade.plannedRisk != null ? `¥${money(trade.plannedRisk)}` : "待补充"}</dd></div><div><dt>实际风险</dt><dd>${trade.actualRisk != null ? `¥${money(trade.actualRisk)}` : "待补充"}</dd></div><div><dt>计划 R</dt><dd class="${signedClass(trade.plannedR)}">${trade.plannedR != null ? `${num(trade.plannedR)} R` : "待计算"}</dd><small>净盈亏 ÷ 计划风险</small></div><div><dt>实际 R</dt><dd class="${signedClass(trade.actualR)}">${trade.actualR != null ? `${num(trade.actualR)} R` : "待计算"}</dd><small>净盈亏 ÷ 实际风险</small></div></dl>
        </aside>
        <section class="workspace-panel workspace-review"><div class="review-heading"><div><span>REVIEW NOTES</span><h2>完整复盘</h2></div><p>填写后点击页面顶部“保存复盘”，立即同步到所有设备。</p></div>
      <form id="annotationForm"><div class="edit-grid">
        <label class="edit-field"><span>交易日期</span><input name="date" type="date" value="${esc(trade.date || "")}"></label>
        <label class="edit-field"><span>执行评分（1–5）</span><select name="executionScore">${optionList(["1", "2", "3", "4", "5"], trade.executionScore)}</select></label>
        <label class="edit-field"><span>计划风险（元）</span><input name="plannedRisk" type="number" min="0" step="0.01" value="${trade.plannedRisk ?? ""}"></label>
        <label class="edit-field"><span>实际风险（元）</span><input name="actualRisk" type="number" min="0" step="0.01" value="${trade.actualRisk ?? ""}"></label>
        <label class="edit-field"><span>策略 / 形态</span><select name="setup">${optionList(["突破", "回撤", "反转", "区间", "其他"], trade.setup)}</select></label>
        <label class="edit-field"><span>市场环境</span><select name="marketEnvironment">${optionList(["趋势", "震荡", "突破", "回撤", "其他"], trade.marketEnvironment)}</select></label>
        <label class="edit-field"><span>情绪</span><select name="emotion">${optionList(["平静", "犹豫", "恐惧", "贪婪", "急躁", "其他"], trade.emotion)}</select></label>
        <label class="edit-field"><span>违规标签</span><input name="violationTag" value="${esc(trade.violationTag || "")}" placeholder="如：追单、扛单、无止损"></label>
        <label class="edit-field full"><span>入场理由</span><textarea name="entryReason">${esc(trade.entryReason || "")}</textarea></label>
        <label class="edit-field full"><span>出场理由</span><textarea name="exitReason">${esc(trade.exitReason || "")}</textarea></label>
        <label class="edit-field full"><span>复盘备注</span><textarea name="reviewNotes">${esc(trade.reviewNotes || "")}</textarea></label>
      </div><div class="edit-actions"><button class="ghost-button clear-button" id="clearAnnotation" type="button">清除文字补充</button><span class="save-state" id="saveState">云端持久化</span></div></form>
        <section class="delete-trade-section"><div><h3>不计入统计</h3><p>将整笔交易移入回收站。复盘文字和图片都会保留，之后可以恢复。</p></div><button class="ghost-button delete-trade-button" id="deleteTrade" type="button">移入回收站</button></section></section>
      </div></div>`;
    workspace.hidden = false;
    document.body.classList.add("workspace-open");
    $("app").inert = true;
    $("app").setAttribute("aria-hidden", "true");
    workspace.scrollTop = nextWorkspaceScroll;
    document.querySelector(".workspace-evidence").scrollTop = nextEvidenceScroll;
    document.querySelector(".workspace-review-rail").scrollTop = nextReviewScroll;
    if (wasHidden) $("workspaceBack").focus();
    loadAttachmentPreviews(trade);
    $("previousTrade").onclick = () => previous && openTradeWorkspace(previous, { historyMode: "replace" });
    $("nextTrade").onclick = () => next && openTradeWorkspace(next, { historyMode: "replace" });
    $("attachmentInput")?.addEventListener("change", (event) => uploadAttachmentFiles(event.currentTarget.files, trade));
    $("pasteAttachment")?.addEventListener("click", async () => {
      try { await uploadAttachmentFiles(await readClipboardImages(), trade); }
      catch (error) {
        const message = String(error?.message || "");
        notify(message.startsWith("当前浏览器") ? message : "浏览器未允许读取剪贴板，请直接按 Ctrl+V 粘贴", true);
      }
    });
    document.querySelectorAll("[data-delete-attachment]").forEach((button) => {
      let armed = false;
      button.addEventListener("click", async () => {
        if (!armed) { armed = true; button.textContent = "确认删除"; return; }
        button.disabled = true;
        try {
          await apiFetch(`/api/attachments/${encodeURIComponent(button.dataset.deleteAttachment)}`, { method: "DELETE" });
          await refreshDashboard();
          openTradeWorkspace(dashboard.trades.find((row) => row.tradeId === trade.tradeId), { historyMode: "none", scrollTop: workspace.scrollTop });
          notify("复盘图已删除");
        } catch (error) { button.disabled = false; notify(error.message, true); }
      });
    });
    $("annotationForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = $("workspaceSave"); button.disabled = true; button.textContent = "正在保存…"; $("saveState").textContent = "正在同步…";
      try {
        const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
        await apiFetch(`/api/trades/${encodeURIComponent(trade.tradeId)}`, { method: "PUT", body: JSON.stringify(payload) });
        await refreshDashboard();
        const next = dashboard.trades.find((row) => row.tradeId === trade.tradeId);
        openTradeWorkspace(next, { historyMode: "none", scrollTop: workspace.scrollTop }); notify(`${trade.tradeId} 已保存到云端`);
      } catch (error) { button.disabled = false; button.textContent = "保存复盘"; $("saveState").textContent = "同步失败"; notify(error.message, true); }
    });
    let clearArmed = false;
    $("clearAnnotation").addEventListener("click", async (event) => {
      if (!clearArmed) { clearArmed = true; event.currentTarget.textContent = "再次点击确认清除"; $("saveState").textContent = "此操作会清除全部手动补充"; return; }
      try {
        await apiFetch(`/api/trades/${encodeURIComponent(trade.tradeId)}`, { method: "DELETE" });
        await refreshDashboard(); openTradeWorkspace(dashboard.trades.find((row) => row.tradeId === trade.tradeId), { historyMode: "none", scrollTop: workspace.scrollTop }); notify(`${trade.tradeId} 的补充信息已清除`);
      } catch (error) { notify(error.message, true); }
    });
    let deleteArmed = false;
    $("deleteTrade").addEventListener("click", async (event) => {
      if (!deleteArmed) {
        deleteArmed = true;
        event.currentTarget.textContent = "再次点击，确认移除";
        event.currentTarget.classList.add("armed");
        return;
      }
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = "正在移除…";
      try {
        await apiFetch(`/api/trades/${encodeURIComponent(trade.tradeId)}/record`, { method: "DELETE" });
        await refreshDashboard();
        setTradeRoute("", "replace");
        hideTradeWorkspace({ restoreFocus: false });
        openTrashDrawer();
        notify(`${trade.tradeId} 已移入回收站，统计已更新`);
      } catch (error) { event.currentTarget.disabled = false; event.currentTarget.textContent = "移入回收站"; event.currentTarget.classList.remove("armed"); deleteArmed = false; notify(error.message, true); }
    });
  }

  function closeDrawer() { document.body.classList.remove("drawer-open"); }

  async function refreshDashboard() {
    dashboard = await apiFetch("/api/dashboard");
    render();
  }

  async function exportBackup() {
    try {
      const response = await fetch(`${API}/api/export`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error("导出失败");
      const blob = await response.blob();
      const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `trade-review-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href);
    } catch (error) { notify(error.message, true); }
  }

  async function start() {
    parseLoginToken();
    if (!token) { setAuthVisible(true); return; }
    if (!API || API.includes("__API_BASE__")) { setAuthVisible(true, "云端服务尚未完成配置。"); return; }
    setAuthVisible(false);
    try {
      await renewSession();
      const [session, data] = await Promise.all([apiFetch("/api/session"), apiFetch("/api/dashboard")]);
      dashboard = data;
      $("userAvatar").src = session.user.avatar || "";
      $("userName").textContent = session.user.name || session.user.login;
      [...new Set(dashboard.trades.map((trade) => trade.instrument))].sort().forEach((value) => {
        const option = document.createElement("option"); option.value = option.textContent = value; selects.instrument.append(option);
      });
      render();
      const routedTrade = dashboard.trades.find((trade) => trade.tradeId === tradeRouteId());
      if (routedTrade) openTradeWorkspace(routedTrade, { historyMode: "none" });
      setInterval(() => { renewSession().catch(() => {}); }, RENEW_INTERVAL_MS);
    } catch (error) {
      if (token) { setAuthVisible(true, error.message); }
    }
  }

  $("loginButton").addEventListener("click", login);
  $("logoutButton").addEventListener("click", () => { clearToken(); setAuthVisible(true); });
  $("trashButton").addEventListener("click", openTrashDrawer);
  $("exportButton").addEventListener("click", exportBackup);
  Object.values(selects).forEach((select) => select.addEventListener("change", render));
  $("resetFilters").addEventListener("click", () => { Object.values(selects).forEach((select) => { select.value = ""; }); render(); });
  $("drawerClose").addEventListener("click", closeDrawer);
  $("drawerMask").addEventListener("click", closeDrawer);
  $("workspaceBack").addEventListener("click", requestCloseTradeWorkspace);
  $("imageLightboxClose").addEventListener("click", closeImageLightbox);
  $("imageLightboxPrevious").addEventListener("click", () => switchLightboxItem(-1));
  $("imageLightboxNext").addEventListener("click", () => switchLightboxItem(1));
  $("imageLightboxZoomOut").addEventListener("click", () => setLightboxZoom(lightboxZoom - .2));
  $("imageLightboxZoomReset").addEventListener("click", () => setLightboxZoom(1));
  $("imageLightboxZoomIn").addEventListener("click", () => setLightboxZoom(lightboxZoom + .2));
  $("imageLightboxStage").addEventListener("wheel", (event) => {
    if ($("imageLightbox").hidden) return;
    event.preventDefault();
    setLightboxZoom(lightboxZoom + (event.deltaY < 0 ? .1 : -.1));
  }, { passive: false });
  $("imageLightboxStage").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeImageLightbox(); });
  $("imageLightbox").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeImageLightbox(); });
  document.addEventListener("keydown", (event) => {
    if (!$("imageLightbox").hidden) {
      if (["Escape", "ArrowLeft", "ArrowRight", "+", "=", "-"].includes(event.key)) event.preventDefault();
      if (event.key === "Escape") closeImageLightbox();
      else if (event.key === "ArrowLeft") switchLightboxItem(-1);
      else if (event.key === "ArrowRight") switchLightboxItem(1);
      else if (event.key === "+" || event.key === "=") setLightboxZoom(lightboxZoom + .2);
      else if (event.key === "-") setLightboxZoom(lightboxZoom - .2);
      return;
    }
    if (event.key === "Escape") {
      if (!$("tradeWorkspace").hidden) requestCloseTradeWorkspace();
      else closeDrawer();
    }
  });
  document.addEventListener("paste", (event) => {
    if (!activeTradeId || !document.body.classList.contains("workspace-open")) return;
    const files = clipboardEventImages(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    const trade = dashboard?.trades?.find((row) => row.tradeId === activeTradeId);
    if (trade) uploadAttachmentFiles(files, trade);
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== TOKEN_KEY) return;
    token = event.newValue || "";
    if (!token) setAuthVisible(true);
  });
  window.addEventListener("popstate", () => {
    const trade = dashboard?.trades?.find((row) => row.tradeId === tradeRouteId());
    if (trade) openTradeWorkspace(trade, { historyMode: "none" });
    else hideTradeWorkspace();
  });
  start();
})();
