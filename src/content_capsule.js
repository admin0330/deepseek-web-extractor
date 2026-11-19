/**
 * EchoArchive In-Page Persistent Capsule (Shadow DOM)
 * Renders an unobtrusive, always-present export capsule on chat.deepseek.com
 * for one-click foolproof Markdown or AES-256-GCM encrypted archiving.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.top !== window.self) return;
  if (typeof globalThis.__ECHO_ARCHIVE_CAPSULE_DISPOSE__ === "function") {
    try {
      globalThis.__ECHO_ARCHIVE_CAPSULE_DISPOSE__();
    } catch (_) {}
  }
  const existingHost = document.getElementById("echo-archive-capsule-host");
  if (existingHost) existingHost.remove();

  const Extractor = globalThis.__ECHO_ARCHIVE_EXTRACTOR__;
  const EchoCrypto = globalThis.EchoCrypto;
  const Core = globalThis.EchoExportCore;
  if (!Extractor || !EchoCrypto || !Core) return;

  const HOST_ID = "echo-archive-capsule-host";
  const DEFAULT_PREFS = {
    autoScroll: true,
    expandThinking: true,
    maskPii: true,
    aliasRules: "",
    selectors: {},
    capsuleMinimized: false,
  };

  let prefs = { ...DEFAULT_PREFS };
  let isExpanded = false;
  let isExporting = false;
  let disposed = false;

  function loadPrefs() {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["echo_prefs"], (data) => {
        if (data && data.echo_prefs) {
          prefs = { ...DEFAULT_PREFS, ...data.echo_prefs };
          renderState();
        }
      });
    }
  }

  function saveMinimizedPref(val) {
    prefs.capsuleMinimized = Boolean(val);
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["echo_prefs"], (data) => {
        const next = { ...DEFAULT_PREFS, ...(data?.echo_prefs || {}), capsuleMinimized: prefs.capsuleMinimized };
        chrome.storage.local.set({ echo_prefs: next });
      });
    }
  }

  const sanitizeFilename = Core.sanitizeFilename;

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!resp || !resp.ok) {
          reject(new Error((resp && resp.error) || "下载失败"));
        } else {
          resolve(resp);
        }
      });
    });
  }

  /**
   * Capsule download channel: stream the (possibly multi-million-char) body to the
   * service worker in chunks, which assembles it and builds a Blob URL via the offscreen
   * document for chrome.downloads — never a size-capped data: URL.
   */
  async function downloadViaExtension(filename, content, mimeType) {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      throw new Error("扩展下载通道不可用");
    }
    const transferId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const chunks = Core.chunkString(content);
    await sendRuntimeMessage({
      type: "ECHO_DL_BEGIN",
      transferId,
      filename,
      mimeType,
      total: chunks.length,
    });
    for (let i = 0; i < chunks.length; i += 1) {
      await sendRuntimeMessage({ type: "ECHO_DL_CHUNK", transferId, index: i, data: chunks[i] });
    }
    const done = await sendRuntimeMessage({ type: "ECHO_DL_END", transferId });
    return done.downloadId;
  }

  function getQuickMetrics() {
    const rows = document.querySelectorAll("[data-virtual-list-item-key], .ds-message").length;
    const title = (document.title || "DeepSeek 对话").replace(/\s*-\s*DeepSeek.*$/i, "").trim();
    return { rows, title };
  }

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText =
    "position:fixed;top:0;right:0;z-index:2147483645;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',sans-serif;";
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      /* 令牌与侧栏 sidepanel.css 同值；挂在 .wrap 上（shadow 内部），不受宿主页面同名变量影响 */
      .wrap {
        --ea-bg: #0a0a0a;
        --ea-surface: #121212;
        --ea-surface-2: #1a1a1a;
        --ea-well: #070707;
        --ea-ink: #f5f5f5;
        --ea-ink-2: #a3a3a3;
        --ea-ink-3: #6b6b6b;
        --ea-line: #232323;
        --ea-line-strong: #363636;
        --ea-danger: #e0605d;
        --ea-sans: system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
        --ea-mono: ui-monospace, SFMono-Regular, Menlo, "Cascadia Code", monospace;
        --ea-ease: cubic-bezier(0.22, 0.61, 0.36, 1);
        --ea-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
        color-scheme: dark;
      }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif; }

      @keyframes ea-rise {
        from { opacity: 0; transform: translateY(-6px) scale(0.98); }
        to { opacity: 1; transform: none; }
      }
      @keyframes ea-fade-up {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: none; }
      }
      @keyframes ea-slide-in {
        from { opacity: 0; transform: translateX(10px); }
        to { opacity: 1; transform: none; }
      }
      @keyframes ea-flash {
        0% { transform: scale(1); }
        40% { transform: scale(1.14); }
        100% { transform: scale(1); }
      }
      @keyframes ea-shimmer {
        to { transform: translateX(320%); }
      }

      @keyframes ea-ripple {
        to { transform: translate(-50%, -50%) scale(1); opacity: 0; }
      }

      .wrap {
        position: fixed;
        top: 13px;
        right: 60px;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        color: var(--ea-ink);
        font-size: 13px;
        line-height: 1.5;
        -webkit-font-smoothing: antialiased;
      }
      .wrap.docked-edge {
        top: 74px;
        right: 0;
      }

      /* 贴边收起态：从右侧滑入 */
      .edge-tab {
        display: none;
        align-items: center;
        padding: 7px 10px 7px 11px;
        background: var(--ea-surface);
        color: var(--ea-ink);
        border: 1px solid var(--ea-line-strong);
        border-right: none;
        border-radius: 7px 0 0 7px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.02em;
        box-shadow: 0 10px 28px -8px rgba(0, 0, 0, 0.7);
        animation: ea-slide-in 0.34s var(--ea-ease-out) both;
        transition: background 0.2s, border-color 0.2s;
      }
      .edge-tab:hover { background: var(--ea-surface-2); border-color: var(--ea-ink-2); }

      /* 胶囊 pill：出现时淡入升起 */
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 6px 9px 6px 10px;
        border-radius: 8px;
        background: var(--ea-surface);
        border: 1px solid var(--ea-line);
        box-shadow: 0 10px 28px -8px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.02) inset;
        cursor: pointer;
        user-select: none;
        animation: ea-fade-up 0.4s var(--ea-ease-out) both;
        transition: border-color 0.2s, background 0.2s, transform 0.09s;
      }
      .pill:hover { border-color: var(--ea-line-strong); background: var(--ea-surface-2); }
      .pill:active { transform: scale(0.97); }
      .pill-label { font-size: 12px; font-weight: 600; color: var(--ea-ink); }
      .pill-count {
        display: inline-block;
        font-family: var(--ea-mono);
        font-size: 11px;
        font-weight: 600;
        padding: 1px 7px;
        border-radius: 5px;
        background: var(--ea-well);
        border: 1px solid var(--ea-line);
        color: var(--ea-ink-2);
        font-variant-numeric: tabular-nums;
        transition: color 0.3s, border-color 0.3s, background 0.3s;
      }
      .pill-count.flash { animation: ea-flash 0.45s var(--ea-ease); }
      .pill-hide {
        border: none;
        background: transparent;
        color: var(--ea-ink-3);
        cursor: pointer;
        padding: 1px 4px;
        font-size: 13px;
        line-height: 1;
        border-radius: 4px;
        transition: color 0.15s, background 0.15s;
      }
      .pill-hide:hover { color: var(--ea-ink); background: #242424; }

      /* 展开卡片：从右上角淡入升起 */
      .card {
        width: 288px;
        background: var(--ea-bg);
        border: 1px solid var(--ea-line);
        border-radius: 14px;
        padding: 13px 14px;
        box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(255, 255, 255, 0.02) inset;
        display: none;
        flex-direction: column;
        gap: 10px;
        transform-origin: top right;
      }
      .card.open { display: flex; animation: ea-rise 0.38s var(--ea-ease-out) both; }

      .card-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        padding-bottom: 10px;
        border-bottom: 1px solid var(--ea-line);
      }
      .brand {
        font-family: var(--ea-mono);
        font-size: 10px;
        letter-spacing: 0.08em;
        color: var(--ea-ink-3);
        text-transform: uppercase;
      }
      .chat-title {
        margin-top: 2px;
        font-size: 14px;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: var(--ea-ink);
        max-width: 218px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .min-btn {
        border: 1px solid var(--ea-line);
        background: var(--ea-well);
        color: var(--ea-ink-2);
        width: 24px;
        height: 24px;
        border-radius: 6px;
        cursor: pointer;
        display: grid;
        place-items: center;
        font-size: 13px;
        flex-shrink: 0;
        transition: color 0.15s, border-color 0.15s, transform 0.09s;
      }
      .min-btn:hover { color: var(--ea-ink); border-color: var(--ea-line-strong); }
      .min-btn:active { transform: scale(0.92); }

      /* 按钮：按下缩放 + 水波纹（.ripple 由动效层插入） */
      .btn-primary,
      .btn-md {
        position: relative;
        overflow: hidden;
      }
      .btn-primary {
        width: 100%;
        border: 1px solid var(--ea-ink);
        border-radius: 7px;
        padding: 9px 12px;
        background: var(--ea-ink);
        color: var(--ea-bg);
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.2s, transform 0.09s, box-shadow 0.2s;
      }
      .btn-primary:hover:not(:disabled) { opacity: 0.9; }
      .btn-primary:disabled { opacity: 0.38; cursor: not-allowed; }

      .btn-md {
        width: 100%;
        border: 1px solid var(--ea-line-strong);
        border-radius: 7px;
        padding: 8px 10px;
        background: transparent;
        color: var(--ea-ink-2);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: color 0.2s, border-color 0.2s, transform 0.09s;
      }
      .btn-md:hover:not(:disabled) {
        color: var(--ea-ink);
        border-color: var(--ea-ink-2);
      }
      .btn-md:disabled { opacity: 0.38; cursor: not-allowed; }

      .btn-primary:active:not(:disabled),
      .btn-md:active:not(:disabled) { transform: scale(0.975); }

      .ripple {
        position: absolute;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.25);
        transform: translate(-50%, -50%) scale(0);
        pointer-events: none;
        animation: ea-ripple 0.55s var(--ea-ease-out) forwards;
      }
      .btn-primary .ripple { background: rgba(0, 0, 0, 0.18); }

      /* 进度：出现时淡入；宽度缓动 + 流光 */
      .prog-box {
        display: none;
        flex-direction: column;
        gap: 8px;
        padding: 10px 11px;
        border-radius: 8px;
        background: var(--ea-well);
        border: 1px solid var(--ea-line-strong);
        overflow: hidden;
      }
      .prog-box.show { display: flex; animation: ea-fade-up 0.3s var(--ea-ease-out) both; }
      .prog-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 11.5px;
        font-weight: 500;
        color: var(--ea-ink);
      }
      .cancel-btn {
        border: none;
        background: transparent;
        color: var(--ea-ink-3);
        cursor: pointer;
        font-size: 11px;
        padding: 1px 4px;
        transition: color 0.15s;
      }
      .cancel-btn:hover { color: var(--ea-ink); }
      .track { position: relative; height: 3px; border-radius: 3px; background: var(--ea-line); overflow: hidden; }
      .fill { height: 100%; width: 8%; border-radius: 3px; background: var(--ea-ink); transition: width 0.4s var(--ea-ease); }
      .fill::after {
        content: "";
        position: absolute;
        inset: 0;
        width: 40%;
        background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.35), transparent);
        transform: translateX(-120%);
        animation: ea-shimmer 1.1s linear infinite;
      }

      /* 状态条（含导出完成反馈）：每次从空到有文案时淡入升起 */
      .status {
        font-size: 11.5px;
        color: var(--ea-ink-2);
        line-height: 1.45;
        animation: ea-fade-up 0.34s var(--ea-ease-out) both;
      }
      .status.ok {
        color: var(--ea-ink);
        padding: 8px 10px;
        border-radius: 7px;
        background: var(--ea-surface);
        border: 1px solid var(--ea-line-strong);
      }
      .status.err { color: var(--ea-danger); }
      .status:empty { display: none; }

      .head-right { display: flex; align-items: center; gap: 5px; }

      .main-box { display: flex; flex-direction: column; gap: 8px; animation: ea-fade-up 0.3s var(--ea-ease-out) both; }

      [hidden] { display: none !important; }

      /* 减少动态效果：动画与过渡降级为瞬时、无位移，功能不变 */
      @media (prefers-reduced-motion: reduce) {
        *,
        *::before,
        *::after {
          animation-duration: 0.01ms !important;
          animation-delay: 0s !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.01ms !important;
          transition-delay: 0s !important;
        }
        .fill::after,
        .ripple { display: none; }
      }
    </style>

    <div class="wrap" id="wrap">
      <div class="pill" id="pill">
        <svg width="14" height="14" viewBox="0 0 18 18" fill="none" style="color:#f5f5f5;flex-shrink:0">
          <rect x="2.25" y="2.25" width="13.5" height="13.5" rx="2" stroke="currentColor" stroke-width="1.4" />
          <path d="M5.5 6.5H12.5M5.5 9.25H12.5M5.5 12H9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="square" />
        </svg>
        <span class="pill-label">导出</span>
        <span class="pill-count" id="pillCount">--</span>
        <button class="pill-hide" id="dockEdgeBtn" type="button" title="贴边收起">×</button>
      </div>

      <button class="edge-tab" id="edgeTab" type="button" title="展开 EchoArchive">
        <span>Echo</span>
      </button>

      <div class="card" id="card">
        <div class="card-head">
          <div>
            <div class="brand">ECHOARCHIVE · LOCAL</div>
            <div class="chat-title" id="chatTitle">DeepSeek 对话</div>
          </div>
          <div class="head-right">
            <button class="min-btn" id="collapseCardBtn" type="button" title="收起">—</button>
          </div>
        </div>

        <div class="main-box">
          <button class="btn-primary" id="exportEncBtn" type="button">
            <span>一键导出加密包 (.echo · 默认)</span>
          </button>
          <button class="btn-md" id="exportMdBtn" type="button">导出 Markdown (.md)</button>

          <div class="prog-box" id="progBox">
            <div class="prog-row">
              <span id="progLabel">正在扫描…</span>
              <button class="cancel-btn" id="cancelBtn" type="button">中止</button>
            </div>
            <div class="track"><div class="fill" id="progFill"></div></div>
          </div>
        </div>

        <div class="status" id="status"></div>
      </div>

    </div>
  `;

  const wrap = shadow.getElementById("wrap");
  const card = shadow.getElementById("card");
  const pill = shadow.getElementById("pill");
  const edgeTab = shadow.getElementById("edgeTab");
  const pillCount = shadow.getElementById("pillCount");
  const chatTitle = shadow.getElementById("chatTitle");
  const exportEncBtn = shadow.getElementById("exportEncBtn");
  const exportMdBtn = shadow.getElementById("exportMdBtn");
  const progBox = shadow.getElementById("progBox");
  const progLabel = shadow.getElementById("progLabel");
  const progFill = shadow.getElementById("progFill");
  const cancelBtn = shadow.getElementById("cancelBtn");
  const statusEl = shadow.getElementById("status");
  const collapseCardBtn = shadow.getElementById("collapseCardBtn");
  const dockEdgeBtn = shadow.getElementById("dockEdgeBtn");

  /* ---------------- Motion Layer (visual only) ----------------
   * 与侧栏同一套动效：只在既有状态变化后挂/摘动画类，不改任何业务分支或取元素方式。
   * 系统开启“减少动态效果”时跳过 ripple / 闪动，样式侧同步降级为瞬时。 */
  const reducedMotionQuery =
    typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const motionOK = () => !(reducedMotionQuery && reducedMotionQuery.matches);

  const replayTimers = new WeakMap();
  function replayClass(el, cls, ms) {
    if (!el || !motionOK()) return;
    clearTimeout(replayTimers.get(el));
    el.classList.remove(cls);
    void el.offsetWidth; // 重启同名动画
    el.classList.add(cls);
    replayTimers.set(el, setTimeout(() => el.classList.remove(cls), ms));
  }

  // 计数 pill：从“--/待对话”变为“N 条”（数字就绪）时轻微弹跳；滚动中的条数变化不重复弹
  let pillCountReady = false;
  new MutationObserver(() => {
    const ready = /\d/.test(pillCount.textContent || "");
    if (ready && !pillCountReady) replayClass(pillCount, "flash", 460);
    pillCountReady = ready;
  }).observe(pillCount, { childList: true, characterData: true, subtree: true });

  // 按钮水波纹（shadow 内事件委托，不改任何按钮的 click 处理）
  shadow.addEventListener("pointerdown", (e) => {
    if (!motionOK() || e.button !== 0 || !e.target || typeof e.target.closest !== "function") return;
    const btn = e.target.closest(".btn-primary, .btn-md");
    if (!btn || btn.disabled) return;
    const rect = btn.getBoundingClientRect();
    const dot = document.createElement("span");
    dot.className = "ripple";
    dot.setAttribute("aria-hidden", "true");
    const size = Math.max(rect.width, rect.height);
    dot.style.width = dot.style.height = `${size}px`;
    dot.style.left = `${e.clientX - rect.left}px`;
    dot.style.top = `${e.clientY - rect.top}px`;
    btn.appendChild(dot);
    setTimeout(() => dot.remove(), 600);
  });

  function setStatus(text, tone = "neutral") {
    statusEl.textContent = text;
    statusEl.className = "status";
    if (tone === "ok") statusEl.classList.add("ok");
    if (tone === "err") statusEl.classList.add("err");
  }

  function renderState() {
    const { rows, title } = getQuickMetrics();
    chatTitle.textContent = title || "DeepSeek 对话";
    pillCount.textContent = rows > 0 ? `${rows} 条` : "待对话";

    if (prefs.capsuleMinimized && !isExpanded && !isExporting) {
      wrap.classList.add("docked-edge");
      pill.style.display = "none";
      edgeTab.style.display = "inline-flex";
    } else {
      wrap.classList.remove("docked-edge");
      pill.style.display = "inline-flex";
      edgeTab.style.display = "none";
    }
    card.classList.toggle("open", isExpanded);
  }

  async function runFoolproofExport(mode) {
    if (isExporting) return;
    const { rows } = getQuickMetrics();
    if (rows === 0) {
      setStatus("当前页未检测到对话消息，请先打开具体会话。", "err");
      return;
    }

    await new Promise((resolve) => {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["echo_prefs"], (data) => {
          if (data && data.echo_prefs) prefs = { ...DEFAULT_PREFS, ...data.echo_prefs };
          resolve();
        });
      } else {
        resolve();
      }
    });

    isExporting = true;
    exportEncBtn.disabled = true;
    exportMdBtn.disabled = true;
    progBox.classList.add("show");
    progLabel.textContent = "准备扫描…";
    progFill.style.width = "10%";
    setStatus("");

    // Capsule-local collector adapter: drive the in-page extractor directly.
    const collector = {
      start: (opts) => Extractor.runInPage({ mode: "startJob", ...opts }),
      poll: () => {
        if (disposed) throw new Error("已中止导出");
        return Extractor.runInPage({ mode: "pollJob" });
      },
      clear: () => Extractor.runInPage({ mode: "clearJob" }),
      cancel: () => Extractor.runInPage({ mode: "cancelJob" }),
    };

    try {
      const extracted = await Core.runCollect(
        collector,
        {
          autoScroll: prefs.autoScroll !== false,
          expandThinking: prefs.expandThinking !== false,
          showHud: false,
          selectors: prefs.selectors || {},
        },
        (view) => {
          progLabel.textContent = view.text;
          progFill.style.width = `${view.pct}%`;
        }
      );

      progLabel.textContent = mode === "encrypted" ? "本地加密中…" : "生成 Markdown…";
      progFill.style.width = "98%";

      // Capsule stays one-click: always passwordless self-seal (customPass = "").
      const status = await Core.finalizeExport({
        mode,
        extracted,
        maskPii: prefs.maskPii !== false,
        aliasRulesText: prefs.aliasRules || "",
        customPass: "",
        downloader: downloadViaExtension,
      });

      await collector.clear();
      setStatus(status, "ok");
    } catch (err) {
      if (err && err.message === "已中止导出") {
        setStatus(Core.COPY.cancelled);
      } else {
        setStatus(`导出失败：${err.message}`, "err");
      }
    } finally {
      isExporting = false;
      exportEncBtn.disabled = false;
      exportMdBtn.disabled = false;
      progBox.classList.remove("show");
    }
  }

  pill.addEventListener("click", (e) => {
    if (e.target === dockEdgeBtn) return;
    isExpanded = !isExpanded;
    renderState();
  });

  dockEdgeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    isExpanded = false;
    saveMinimizedPref(true);
    renderState();
  });

  edgeTab.addEventListener("click", () => {
    saveMinimizedPref(false);
    isExpanded = true;
    renderState();
  });

  collapseCardBtn.addEventListener("click", () => {
    isExpanded = false;
    renderState();
  });

  exportEncBtn.addEventListener("click", () => runFoolproofExport("encrypted"));
  exportMdBtn.addEventListener("click", () => runFoolproofExport("markdown"));

  cancelBtn.addEventListener("click", async () => {
    await Extractor.runInPage({ mode: "cancelJob" });
  });

  loadPrefs();
  renderState();
  const stateTimer = setInterval(renderState, 1800);
  globalThis.__ECHO_ARCHIVE_CAPSULE_DISPOSE__ = () => {
    disposed = true; // next poll in Core.runCollect throws, clearing its internal timer
    clearInterval(stateTimer);
    if (host && host.parentNode) host.remove();
  };
})();
