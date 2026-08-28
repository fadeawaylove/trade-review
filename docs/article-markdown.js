const articleImagePattern = /^article-image:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function openingFence(line) {
  const match = String(line || "").match(/^\s*(`{3,}|~{3,})(.*)$/);
  return match ? { character: match[1][0], length: match[1].length, info: match[2] || "" } : null;
}

function closesFence(line, fence) {
  const match = String(line || "").match(/^\s*(`{3,}|~{3,})\s*$/);
  return Boolean(match && match[1][0] === fence?.character && match[1].length >= fence.length);
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));

function safeLink(value) {
  const href = String(value || "").trim();
  return /^(?:https?:|mailto:|#)/i.test(href) ? href : "";
}

function safeInlineImage(value) {
  const source = String(value || "").trim();
  if (/^blob:(?:https?:\/\/|null\/)[^\s"'<>]+$/i.test(source)) return source;
  if (/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(source)) return source;
  if (/^https:\/\/[^\s"'<>]+$/i.test(source)) return source;
  return "";
}

function decodeHtmlAttribute(value) {
  return String(value ?? "").replace(/&(?:amp|quot|#39|lt|gt);/gi, (entity) => ({
    "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">",
  }[entity.toLowerCase()] || entity));
}

function imageTagAttributes(value) {
  const attributes = new Map();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of String(value || "").matchAll(pattern)) {
    attributes.set(match[1].toLowerCase(), decodeHtmlAttribute(match[2] ?? match[3] ?? match[4] ?? ""));
  }
  return attributes;
}

function safeImageWidth(attributes) {
  const style = attributes.get("style") || "";
  const zoom = style.match(/(?:^|;)\s*zoom\s*:\s*(\d+(?:\.\d+)?)%\s*(?:;|$)/i)?.[1];
  if (zoom && Number(zoom) > 0 && Number(zoom) <= 100) return `${Number(zoom)}%`;
  const width = (attributes.get("width") || "").trim();
  if (/^(?:100|[1-9]?\d)%$/.test(width)) return width;
  if (/^\d{1,4}(?:px)?$/i.test(width)) return `${parseInt(width, 10)}px`;
  return "";
}

function imageFigure(source, alt, { title = "", width = "" } = {}) {
  const safeAlt = alt || "随笔图片";
  return `<figure class="article-image"><img src="${escapeHtml(source)}" alt="${escapeHtml(safeAlt)}"${title ? ` title="${escapeHtml(title)}"` : ""}${width ? ` style="width:${escapeHtml(width)}"` : ""}><figcaption>${escapeHtml(safeAlt)}</figcaption></figure>`;
}

function footnoteSlug(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "note";
}

function inlineMarkdown(value, context = {}) {
  const slots = [];
  const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let text = String(value ?? "");
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => hold(`<code>${escapeHtml(code)}</code>`));
  if (context.footnotes && context.references) {
    text = text.replace(/\[\^([^\]\n]+)\]/g, (match, rawLabel) => {
      const label = String(rawLabel || "").trim();
      if (!context.footnotes.has(label)) return match;
      let reference = context.references.find((item) => item.label === label);
      if (!reference) {
        reference = { label, index: context.references.length + 1, slug: footnoteSlug(label), uses: 0 };
        context.references.push(reference);
      }
      reference.uses += 1;
      const suffix = reference.uses > 1 ? `-${reference.uses}` : "";
      return hold(`<sup class="article-footnote-ref" id="footnote-ref-${escapeHtml(reference.slug)}${suffix}"><a href="#footnote-${escapeHtml(reference.slug)}" aria-label="查看脚注 ${reference.index}">${reference.index}</a></sup>`);
    });
  }
  text = text.replace(/<img\b((?:"[^"]*"|'[^']*'|[^'">])*)\/?>/gi, (match, rawAttributes) => {
    const attributes = imageTagAttributes(rawAttributes);
    const source = safeInlineImage(attributes.get("src"));
    if (!source) return match;
    return hold(imageFigure(source, attributes.get("alt"), {
      title: attributes.get("title"),
      width: safeImageWidth(attributes),
    }));
  });
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt, source) => {
    const privateImage = source.match(articleImagePattern);
    if (privateImage) {
      return hold(`<figure class="article-image" data-article-image-id="${privateImage[1]}"><div class="article-image-state">正在读取私有图片…</div><figcaption>${escapeHtml(alt || "随笔图片")}</figcaption></figure>`);
    }
    const inlineImage = safeInlineImage(source);
    if (inlineImage) {
      return hold(imageFigure(inlineImage, alt));
    }
    const href = safeLink(source);
    return href ? hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(alt || "外部图片")}</a>`) : escapeHtml(alt || source);
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label, source) => {
    const trade = source.match(/^trade:(TR-\d{4,})$/i);
    if (trade) {
      const tradeId = trade[1].toUpperCase();
      return hold(`<button class="article-trade-reference" type="button" data-article-trade-id="${tradeId}">${escapeHtml(label)}</button>`);
    }
    const href = safeLink(source);
    return href ? hold(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`) : escapeHtml(label);
  });
  text = escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => slots[Number(index)] || "");
}

