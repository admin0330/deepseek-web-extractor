/**
 * EchoArchive Persistent Side Panel Controller
 * Automatically follows active DeepSeek tab/conversation switches and orchestrates
 * one-click local exports (Markdown / JSON / AES-256-GCM sealed .echo).
 */
(function () {
  "use strict";

  const {
    inspectStealthPackage,
    decryptPayload,
    parseAliasRulesText,
    restoreTextFromMap,
    formatMarkdownExport,
  } = globalThis.EchoCrypto;

  const Core = globalThis.EchoExportCore;

  // Show exact running manifest version in masthead subtitle
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest) {
    try {
      const ver = chrome.runtime.getManifest().version;
      const subTagEl = document.querySelector(".sub-tag");
      if (subTagEl && ver) subTagEl.textContent = `DeepSeek 本地归档 · v${ver}`;
    } catch (_) {}
  }


  // Cached Banner & Reconnaissance
  const cachedBanner = document.getElementById("cachedBanner");
  const cachedTitle = document.getElementById("cachedTitle");
  const cachedMeta = document.getElementById("cachedMeta");
  const useCachedEncBtn = document.getElementById("useCachedEncBtn");
  const useCachedMdBtn = document.getElementById("useCachedMdBtn");
  const discardCachedBtn = document.getElementById("discardCachedBtn");

  const inspectBtn = document.getElementById("inspectBtn");
  const countPill = document.getElementById("countPill");
  const sessionHeadline = document.getElementById("sessionHeadline");
  const sessionExcerpt = document.getElementById("sessionExcerpt");

  // Export
  const passphraseInput = document.getElementById("passphraseInput");
  const togglePassBtn = document.getElementById("togglePassBtn");
  const passStrengthLabel = document.getElementById("passStrengthLabel");
  const strengthBars = [
    document.getElementById("sb1"),
    document.getElementById("sb2"),
    document.getElementById("sb3"),
  ];

  const exportEncBtn = document.getElementById("exportEncBtn");
  const exportMdBtn = document.getElementById("exportMdBtn");
  const exportJsonBtn = document.getElementById("exportJsonBtn");
  const progressCard = document.getElementById("progressCard");
  const progPhase = document.getElementById("progPhase");
  const progFill = document.getElementById("progFill");
  const progStats = document.getElementById("progStats");
  const cancelJobBtn = document.getElementById("cancelJobBtn");
  const statusBar = document.getElementById("statusBar");

  // Expert controls
  const autoScrollChk = document.getElementById("autoScrollChk");
  const expandThinkChk = document.getElementById("expandThinkChk");
  const maskPiiChk = document.getElementById("maskPiiChk");
  const aliasRulesEl = document.getElementById("aliasRules");
  const parsedRuleHint = document.getElementById("parsedRuleHint");
  const fillSampleAliasBtn = document.getElementById("fillSampleAliasBtn");
  const clearAliasBtn = document.getElementById("clearAliasBtn");
  const selRow = document.getElementById("selRow");
  const selMarkdown = document.getElementById("selMarkdown");
  const selThink = document.getElementById("selThink");
  const selUser = document.getElementById("selUser");
  const resetSelectorsBtn = document.getElementById("resetSelectorsBtn");
  const probeSelectorsBtn = document.getElementById("probeSelectorsBtn");
  const probeOutput = document.getElementById("probeOutput");
  const unpackEchoFile = document.getElementById("unpackEchoFile");
  const unpackEchoBtn = document.getElementById("unpackEchoBtn");
  const unpackOutput = document.getElementById("unpackOutput");

  let activePollTimer = null;
  let currentTabId = null;

  /* ---------------- Motion Layer (visual only) ----------------
   * 纯视觉叠加：不改任何业务分支，只在既有状态变化后挂/摘动画类。
   * 系统开启“减少动态效果”时 ripple / 抽屉过渡 / 状态闪动全部跳过，CSS 侧同步降级为瞬时。 */
  const sessionCard = document.getElementById("sessionCard");
  const exportToast = document.getElementById("exportToast");
  const exportToastMsg = document.getElementById("exportToastMsg");
  const dockEl = document.querySelector(".dock");
  const expertDrawer = document.querySelector(".expert-drawer");
  const reducedMotionQuery =
    typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
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

  setTimeout(() => {
    if (dockEl) dockEl.classList.add("settled");
  }, 1100);

  // 计数胶囊：变为 .ready 且数字变化时弹跳一次（观察 DOM，不侵入 renderInspectState）
  let lastReadyText = "";
  new MutationObserver(() => {
    const ready = countPill.classList.contains("ready");
    const text = countPill.textContent;
    if (ready && text !== lastReadyText) {
      lastReadyText = text;
      replayClass(countPill, "flash", 460);
    } else if (!ready) {
      lastReadyText = "";
    }
  }).observe(countPill, {
    attributes: true,
    attributeFilter: ["class"],
    childList: true,
    characterData: true,
    subtree: true,
  });

  // 按钮水波纹（事件委托，不改任何按钮的 click 处理）
  document.addEventListener("pointerdown", (e) => {
    if (!motionOK() || e.button !== 0 || !e.target || typeof e.target.closest !== "function") return;
    const btn = e.target.closest(".btn-solid, .btn-outline, .btn-mini-solid, .btn-mini-outline");
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

  // 专家抽屉：保留原生 <details>[open]，仅在有动效时接管点击，用 grid 行高过渡展开/收起
  const drawerGrid = expertDrawer && expertDrawer.querySelector(".drawer-grid");
  const drawerSummary = expertDrawer && expertDrawer.querySelector("summary");
  if (drawerGrid && drawerSummary) {
    let collapseTimer = null;
    drawerSummary.addEventListener("click", (e) => {
      if (!motionOK()) return; // 减少动态：交给原生瞬时切换
      e.preventDefault();
      clearTimeout(collapseTimer);
      if (expertDrawer.open && !expertDrawer.classList.contains("is-collapsing")) {
        expertDrawer.classList.add("is-collapsing");
        collapseTimer = setTimeout(() => {
          expertDrawer.open = false;
          expertDrawer.classList.remove("is-collapsing");
        }, 340);
      } else if (expertDrawer.open) {
        expertDrawer.classList.remove("is-collapsing"); // 收起途中再点：回弹展开
      } else {
        expertDrawer.classList.add("is-expanding");
        expertDrawer.open = true;
        void drawerGrid.offsetHeight; // 先以 0fr 落一帧，再过渡到 1fr
        expertDrawer.classList.remove("is-expanding");
      }
    });
  }

  // 导出成功 toast（statusBar 仍是文案的唯一来源，toast 只是同一句话的视觉提示）
  let toastTimer = null;
  function showToast(message) {
    if (!exportToast || !exportToastMsg) return;
    exportToastMsg.textContent = message;
    exportToast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => exportToast.classList.remove("show"), 2200);
  }

  function setStatus(message, tone = "neutral") {
    statusBar.textContent = message;
    statusBar.className = "status-bar";
    if (tone === "ok") statusBar.classList.add("ok");
    if (tone === "error") statusBar.classList.add("error");
  }

  function collectCustomSelectors() {
    const map = {};
    if (selRow.value.trim()) map.row = selRow.value.trim();
    if (selMarkdown.value.trim()) map.markdown = selMarkdown.value.trim();
    if (selThink.value.trim()) map.think = selThink.value.trim();
    if (selUser.value.trim()) map.userText = selUser.value.trim();
    return map;
  }

  function updateAliasCounter() {
    const count = parseAliasRulesText(aliasRulesEl.value).length;
    parsedRuleHint.textContent = `已解析 ${count} 条规则`;
  }

  function updatePassphraseStrength() {
    const val = passphraseInput.value || "";
    strengthBars.forEach((b) => {
      b.className = "";
    });
    if (!val) {
      passStrengthLabel.textContent = "";
      return;
    }
    if (val.length < 4) {
      passStrengthLabel.textContent = "需至少 4 位";
      strengthBars[0].classList.add("weak");
      return;
    }
    const classes =
      (/[a-z]/.test(val) ? 1 : 0) +
      (/[A-Z]/.test(val) ? 1 : 0) +
      (/\d/.test(val) ? 1 : 0) +
      (/[^a-zA-Z0-9]/.test(val) ? 1 : 0);
    if (val.length >= 12 && classes >= 2) {
      passStrengthLabel.textContent = "强度：高";
      strengthBars.forEach((b) => b.classList.add("strong"));
    } else if (val.length >= 8) {
      passStrengthLabel.textContent = "强度：中";
      strengthBars[0].classList.add("fair");
      strengthBars[1].classList.add("fair");
    } else {
      passStrengthLabel.textContent = "强度：弱";
      strengthBars[0].classList.add("weak");
    }
  }

  function syncPrefsToStorage() {
    const prefs = {
      autoScroll: autoScrollChk.checked,
      expandThinking: expandThinkChk.checked,
      maskPii: maskPiiChk.checked,
      aliasRules: aliasRulesEl.value,
      selectors: collectCustomSelectors(),
    };
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["echo_prefs"], (data) => {
        const merged = { ...(data?.echo_prefs || {}), ...prefs };
        chrome.storage.local.set({ echo_prefs: merged });
      });
    }
  }

  function restorePrefs() {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["echo_prefs"], (data) => {
        const p = data?.echo_prefs;
        if (p) {
          if (typeof p.autoScroll === "boolean") autoScrollChk.checked = p.autoScroll;
          if (typeof p.expandThinking === "boolean") expandThinkChk.checked = p.expandThinking;
          if (typeof p.maskPii === "boolean") maskPiiChk.checked = p.maskPii;
          if (typeof p.aliasRules === "string") aliasRulesEl.value = p.aliasRules;
          if (p.selectors) {
            if (p.selectors.row) selRow.value = p.selectors.row;
            if (p.selectors.markdown) selMarkdown.value = p.selectors.markdown;
            if (p.selectors.think) selThink.value = p.selectors.think;
            if (p.selectors.userText) selUser.value = p.selectors.userText;
          }
        }
        updateAliasCounter();
      });
    }
    updatePassphraseStrength();
  }

  async function getActiveTabId() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0] || !tabs[0].id) {
      throw new Error("未检测到活动标签页。");
    }
    return tabs[0].id;
  }

  async function ensureExtractorInjected(tabId, force = false) {
    if (!force) {
      const [{ result: loaded }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => Boolean(window.__ECHO_ARCHIVE_EXTRACTOR__),
      });
      if (loaded) return;
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content_extractor.js"],
    });
  }

  async function callExtractor(tabId, options, forceInject = false) {
    await ensureExtractorInjected(tabId, forceInject);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (opts) => window.__ECHO_ARCHIVE_EXTRACTOR__.runInPage(opts),
      args: [options],
    });
    if (!result || !result.ok) {
      throw new Error("页面脚本未返回有效结果。");
    }
    return result;
  }

  const sanitizeFilename = Core.sanitizeFilename;

  // Side panel is an extension page: create Blob URLs directly (no offscreen needed).
  function downloadTextFile(filename, content, mimeType) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      chrome.downloads.download(
        {
          url,
          filename,
          saveAs: false,
          conflictAction: "uniquify",
        },
        (downloadId) => {
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          if (chrome.runtime.lastError || !downloadId) {
            reject(new Error(chrome.runtime.lastError?.message || "下载失败"));
          } else {
            resolve(downloadId);
          }
        }
      );
    });
  }

  function setActionButtonsDisabled(disabled) {
    exportEncBtn.disabled = disabled;
    exportMdBtn.disabled = disabled;
    exportJsonBtn.disabled = disabled;
  }

  function formatHealthSignals(signals) {
    const a = (signals && signals.anchors) || {};
    return (
      `列表项: ${a.virtualListItems ?? 0} | 气泡: ${a.messageRoots ?? 0} | 正文: ${a.markdown ?? 0}\n` +
      `滚动区: ${a.scrollAreas ?? 0} | 虚拟列表: ${a.virtualLists ?? 0} | ` +
      `节点: ${signals?.domNodes ?? 0} | 高度: ${signals?.scrollHeight ?? 0}`
    );
  }

  // 仅在选择器疑似失效时写诊断；恢复正常后撤掉自己写过的提示，不碰其他状态文案。
  let driftNoticeShown = false;
  function renderHealthDiagnostics(res) {
    if (res.health === "selector_drift") {
      const detail = formatHealthSignals(res.healthSignals);
      // statusBar 不保留换行，压成单行；完整版写进专家抽屉的 probeOutput。
      setStatus(`页面结构诊断（识别到 0 条）：${detail.replace(/\n/g, " | ")}`, "error");
      probeOutput.textContent = `健康度: selector_drift\n策略: ${res.strategy}\n${detail}`;
      driftNoticeShown = true;
    } else if (driftNoticeShown) {
      setStatus("");
      probeOutput.textContent = "";
      driftNoticeShown = false;
    }
    if (sessionCard) sessionCard.classList.toggle("is-drift", driftNoticeShown); // 视觉：失效卡片样式
  }

  function renderInspectState(res) {
    countPill.classList.remove("ready", "warn");

    if (!res.isDeepSeek && res.count === 0) {
      countPill.textContent = "非 DeepSeek";
      countPill.classList.add("warn");
      sessionHeadline.textContent = "请切换到 chat.deepseek.com 对话页";
      sessionHeadline.classList.add("muted");
      sessionExcerpt.textContent = "切换页面后自动识别。";
      cachedBanner.hidden = true;
      setActionButtonsDisabled(true);
      renderHealthDiagnostics({}); // 非 DeepSeek 页不报结构诊断，只清掉残留
      return;
    }

    setActionButtonsDisabled(res.count === 0);
    if (res.count > 0) {
      countPill.textContent = `${res.count} 条`;
      countPill.classList.add("ready");
      sessionHeadline.textContent = res.title || "DeepSeek 对话";
      sessionHeadline.classList.remove("muted");
      sessionExcerpt.textContent = res.firstPreview
        ? `首句：${res.firstPreview}`
        : "就绪，可直接导出。";
    } else if (res.health === "selector_drift") {
      countPill.textContent = "无法识别";
      countPill.classList.add("warn");
      sessionHeadline.textContent = "DeepSeek 页面结构可能已更新";
      sessionHeadline.classList.add("muted");
      sessionExcerpt.textContent = "扩展暂时无法识别对话内容。请刷新页面重试，或联系作者更新。";
    } else {
      countPill.textContent = "等待对话";
      countPill.classList.add("warn");
      sessionHeadline.textContent = "当前页暂无对话内容";
      sessionHeadline.classList.add("muted");
      sessionExcerpt.textContent = "打开一段对话后即可导出。";
    }
    renderHealthDiagnostics(res);

    if (res.cachedJob && res.cachedJob.status === "done") {
      cachedBanner.hidden = false;
      cachedTitle.textContent = `已采集 ${res.cachedJob.collectedCount} 条待保存`;
      cachedMeta.textContent = "可直接下载，无需重扫";
    } else {
      cachedBanner.hidden = true;
    }
  }

  function renderDisconnectedState() {
    countPill.textContent = "未连接";
    countPill.classList.remove("ready");
    countPill.classList.add("warn");
    sessionHeadline.textContent = "请切回 DeepSeek 对话页";
    sessionHeadline.classList.add("muted");
    sessionExcerpt.textContent = "侧栏常驻可用，切换标签页后自动恢复。";
    cachedBanner.hidden = true;
    setActionButtonsDisabled(true);
    if (sessionCard) sessionCard.classList.remove("is-drift"); // 视觉：未连接时不沿用失效卡片样式
  }

  // selector_drift 待确认时的中性过渡态，不提示失效。
  function renderConfirmingState() {
    countPill.classList.remove("ready", "warn");
    countPill.textContent = "识别中…";
    sessionHeadline.textContent = "正在识别对话内容…";
    sessionHeadline.classList.add("muted");
    sessionExcerpt.textContent = "页面仍在加载，稍候自动重试。";
    cachedBanner.hidden = true;
    setActionButtonsDisabled(true);
    renderHealthDiagnostics({});
  }

  // 二次确认：每次新检测都递增代号并清掉未完成的重查，旧结果回来时据此作废。
  let inspectGeneration = 0;
  let healthConfirmTimer = null;
  function cancelHealthConfirm() {
    if (healthConfirmTimer) {
      clearTimeout(healthConfirmTimer);
      healthConfirmTimer = null;
    }
  }

  function inspectTab(tabId, forceInject = false) {
    return callExtractor(
      tabId,
      {
        mode: "inspect",
        selectors: collectCustomSelectors(),
      },
      forceInject
    );
  }

  async function confirmHealth(tabId, generation) {
    healthConfirmTimer = null;
    const isCurrent = async () => {
      if (generation !== inspectGeneration || tabId !== currentTabId) return false;
      try {
        return (await getActiveTabId()) === tabId;
      } catch (_) {
        return false;
      }
    };
    let res;
    try {
      res = await inspectTab(tabId, false);
    } catch (_) {
      if (await isCurrent()) renderDisconnectedState();
      return;
    }
    const action = Core.decideHealthDisplay({
      health: res.health,
      attempt: 2,
      isCurrent: await isCurrent(),
      jobRunning: Boolean(activePollTimer) || Boolean(res.cachedJob && res.cachedJob.status === "running"),
    });
    if (action === "render") renderInspectState(res);
  }

  async function refreshActiveTab(forceInject = false) {
    inspectBtn.disabled = true;
    cancelHealthConfirm();
    const generation = ++inspectGeneration;
    try {
      const tabId = await getActiveTabId();
      currentTabId = tabId;
      const res = await inspectTab(tabId, forceInject);
      if (generation !== inspectGeneration) return; // 已被更新的检测取代
      const jobRunning = Boolean(res.cachedJob && res.cachedJob.status === "running");
      const action = Core.decideHealthDisplay({ health: res.health, attempt: 1, jobRunning });
      if (action === "confirm") {
        renderConfirmingState();
        healthConfirmTimer = setTimeout(
          () => confirmHealth(tabId, generation),
          Core.HEALTH_CONFIRM_DELAY_MS
        );
        return;
      }
      renderInspectState(res);
      if (jobRunning) {
        startPollingJob(tabId);
      }
    } catch (_) {
      if (generation === inspectGeneration) renderDisconnectedState();
    } finally {
      inspectBtn.disabled = false;
    }
  }

  async function finalizeAndDownload(tabId, extracted, mode) {
    if (!extracted || !extracted.messages || extracted.messages.length === 0) {
      throw new Error(Core.COPY.noMessages);
    }

    const customPass = passphraseInput.value.trim();
    const passCheck = Core.validatePassphrase(customPass);
    if (mode === "encrypted" && !passCheck.ok) {
      throw new Error(passCheck.message);
    }

    if (mode === "encrypted") setStatus("正在生成本地隐性自加密归档…");

    // Side panel downloads locally via its own Blob URL helper (not offscreen).
    const status = await Core.finalizeExport({
      mode,
      extracted,
      maskPii: maskPiiChk.checked,
      aliasRulesText: aliasRulesEl.value,
      customPass,
      downloader: downloadTextFile,
    });

    try {
      await callExtractor(tabId, { mode: "clearJob" });
    } catch (_) {}
    cachedBanner.hidden = true;

    setStatus(status, "ok");
    showToast(status);
  }

  function stopPolling() {
    if (activePollTimer) {
      clearInterval(activePollTimer);
      activePollTimer = null;
    }
    progressCard.hidden = true;
    setActionButtonsDisabled(false);
  }

  function updateProgressUI(job) {
    progressCard.hidden = false;
    setActionButtonsDisabled(true);
    const view = Core.describeProgress(job);
    progPhase.textContent = view.text;
    progFill.style.width = `${view.pct}%`;
    progStats.textContent = `已捕获 ${job.collectedCount || 0} 条`;
  }

  function startPollingJob(tabId, pendingMode = "encrypted") {
    if (activePollTimer) clearInterval(activePollTimer);
    cancelHealthConfirm();
    progressCard.hidden = false;
    setActionButtonsDisabled(true);

    const pollOnce = async () => {
      try {
        const res = await callExtractor(tabId, { mode: "pollJob" });
        if (res.status === "running") {
          updateProgressUI(res);
          return;
        }
        stopPolling();
        if (res.status === "done" && res.result) {
          await finalizeAndDownload(tabId, res.result, pendingMode);
        } else if (res.status === "cancelled") {
          setStatus("已中止。");
        } else if (res.status === "error") {
          setStatus(`导出失败：${res.error || "未知错误"}`, "error");
        }
      } catch (err) {
        stopPolling();
        setStatus(`导出失败：${err.message}`, "error");
      }
    };

    pollOnce();
    activePollTimer = setInterval(pollOnce, 200);
  }

  async function triggerExport(mode) {
    syncPrefsToStorage();

    const customPass = passphraseInput.value.trim();
    if (mode === "encrypted" && customPass && customPass.length < 4) {
      setStatus("可选口令若填写则需至少 4 位；留空将自动自加密。", "error");
      passphraseInput.focus();
      return;
    }

    setStatus("");
    try {
      const tabId = await getActiveTabId();
      currentTabId = tabId;
      await callExtractor(
        tabId,
        {
          mode: "startJob",
          autoScroll: autoScrollChk.checked,
          expandThinking: expandThinkChk.checked,
          showHud: false,
          selectors: collectCustomSelectors(),
        },
        false
      );
      startPollingJob(tabId, mode);
    } catch (err) {
      stopPolling();
      setStatus(`启动失败：${err.message}`, "error");
    }
  }

  /* ---------------- Export & Expert Handlers ---------------- */

  togglePassBtn.addEventListener("click", () => {
    passphraseInput.type = passphraseInput.type === "password" ? "text" : "password";
  });

  passphraseInput.addEventListener("input", updatePassphraseStrength);
  passphraseInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") triggerExport("encrypted");
  });

  exportEncBtn.addEventListener("click", () => triggerExport("encrypted"));
  exportMdBtn.addEventListener("click", () => triggerExport("markdown"));
  exportJsonBtn.addEventListener("click", () => triggerExport("json"));

  cancelJobBtn.addEventListener("click", async () => {
    try {
      const tabId = currentTabId || (await getActiveTabId());
      await callExtractor(tabId, { mode: "cancelJob" });
    } catch (_) {}
    stopPolling();
    setStatus("已中止。");
  });

  inspectBtn.addEventListener("click", () => refreshActiveTab(true));

  [autoScrollChk, expandThinkChk, maskPiiChk].forEach((chk) => {
    chk.addEventListener("change", syncPrefsToStorage);
  });

  aliasRulesEl.addEventListener("input", () => {
    updateAliasCounter();
    syncPrefsToStorage();
  });

  fillSampleAliasBtn.addEventListener("click", () => {
    aliasRulesEl.value = "林屿 -> [U_NAME]\n小舟 -> [NICK_1]\n上海 -> [CITY_1]";
    updateAliasCounter();
    syncPrefsToStorage();
  });

  clearAliasBtn.addEventListener("click", () => {
    aliasRulesEl.value = "";
    updateAliasCounter();
    syncPrefsToStorage();
  });

  [selRow, selMarkdown, selThink, selUser].forEach((inp) => {
    inp.addEventListener("change", syncPrefsToStorage);
  });

  resetSelectorsBtn.addEventListener("click", () => {
    selRow.value = "";
    selMarkdown.value = "";
    selThink.value = "";
    selUser.value = "";
    syncPrefsToStorage();
    probeOutput.textContent = "已重置默认选择器。";
  });

  probeSelectorsBtn.addEventListener("click", async () => {
    syncPrefsToStorage();
    probeOutput.textContent = "正在探测…";
    try {
      const tabId = await getActiveTabId();
      const res = await callExtractor(tabId, {
        mode: "inspect",
        probeSelectors: true,
        selectors: collectCustomSelectors(),
      });
      const p = res.selectorProbe || {};
      probeOutput.textContent =
        `策略: ${res.strategy}\n` +
        `行容器: ${p.rowMatches ?? 0} | 气泡: ${p.messageRootMatches ?? 0}\n` +
        `正文: ${p.markdownMatches ?? 0} | 思考: ${p.thinkMatches ?? 0} | 用户: ${p.userTextMatches ?? 0}`;
    } catch (err) {
      probeOutput.textContent = `探测失败：${err.message}`;
    }
  });

  unpackEchoBtn.addEventListener("click", () => {
    unpackEchoFile.value = "";
    unpackEchoFile.click();
  });

  unpackEchoFile.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    unpackOutput.textContent = "正在识别隐性标记并本地解封…";
    try {
      const raw = await file.text();
      const meta = await inspectStealthPackage(raw);
      const customPass = passphraseInput.value.trim();
      const decoded = await decryptPayload(raw, customPass);
      const msgs = Array.isArray(decoded.messages) ? decoded.messages : [];
      const restoreMap = decoded.restore_map;
      const finalBundle = restoreMap
        ? {
            ...decoded,
            messages: msgs.map((m) => ({
              ...m,
              content: restoreTextFromMap(m.content || "", restoreMap),
              thinking: restoreTextFromMap(m.thinking || "", restoreMap),
            })),
          }
        : decoded;
      const outStem = sanitizeFilename(file.name.replace(/\.(echo|echo\.json|json)$/i, ""));
      await downloadTextFile(
        `${outStem}_unpacked.md`,
        formatMarkdownExport(finalBundle),
        "text/markdown;charset=utf-8"
      );
      const markerLine = meta
        ? `隐性加密方式：${meta.cipher} + ${meta.kdf} (${meta.keyMode === "self-sealed" ? "免密自密封" : "口令模式"})`
        : "加密方式：兼容 v1 封存格式";
      unpackOutput.textContent = `${markerLine}\n解封成功：已还原 ${msgs.length} 条消息并导出 Markdown。`;
    } catch (err) {
      unpackOutput.textContent = `解封失败：${err.message}`;
    }
  });

  async function exportFromCache(mode) {
    try {
      const tabId = await getActiveTabId();
      const res = await callExtractor(tabId, { mode: "pollJob" });
      if (res.status === "done" && res.result) {
        await finalizeAndDownload(tabId, res.result, mode);
      } else {
        cachedBanner.hidden = true;
        setStatus("缓存已过期，请重新导出。", "error");
      }
    } catch (err) {
      setStatus(err.message, "error");
    }
  }

  useCachedEncBtn.addEventListener("click", () => exportFromCache("encrypted"));
  useCachedMdBtn.addEventListener("click", () => exportFromCache("markdown"));
  discardCachedBtn.addEventListener("click", async () => {
    try {
      const tabId = await getActiveTabId();
      await callExtractor(tabId, { mode: "clearJob" });
    } catch (_) {}
    cachedBanner.hidden = true;
  });

  if (typeof chrome !== "undefined") {
    if (chrome.tabs) {
      chrome.tabs.onActivated.addListener(() => {
        if (!activePollTimer) refreshActiveTab(false);
      });
      chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (!activePollTimer && tab && tab.active && (changeInfo.status === "complete" || changeInfo.url)) {
          refreshActiveTab(false);
        }
      });
    }
  }

  restorePrefs();
  refreshActiveTab(false);
})();
