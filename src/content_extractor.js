/**
 * EchoArchive DeepSeek Web Extractor (v2)
 *
 * Refactored for the current chat.deepseek.com virtual-list DOM architecture:
 * - Anchors every row to `.ds-message` to isolate content from sibling action bars & branch paginators
 * - Restores `.md-code-block` fences + banner language labels while stripping copy/download controls & decorative SVGs
 * - Strips web-search header/footer cards and `<a>`-wrapped `.ds-markdown-cite` badges without leaking bare URLs
 * - Preserves KaTeX TeX source, GFM tables, nested lists, and image-only/mixed user turns
 * - Executes long-chat scroll collection as an in-tab cancellable async job with a non-intrusive Shadow DOM HUD
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.__ECHO_ARCHIVE_EXTRACTOR__ = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_SELECTORS = {
    row: "[data-virtual-list-item-key], .ds-message",
    messageRoot: ".ds-message",
    assistantMarker: ".ds-markdown, .ds-assistant-message-main-content, .ds-think-content",
    markdown: ".ds-markdown",
    think: ".ds-think-content",
    userText: ".ds-collapsible-text, .fbb737a4 .ds-collapsible-text, .fbb737a4",
    cite: ".ds-markdown-cite",
  };

  const JOB_KEY = "__ECHO_ARCHIVE_JOB__";
  const HUD_HOST_ID = "echo-archive-hud-host";
  const THINK_TOGGLE_RE = /^(?:已深度思考|深度思考|思考过程|Thought for)/i;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function cleanText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function hashFingerprint(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function formatCodeFence(lang, codeText) {
    const cleanCode = String(codeText || "").replace(/\n+$/, "");
    let fence = "```";
    while (cleanCode.includes(fence)) {
      fence += "`";
    }
    return `\n\n${fence}${lang || ""}\n${cleanCode}\n${fence}\n\n`;
  }

  function formatInlineCode(text) {
    const raw = String(text || "").trim();
    if (!raw) return "";
    let ticks = "`";
    while (raw.includes(ticks)) {
      ticks += "`";
    }
    const pad = raw.startsWith("`") || raw.endsWith("`") ? " " : "";
    return `${ticks}${pad}${raw}${pad}${ticks}`;
  }

  function detectLanguageFromCodeEl(codeEl) {
    if (!codeEl || !codeEl.className) return "";
    const match = String(codeEl.className).match(/language-([a-zA-Z0-9_+#.-]+)/);
    return match ? match[1] : "";
  }

  function isInsideActionButton(node, stopEl) {
    let cur = node;
    while (cur && cur !== stopEl) {
      const role = typeof cur.getAttribute === "function" ? cur.getAttribute("role") : "";
      const isBtn =
        role === "button" ||
        (typeof cur.classList !== "undefined" && cur.classList.contains("ds-button"));
      if (isBtn) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function detectLanguageFromBanner(bannerEl) {
    if (!bannerEl || typeof bannerEl.querySelectorAll !== "function") return "";
    const spans = Array.from(bannerEl.querySelectorAll("span"));
    for (const span of spans) {
      if (isInsideActionButton(span, bannerEl)) continue;
      const text = cleanText(span.textContent || "");
      if (!text || /^(复制|下载|运行|预览|copy|download|run|preview)$/i.test(text)) continue;
      if (/^[a-zA-Z0-9_+#.-]{1,32}$/.test(text)) {
        return text;
      }
    }
    return "";
  }

  function convertTableToMarkdown(tableEl) {
    const rows = Array.from(tableEl.querySelectorAll("tr"));
    if (!rows.length) return "";
    const matrix = rows.map((tr) =>
      Array.from(tr.querySelectorAll("th, td")).map((cell) =>
        cleanText(cell.textContent || "").replace(/\|/g, "\\|").replace(/\n+/g, " ")
      )
    );
    const colCount = Math.max(...matrix.map((r) => r.length));
    if (!colCount) return "";
    const normalized = matrix.map((r) => {
      while (r.length < colCount) r.push("");
      return `| ${r.join(" | ")} |`;
    });
    const separator = `| ${Array(colCount).fill("---").join(" | ")} |`;
    if (normalized.length === 1) {
      return `${normalized[0]}\n${separator}`;
    }
    return [normalized[0], separator, ...normalized.slice(1)].join("\n");
  }

  /**
   * Convert a rendered DeepSeek Markdown subtree back to clean Markdown.
   */
  function domToMarkdown(rootEl, citeSelector = DEFAULT_SELECTORS.cite) {
    if (!rootEl) return "";

    function walk(node, inPre = false) {
      if (!node) return "";
      if (node.nodeType === 3) {
        return node.nodeValue || "";
      }
      if (node.nodeType !== 1) return "";

      const tag = (node.tagName || "").toLowerCase();
      if (tag === "svg") return "";
      if (citeSelector && typeof node.matches === "function" && node.matches(citeSelector)) {
        return "";
      }

      if (
        typeof node.classList !== "undefined" &&
        (node.classList.contains("md-code-block-banner-wrap") ||
          node.classList.contains("md-code-block-banner"))
      ) {
        return "";
      }

      if (typeof node.classList !== "undefined" && node.classList.contains("md-code-block")) {
        const preEl = typeof node.querySelector === "function" ? node.querySelector("pre") : null;
        if (preEl) {
          const codeEl =
            typeof preEl.querySelector === "function" ? preEl.querySelector("code") : null;
          const bannerEl =
            typeof node.querySelector === "function"
              ? node.querySelector(".md-code-block-banner")
              : null;
          const lang = detectLanguageFromCodeEl(codeEl) || detectLanguageFromBanner(bannerEl);
          const codeText = (codeEl ? codeEl.textContent : preEl.textContent) || "";
          return formatCodeFence(lang, codeText);
        }
      }

      // Preserve KaTeX raw TeX source when present.
      if (
        typeof node.classList !== "undefined" &&
        (node.classList.contains("katex-display") || node.classList.contains("katex"))
      ) {
        const ann =
          typeof node.querySelector === "function"
            ? node.querySelector('annotation[encoding="application/x-tex"]') ||
              node.querySelector("annotation")
            : null;
        if (ann && ann.textContent) {
          const tex = ann.textContent.trim();
          return node.classList.contains("katex-display") ? `\n$$\n${tex}\n$$\n` : `$${tex}$`;
        }
      }

      if (tag === "br") return "\n";
      if (tag === "hr") return "\n\n---\n\n";

      if (tag === "pre") {
        const codeEl = typeof node.querySelector === "function" ? node.querySelector("code") : null;
        const lang = detectLanguageFromCodeEl(codeEl);
        const codeText = (codeEl ? codeEl.textContent : node.textContent) || "";
        return formatCodeFence(lang, codeText);
      }

      if (tag === "code" && !inPre) {
        return formatInlineCode(node.textContent || "");
      }

      if (tag === "table") {
        return `\n\n${convertTableToMarkdown(node)}\n\n`;
      }

      const inner = () =>
        Array.from(node.childNodes)
          .map((child) => walk(child, inPre || tag === "pre"))
          .join("");

      if (/^h[1-6]$/.test(tag)) {
        const level = "#".repeat(Number(tag.slice(1)));
        return `\n\n${level} ${cleanText(inner())}\n\n`;
      }
      if (tag === "strong" || tag === "b") {
        const body = inner().trim();
        return body ? `**${body}**` : "";
      }
      if (tag === "em" || tag === "i") {
        const body = inner().trim();
        return body ? `*${body}*` : "";
      }
      if (tag === "del" || tag === "s") {
        const body = inner().trim();
        return body ? `~~${body}~~` : "";
      }
      if (tag === "a") {
        const href = typeof node.getAttribute === "function" ? node.getAttribute("href") || "" : "";
        const label = inner().trim();
        if (
          !label &&
          citeSelector &&
          typeof node.querySelector === "function" &&
          node.querySelector(citeSelector)
        ) {
          return "";
        }
        return href ? `[${label || href}](${href})` : label;
      }
      if (tag === "blockquote") {
        const lines = cleanText(inner())
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"));
        return `\n\n${lines.join("\n")}\n\n`;
      }
      if (tag === "ul" || tag === "ol") {
        const items = Array.from(node.children)
          .filter((c) => (c.tagName || "").toLowerCase() === "li")
          .map((li, idx) => {
            const prefix = tag === "ol" ? `${idx + 1}. ` : "- ";
            const body = cleanText(
              Array.from(li.childNodes)
                .map((child) => walk(child, false))
                .join("")
            )
              .replace(/\n{2,}/g, "\n")
              .replace(/\n/g, "\n  ");
            return `${prefix}${body}`;
          });
        return `\n\n${items.join("\n")}\n\n`;
      }
      if (tag === "p" || tag === "div") {
        const content = inner();
        if (!content.trim()) return "";
        return tag === "p" ? `\n\n${content.trim()}\n\n` : `${content}\n`;
      }

      return inner();
    }

    return cleanText(walk(rootEl, false));
  }

  function findRowElements(doc, selectors) {
    const virtualItems = Array.from(doc.querySelectorAll("[data-virtual-list-item-key]"));
    if (virtualItems.length > 0) {
      return { strategy: "virtual-list-key", elements: virtualItems };
    }

    const customRows = selectors.row ? Array.from(doc.querySelectorAll(selectors.row)) : [];
    const topLevelRows = customRows.filter(
      (el) => !customRows.some((other) => other !== el && other.contains(el))
    );
    if (topLevelRows.length > 0) {
      return { strategy: "message-row", elements: topLevelRows };
    }

    const mdNodes = Array.from(doc.querySelectorAll(selectors.markdown || ".ds-markdown"));
    if (mdNodes.length > 0) {
      const collected = [];
      for (const md of mdNodes) {
        const row = (typeof md.closest === "function" && md.closest("div[class]")) || md.parentElement;
        if (row && !collected.includes(row)) {
          if (row.previousElementSibling && !collected.includes(row.previousElementSibling)) {
            collected.push(row.previousElementSibling);
          }
          collected.push(row);
        }
      }
      return { strategy: "markdown-anchor-fallback", elements: collected };
    }

    return { strategy: "none", elements: [] };
  }

  function resolveMessageRoot(rowEl, selectors) {
    const rootSel = selectors.messageRoot || ".ds-message";
    if (typeof rowEl.matches === "function" && rowEl.matches(rootSel)) {
      return rowEl;
    }
    if (typeof rowEl.querySelector === "function") {
      return rowEl.querySelector(rootSel) || rowEl;
    }
    return rowEl;
  }

  function extractRowMessage(rowEl, indexHint, selectors) {
    const explicitKey =
      (typeof rowEl.getAttribute === "function" && rowEl.getAttribute("data-virtual-list-item-key")) ||
      "";
    const msgRoot = resolveMessageRoot(rowEl, selectors);

    const mdEl = msgRoot.querySelector(selectors.markdown);
    const thinkEl = msgRoot.querySelector(selectors.think);
    const isAssistant = Boolean(
      mdEl ||
        thinkEl ||
        (selectors.assistantMarker && msgRoot.querySelector(selectors.assistantMarker))
    );

    if (isAssistant) {
      const thinking = thinkEl ? domToMarkdown(thinkEl, selectors.cite) : "";
      let content = "";
      if (mdEl) {
        content = domToMarkdown(mdEl, selectors.cite);
      } else {
        const clone = msgRoot.cloneNode(true);
        const cloneThink = clone.querySelector(selectors.think);
        if (cloneThink) cloneThink.remove();
        content = domToMarkdown(clone, selectors.cite);
      }
      if (!content && !thinking) return null;
      const itemKey =
        explicitKey ||
        `fp_assistant_${hashFingerprint(`${content}\u0000${thinking}`)}_${indexHint > 0 ? "r" : "0"}`;
      return {
        key: itemKey,
        role: "assistant",
        content,
        thinking,
        hasImages: false,
        codeBlocks: typeof msgRoot.querySelectorAll === "function"
          ? msgRoot.querySelectorAll("pre").length
          : 0,
      };
    }

    const userNode = (selectors.userText && msgRoot.querySelector(selectors.userText)) || msgRoot;
    const textContent = cleanText(userNode.innerText || userNode.textContent || "");
    const images =
      typeof msgRoot.querySelectorAll === "function"
        ? Array.from(msgRoot.querySelectorAll("img"))
        : [];
    const imageMarkers = images.map((img) => {
      const alt = cleanText(
        (typeof img.getAttribute === "function" ? img.getAttribute("alt") : img.alt) || ""
      );
      return alt ? `[附件图片: ${alt}]` : "[附件图片]";
    });
    const content = cleanText([...imageMarkers, textContent].filter(Boolean).join("\n\n"));
    if (!content) return null;
    const itemKey = explicitKey || `fp_user_${hashFingerprint(content)}`;
    return {
      key: itemKey,
      role: "user",
      content,
      thinking: "",
      hasImages: images.length > 0,
      codeBlocks: 0,
    };
  }

  function extractSnapshot(doc, customSelectors = {}) {
    const selectors = { ...DEFAULT_SELECTORS, ...customSelectors };
    const { strategy, elements } = findRowElements(doc, selectors);
    const messages = [];
    for (let i = 0; i < elements.length; i += 1) {
      const msg = extractRowMessage(elements[i], i + 1, selectors);
      if (msg) messages.push(msg);
    }
    return { strategy, messages };
  }

  function findScrollContainer(doc, seedEl) {
    if (typeof doc.querySelector === "function") {
      const dsScroller = doc.querySelector(".ds-virtual-list.ds-scroll-area, .ds-scroll-area");
      if (dsScroller && dsScroller.scrollHeight > dsScroller.clientHeight + 24) {
        return dsScroller;
      }
    }
    let cursor = seedEl ? seedEl.parentElement : doc.body;
    while (cursor && cursor !== doc.documentElement) {
      const style = typeof getComputedStyle === "function" ? getComputedStyle(cursor) : null;
      const canScroll =
        cursor.scrollHeight > cursor.clientHeight + 24 &&
        (!style || /(auto|scroll|overlay)/.test(style.overflowY || ""));
      if (canScroll) return cursor;
      cursor = cursor.parentElement;
    }
    return doc.scrollingElement || doc.documentElement || doc.body;
  }

  function tryExpandCollapsedThinking(doc, selectors) {
    if (typeof doc.querySelectorAll !== "function") return 0;
    let clicked = 0;
    const rows = findRowElements(doc, selectors).elements;
    for (const row of rows) {
      const msgRoot = resolveMessageRoot(row, selectors);
      if (msgRoot.querySelector(selectors.think)) continue;
      const mdEl = msgRoot.querySelector(selectors.markdown);
      const interactive = Array.from(msgRoot.querySelectorAll('[role="button"], button'));
      const fallback = Array.from(msgRoot.querySelectorAll("div, span"));
      const candidates = [...interactive, ...fallback];
      for (const el of candidates) {
        if (mdEl && (mdEl === el || mdEl.contains(el) || el.contains(mdEl))) continue;
        if (typeof el.getAttribute === "function" && el.getAttribute("data-echo-expanded") === "1") {
          continue;
        }
        const raw = cleanText(el.innerText || el.textContent || "");
        if (raw && raw.length <= 42 && THINK_TOGGLE_RE.test(raw) && typeof el.click === "function") {
          if (typeof el.setAttribute === "function") el.setAttribute("data-echo-expanded", "1");
          el.click();
          clicked += 1;
          break;
        }
      }
    }
    return clicked;
  }

  function getScrollMetrics(scroller) {
    if (!scroller) return { ratio: 1, height: 0, top: 0 };
    const maxScroll = Math.max(1, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0));
    const ratio = Math.min(1, Math.max(0, (scroller.scrollTop || 0) / maxScroll));
    return {
      ratio,
      height: scroller.scrollHeight || 0,
      top: scroller.scrollTop || 0,
    };
  }

  /**
   * Scroll to the very top to trigger lazy history loading, then sweep downward
   * while merging items keyed by virtual-list key so unmounted rows are never lost.
   */
  async function scrollAndCollectAll(doc, customSelectors = {}, options = {}) {
    const selectors = { ...DEFAULT_SELECTORS, ...customSelectors };
    const maxTopPasses = options.maxTopPasses || 80;
    const stepDelayMs = options.stepDelayMs || 360;
    const expandThinking = options.expandThinking !== false;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
    const shouldCancel = typeof options.shouldCancel === "function" ? options.shouldCancel : () => false;

    const initial = findRowElements(doc, selectors);
    const scroller = findScrollContainer(doc, initial.elements[0] || doc.body);

    // 1. Scroll up until history stops prepending.
    let lastHeight = -1;
    let lastFirstKey = "";
    let stableCount = 0;

    for (let i = 0; i < maxTopPasses; i += 1) {
      if (shouldCancel()) {
        throw new Error("EXTRACTION_CANCELLED");
      }
      scroller.scrollTop = 0;
      await sleep(stepDelayMs);
      const snap = extractSnapshot(doc, selectors);
      const firstKey = snap.messages[0] ? snap.messages[0].key : "";
      onProgress({
        phase: "top_seek",
        pass: i + 1,
        collectedCount: snap.messages.length,
        thinkingCount: snap.messages.filter((m) => Boolean(m.thinking)).length,
        imageCount: snap.messages.filter((m) => m.hasImages).length,
        scrollRatio: 0,
        strategy: snap.strategy,
      });

      if (scroller.scrollHeight === lastHeight && firstKey === lastFirstKey) {
        stableCount += 1;
        if (stableCount >= 2) break;
      } else {
        stableCount = 0;
      }
      lastHeight = scroller.scrollHeight;
      lastFirstKey = firstKey;
    }

    // 2. Sweep top-to-bottom collecting into an ordered Map to survive DOM virtualization.
    const orderedMap = new Map();
    let strategyUsed = initial.strategy;

    async function mergeVisible() {
      if (expandThinking) {
        const expanded = tryExpandCollapsedThinking(doc, selectors);
        if (expanded > 0) {
          await sleep(140);
        }
      }
      const snap = extractSnapshot(doc, selectors);
      if (snap.strategy !== "none") strategyUsed = snap.strategy;
      for (const msg of snap.messages) {
        orderedMap.set(msg.key, msg);
      }
      const metrics = getScrollMetrics(scroller);
      const values = Array.from(orderedMap.values());
      onProgress({
        phase: "sweep_collect",
        pass: orderedMap.size,
        collectedCount: values.length,
        thinkingCount: values.filter((m) => Boolean(m.thinking)).length,
        imageCount: values.filter((m) => m.hasImages).length,
        scrollRatio: metrics.ratio,
        strategy: strategyUsed,
      });
    }

    await mergeVisible();
    const stepSize = Math.max(300, Math.floor((scroller.clientHeight || 600) * 0.75));
    const maxDownPasses =
      options.maxDownPasses ||
      Math.max(600, Math.ceil((scroller.scrollHeight || 12000) / stepSize) * 4);
    let guard = 0;
    let stallCount = 0;

    while (
      scroller.scrollTop + (scroller.clientHeight || 600) < scroller.scrollHeight - 10 &&
      guard < maxDownPasses
    ) {
      if (shouldCancel()) {
        throw new Error("EXTRACTION_CANCELLED");
      }
      const prevTop = scroller.scrollTop;
      const prevHeight = scroller.scrollHeight;
      scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + stepSize);
      await sleep(Math.min(260, stepDelayMs));
      await mergeVisible();
      if (scroller.scrollTop === prevTop && scroller.scrollHeight === prevHeight) {
        stallCount += 1;
        if (stallCount >= 3) break;
      } else {
        stallCount = 0;
      }
      guard += 1;
    }
    await mergeVisible();

    return {
      strategy: strategyUsed,
      messages: Array.from(orderedMap.values()).map(({ role, content, thinking }) => ({
        role,
        content,
        thinking,
      })),
    };
  }

  /* ---------------------- On-Page Shadow DOM Progress Capsule ---------------------- */

  function ensureHud() {
    if (
      typeof document === "undefined" ||
      !document.body ||
      typeof document.getElementById !== "function"
    ) {
      return null;
    }
    let host = document.getElementById(HUD_HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HUD_HOST_ID;
      host.style.cssText =
        "position:fixed;right:20px;bottom:20px;z-index:2147483646;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;";
      document.body.appendChild(host);
    }
    let shadow = host.shadowRoot;
    if (!shadow && typeof host.attachShadow === "function") {
      shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `
        <style>
          .cap {
            width: 280px;
            background: #121212;
            color: #f5f5f5;
            border: 1px solid #2e2e2e;
            border-radius: 8px;
            padding: 11px 13px;
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
            font-size: 12px;
            line-height: 1.45;
          }
          .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
          .brand { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; letter-spacing: 0.08em; color: #888888; text-transform: uppercase; }
          .close {
            background: transparent; border: none; color: #888888; cursor: pointer;
            font-size: 12px; padding: 2px 6px; border-radius: 4px;
          }
          .close:hover { color: #f5f5f5; background: #242424; }
          .msg { color: #f5f5f5; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
          .track { height: 3px; background: #242424; overflow: hidden; }
          .fill { height: 100%; width: 12%; background: #f5f5f5; transition: width 0.2s ease; }
        </style>
        <div class="cap">
          <div class="top">
            <span class="brand">ECHOARCHIVE · LOCAL</span>
            <button class="close" id="hudAction" type="button">中止</button>
          </div>
          <div class="msg" id="hudMsg">准备扫描…</div>
          <div class="track"><div class="fill" id="hudFill"></div></div>
        </div>
      `;
    }
    return { host, shadow };
  }

  function updateHud(text, pct, buttonText = "中止", onButtonClick = null) {
    const hud = ensureHud();
    if (!hud || !hud.shadow) return;
    const msgEl = hud.shadow.getElementById("hudMsg");
    const fillEl = hud.shadow.getElementById("hudFill");
    const btnEl = hud.shadow.getElementById("hudAction");
    if (msgEl) msgEl.textContent = text;
    if (fillEl) fillEl.style.width = `${Math.max(5, Math.min(100, Math.round(pct)))}%`;
    if (btnEl) {
      btnEl.textContent = buttonText;
      btnEl.onclick = onButtonClick;
    }
  }

  function removeHud() {
    if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
    const host = document.getElementById(HUD_HOST_ID);
    if (host) host.remove();
  }

  /* ---------------------- Page Entrypoints ---------------------- */

  function getTitle() {
    return (document.title || "DeepSeek 对话").replace(/\s*-\s*DeepSeek.*$/i, "").trim();
  }

  /* ---------------------- Page Health ---------------------- */

  // 对话外壳锚点：与抽取选择器解耦、固定不随自定义选择器变化，用来区分
  // “确实没有对话”与“页面在、但选择器已失效（DeepSeek 改版）”。
  const HEALTH_ANCHORS = {
    virtualListItems: "[data-virtual-list-item-key]",
    messageRoots: ".ds-message",
    markdown: ".ds-markdown",
    scrollAreas: ".ds-scroll-area",
    virtualLists: ".ds-virtual-list",
  };
  // 强锚点直接对应消息节点；弱锚点只是滚动/列表外壳（侧栏等也可能复用）。
  const HEALTH_STRONG_ANCHORS = ["virtualListItems", "messageRoots", "markdown"];
  const HEALTH_SHELL_ANCHORS = ["scrollAreas", "virtualLists"];
  const HEALTH_BULKY_SCROLL_HEIGHT = 2000;
  const HEALTH_BULKY_DOM_NODES = 1500;
  const CHAT_SESSION_PATH_RE = /\/s\/[^/?#]+/;

  function countMatches(doc, selector) {
    if (!doc || typeof doc.querySelectorAll !== "function") return 0;
    try {
      return doc.querySelectorAll(selector).length || 0;
    } catch (_) {
      return 0;
    }
  }

  function collectHealthSignals(doc, extra = {}) {
    const anchors = {};
    for (const [key, selector] of Object.entries(HEALTH_ANCHORS)) {
      anchors[key] = countMatches(doc, selector);
    }
    return {
      anchors,
      domNodes: countMatches(doc, "*"),
      scrollHeight: extra.scrollHeight || 0,
      isDeepSeek: Boolean(extra.isDeepSeek),
      isChatSession: Boolean(extra.isChatSession),
    };
  }

  /**
   * 纯函数：按抽取条数 + 外壳信号给出页面健康度。
   *  - ok：抽到了消息。
   *  - selector_drift：0 条，但页面明显是对话页（存在消息级强锚点；
   *    或处于 DeepSeek 会话 URL 且存在滚动/列表外壳，或页面体量可观）。
   *  - empty：0 条，且没有上述迹象。
   */
  function assessPageHealth(count, signals) {
    if (count > 0) return "ok";
    const s = signals || {};
    const anchors = s.anchors || {};
    const sum = (keys) => keys.reduce((acc, k) => acc + (anchors[k] || 0), 0);
    if (sum(HEALTH_STRONG_ANCHORS) > 0) return "selector_drift";
    if (s.isDeepSeek && s.isChatSession) {
      if (sum(HEALTH_SHELL_ANCHORS) > 0) return "selector_drift";
      if ((s.scrollHeight || 0) >= HEALTH_BULKY_SCROLL_HEIGHT) return "selector_drift";
      if ((s.domNodes || 0) >= HEALTH_BULKY_DOM_NODES) return "selector_drift";
    }
    return "empty";
  }

  function inspectPage(selectors = {}, options = {}) {
    const snap = extractSnapshot(document, selectors);
    const scroller = findScrollContainer(document, findRowElements(document, { ...DEFAULT_SELECTORS, ...selectors }).elements[0] || document.body);
    const scrollMetrics = getScrollMetrics(scroller);
    const job = globalThis[JOB_KEY];

    let selectorProbe = null;
    if (options.probeSelectors) {
      const merged = { ...DEFAULT_SELECTORS, ...selectors };
      selectorProbe = {
        rowMatches: document.querySelectorAll(merged.row).length,
        messageRootMatches: document.querySelectorAll(merged.messageRoot).length,
        markdownMatches: document.querySelectorAll(merged.markdown).length,
        thinkMatches: document.querySelectorAll(merged.think).length,
        userTextMatches: document.querySelectorAll(merged.userText).length,
      };
    }

    const isDeepSeek = /(^|\.)deepseek\.com$/i.test(location.hostname);
    const healthSignals = collectHealthSignals(document, {
      scrollHeight: scrollMetrics.height,
      isDeepSeek,
      isChatSession: CHAT_SESSION_PATH_RE.test(location.pathname || location.href || ""),
    });

    return {
      ok: true,
      mode: "inspect",
      title: getTitle(),
      url: location.href,
      isDeepSeek,
      strategy: snap.strategy,
      count: snap.messages.length,
      health: assessPageHealth(snap.messages.length, healthSignals),
      healthSignals,
      userCount: snap.messages.filter((m) => m.role === "user").length,
      assistantCount: snap.messages.filter((m) => m.role === "assistant").length,
      thinkingCount: snap.messages.filter((m) => Boolean(m.thinking)).length,
      imageCount: snap.messages.filter((m) => m.hasImages).length,
      codeBlockCount: snap.messages.reduce((acc, m) => acc + (m.codeBlocks || 0), 0),
      scrollHeight: scrollMetrics.height,
      scrollRatio: scrollMetrics.ratio,
      firstPreview: snap.messages[0] ? snap.messages[0].content.slice(0, 96) : "",
      lastPreview: snap.messages.length
        ? snap.messages[snap.messages.length - 1].content.slice(0, 96)
        : "",
      selectorProbe,
      cachedJob: job
        ? {
            jobId: job.jobId,
            status: job.status,
            phase: job.phase,
            collectedCount: job.collectedCount,
            thinkingCount: job.thinkingCount,
          }
        : null,
    };
  }

  function startBackgroundJob(options = {}) {
    const selectors = options.selectors || {};
    const jobId = `job_${Date.now().toString(36)}`;
    const job = {
      jobId,
      status: "running",
      phase: "init",
      pass: 0,
      collectedCount: 0,
      thinkingCount: 0,
      imageCount: 0,
      scrollRatio: 0,
      strategy: "none",
      cancelled: false,
      error: null,
      result: null,
    };
    globalThis[JOB_KEY] = job;

    const cancelHandler = () => {
      job.cancelled = true;
      job.status = "cancelled";
      removeHud();
    };

    if (options.showHud !== false) {
      updateHud("准备回溯历史对话…", 8, "中止", cancelHandler);
    }

    (async () => {
      try {
        let collected;
        if (options.autoScroll === false) {
          const snap = extractSnapshot(document, selectors);
          collected = {
            strategy: snap.strategy,
            messages: snap.messages.map(({ role, content, thinking }) => ({
              role,
              content,
              thinking,
            })),
          };
          job.collectedCount = collected.messages.length;
          job.thinkingCount = collected.messages.filter((m) => Boolean(m.thinking)).length;
          job.strategy = collected.strategy;
          job.scrollRatio = 1;
        } else {
          collected = await scrollAndCollectAll(document, selectors, {
            ...options,
            shouldCancel: () => job.cancelled,
            onProgress: (p) => {
              Object.assign(job, p);
              if (options.showHud !== false) {
                const label =
                  p.phase === "top_seek"
                    ? `回溯顶部历史 · 第 ${p.pass} 步（当前可见 ${p.collectedCount} 条）`
                    : `扫描完整脉络 · 已采集 ${p.collectedCount} 条（${Math.round(
                        p.scrollRatio * 100
                      )}%）`;
                const pct = p.phase === "top_seek" ? Math.min(25, 8 + p.pass * 3) : 25 + p.scrollRatio * 70;
                updateHud(label, pct, "中止", cancelHandler);
              }
            },
          });
        }

        if (job.cancelled) return;
        job.phase = "finalize";
        job.status = "done";
        job.collectedCount = collected.messages.length;
        job.thinkingCount = collected.messages.filter((m) => Boolean(m.thinking)).length;
        job.scrollRatio = 1;
        job.result = {
          ok: true,
          mode: "extract",
          title: getTitle(),
          url: location.href,
          strategy: collected.strategy,
          exported_at: new Date().toISOString(),
          messages: collected.messages,
        };
        if (options.showHud !== false) {
          updateHud(
            `采集就绪：共 ${job.collectedCount} 条消息。请点击扩展图标完成本地加密下载。`,
            100,
            "关闭",
            removeHud
          );
        }
      } catch (err) {
        if (job.cancelled || (err && err.message === "EXTRACTION_CANCELLED")) {
          job.status = "cancelled";
          removeHud();
          return;
        }
        job.status = "error";
        job.error = err && err.message ? err.message : String(err);
        if (options.showHud !== false) {
          updateHud(`采集出错：${job.error}`, 100, "关闭", removeHud);
        }
      }
    })();

    return { ok: true, mode: "startJob", jobId, status: "running" };
  }

  async function runInPage(options = {}) {
    const mode = options.mode || "inspect";
    const selectors = options.selectors || {};

    if (mode === "inspect") {
      return inspectPage(selectors, options);
    }

    if (mode === "startJob") {
      return startBackgroundJob(options);
    }

    if (mode === "pollJob") {
      const job = globalThis[JOB_KEY];
      if (!job) {
        return { ok: true, mode: "pollJob", status: "idle" };
      }
      return {
        ok: true,
        mode: "pollJob",
        jobId: job.jobId,
        status: job.status,
        phase: job.phase,
        pass: job.pass,
        collectedCount: job.collectedCount,
        thinkingCount: job.thinkingCount,
        imageCount: job.imageCount,
        scrollRatio: job.scrollRatio,
        strategy: job.strategy,
        error: job.error,
        result: job.status === "done" ? job.result : null,
      };
    }

    if (mode === "cancelJob") {
      const job = globalThis[JOB_KEY];
      if (job) {
        job.cancelled = true;
        job.status = "cancelled";
      }
      removeHud();
      return { ok: true, mode: "cancelJob" };
    }

    if (mode === "clearJob") {
      delete globalThis[JOB_KEY];
      removeHud();
      return { ok: true, mode: "clearJob" };
    }

    const collected =
      options.autoScroll === false
        ? extractSnapshot(document, selectors)
        : await scrollAndCollectAll(document, selectors, options);

    return {
      ok: true,
      mode: "extract",
      title: getTitle(),
      url: location.href,
      strategy: collected.strategy,
      exported_at: new Date().toISOString(),
      messages: collected.messages.map(({ role, content, thinking }) => ({
        role,
        content,
        thinking,
      })),
    };
  }

  return {
    DEFAULT_SELECTORS,
    assessPageHealth,
    domToMarkdown,
    extractSnapshot,
    scrollAndCollectAll,
    runInPage,
  };
});