function isTableSeparator(line) {
  const cells = line.trim().replace(/^\||\|$/g, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

export function renderArticleMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  const footnotes = new Map();
  const references = [];
  let definitionFence = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (definitionFence) {
      if (closesFence(lines[lineIndex], definitionFence)) definitionFence = null;
      continue;
    }
    const fence = openingFence(lines[lineIndex]);
    if (fence) {
      definitionFence = fence;
      continue;
    }
    const definition = lines[lineIndex].match(/^\s{0,3}\[\^([^\]]+)\]:\s*(.*)$/);
    if (!definition) continue;
    const content = [definition[2]];
    lines[lineIndex] = "";
    while (lineIndex + 1 < lines.length) {
      const continuation = lines[lineIndex + 1].match(/^\s{2,}(.+)$/);
      if (!continuation) break;
      content.push(continuation[1]);
      lineIndex += 1;
      lines[lineIndex] = "";
    }
    footnotes.set(definition[1].trim(), content.join("\n"));
  }
  const inlineContext = { footnotes, references };
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      let blankLineCount = 0;
      while (index < lines.length && !lines[index].trim()) {
        blankLineCount += 1;
        index += 1;
      }
      const extraBlankLines = Math.max(0, blankLineCount - 1);
      if (extraBlankLines) blocks.push(`<div class="article-blank-lines" aria-hidden="true">${"<span></span>".repeat(extraBlankLines)}</div>`);
      continue;
    }

    const fence = openingFence(line);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !closesFence(lines[index], fence)) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      const language = fence.info.trim().split(/\s+/, 1)[0].replace(/[^a-z0-9_-]/gi, "");
      blocks.push(`<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${inlineMarkdown(heading[2].trim(), inlineContext)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push("<hr>");
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && line.includes("|") && isTableSeparator(lines[index + 1])) {
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) rows.push(tableCells(lines[index++]));
      blocks.push(`<div class="article-table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${inlineMarkdown(cell, inlineContext)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_header, cellIndex) => `<td>${inlineMarkdown(row[cellIndex] || "", inlineContext)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const tag = unordered ? "ul" : "ol";
      const items = [];
      const pattern = unordered ? /^\s*[-+*]\s+(.+)$/ : /^\s*\d+[.)]\s+(.+)$/;
      let hasTasks = false;
      while (index < lines.length) {
        const item = lines[index].match(pattern);
        if (!item) break;
        const task = unordered ? item[1].match(/^\[([ xX])\]\s+(.+)$/) : null;
        if (task) {
          hasTasks = true;
          const checked = task[1].toLowerCase() === "x";
          items.push(`<li class="article-task-item"><input type="checkbox" disabled${checked ? " checked" : ""} aria-label="${checked ? "已完成" : "未完成"}"><span>${inlineMarkdown(task[2], inlineContext)}</span></li>`);
        } else {
          items.push(`<li>${inlineMarkdown(item[1], inlineContext)}</li>`);
        }
        index += 1;
      }
      blocks.push(`<${tag}${hasTasks ? ' class="article-task-list"' : ""}>${items.join("")}</${tag}>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote = [];
      while (index < lines.length) {
        const part = lines[index].match(/^\s*>\s?(.*)$/);
        if (!part) break;
        quote.push(part[1]);
        index += 1;
      }
      blocks.push(`<blockquote><p>${inlineMarkdown(quote.join("\n"), inlineContext).replace(/\n/g, "<br>")}</p></blockquote>`);
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim()) {
      if (/^(?:#{1,6}\s+|\s*(?:`{3,}|~{3,})|\s*[-+*]\s+|\s*\d+[.)]\s+|\s*>)/.test(lines[index])) break;
      if (index + 1 < lines.length && lines[index].includes("|") && isTableSeparator(lines[index + 1])) break;
      paragraph.push(lines[index++]);
    }
    blocks.push(`<p>${inlineMarkdown(paragraph.join("\n"), inlineContext).replace(/\n/g, "<br>")}</p>`);
  }

  if (references.length) {
    blocks.push(`<section class="article-footnotes" aria-label="脚注"><hr><ol>${references.map((reference) => `<li id="footnote-${escapeHtml(reference.slug)}"><span>${inlineMarkdown(footnotes.get(reference.label) || "")}</span> <a class="article-footnote-back" href="#footnote-ref-${escapeHtml(reference.slug)}" aria-label="返回正文脚注 ${reference.index}">↩</a></li>`).join("")}</ol></section>`);
  }

  return blocks.join("\n");
}
