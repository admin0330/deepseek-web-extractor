/**
 * EchoArchive Shared Export Core (no UI).
 *
 * Single source of truth for the export business layer used by BOTH the persistent
 * side panel (sidepanel.js) and the in-page floating capsule (content_capsule.js):
 *   - collection job polling (start -> poll -> done/cancel) via an injected collector
 *   - local PII pseudonymization with restore_map embedding
 *   - passwordless self-sealed .echo packaging with optional passphrase switch
 *   - all user-facing status / progress copy
 *
 * Each view supplies only two adapters:
 *   - a `collector` (how to drive __ECHO_ARCHIVE_EXTRACTOR__.runInPage in its context)
 *   - a `downloader(filename, content, mimeType)` (sidepanel uses a local Blob URL;
 *     the capsule routes through background -> offscreen for large long-chat files)
 *
 * Zero external network calls.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.EchoExportCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const EchoCrypto = root.EchoCrypto;

  const POLL_INTERVAL_MS = 200;
  const HEALTH_CONFIRM_DELAY_MS = 900;

  // ---- Unified copy (both views render these identically) ----
  const COPY = {
    passTooShort: "可选口令若填写则需至少 4 位；留空将自动免密自加密。",
    noMessages: "未提取到对话内容，请刷新页面后重试。",
    noMessagesOnPage: "当前页未检测到对话消息，请先打开具体会话。",
    cancelled: "已中止导出。",
  };

  /**
   * Split a (possibly multi-million-char) string into fixed-size chunks for the
   * capsule -> background download transfer, avoiding any single oversized IPC message.
   * Returns [whole string as one chunk] for empty/short input (never an empty array for
   * non-empty input), so the transfer always has at least one chunk.
   */
  function chunkString(content, size = 262144) {
    const str = String(content == null ? "" : content);
    const step = Math.max(1, Math.trunc(Number(size) || 262144));
    if (str.length <= step) return [str];
    const out = [];
    for (let i = 0; i < str.length; i += step) {
      out.push(str.slice(i, i + step));
    }
    return out;
  }

  function sanitizeFilename(name) {
    return (
      String(name || "deepseek_chat")
        .replace(/[\\/:*?"<>|\s]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 48) || "deepseek_chat"
    );
  }

  function makeBaseName(title) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    return `echo_${sanitizeFilename(title)}_${stamp}`;
  }

  /**
   * Map a running job snapshot to unified progress text + percentage.
   */
  function describeProgress(job) {
    if (!job) return { text: "正在采集…", pct: 8 };
    if (job.phase === "top_seek") {
      return { text: `回溯顶部 · 第 ${job.pass || 0} 步`, pct: Math.min(25, 8 + (job.pass || 0) * 3) };
    }
    if (job.phase === "sweep_collect") {
      const ratio = job.scrollRatio || 0;
      return { text: `扫描中 · ${Math.round(ratio * 100)}%`, pct: Math.min(96, 25 + Math.round(ratio * 70)) };
    }
    return { text: "生成文件中…", pct: 98 };
  }

  /**
   * Decide how the side panel should treat an inspect result's `health`.
   * SPA 页面 complete 时外壳已在、消息未渲染，单次 selector_drift 不可信，需延迟重查确认。
   *   attempt 1: selector_drift（且无抽取 job 在跑）=> "confirm"（显示过渡态并安排重查），否则 "render"
   *   attempt 2: 结果已过期（换了 tab / 有更新的检测）或 job 在跑 => "discard"，否则 "render"
   * Returns "render" | "confirm" | "discard".
   */
  function decideHealthDisplay({ health, attempt = 1, isCurrent = true, jobRunning = false } = {}) {
    if (attempt >= 2) {
      if (!isCurrent || jobRunning) return "discard";
      return "render";
    }
    if (health === "selector_drift" && !jobRunning) return "confirm";
    return "render";
  }

  /**
   * Validate an optional custom passphrase (empty => passwordless self-seal).
   * Returns { ok, message }.
   */
  function validatePassphrase(customPass) {
    const pass = String(customPass || "").trim();
    if (pass && pass.length < 4) return { ok: false, message: COPY.passTooShort };
    return { ok: true, message: "" };
  }

  /**
   * Drive a collection job to completion using the injected collector adapter.
   * collector: { start(opts), poll(), clear(), cancel() } each returning a Promise.
   * onProgress(viewObj, rawJob) is called with unified text/pct while running.
   * Resolves with the extracted result object, rejects on cancel/error.
   */
  async function runCollect(collector, startOptions, onProgress) {
    await collector.start(startOptions);
    return new Promise((resolve, reject) => {
      let timer = null;
      const stop = () => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      };
      const tick = async () => {
        try {
          const job = await collector.poll();
          if (job.status === "running") {
            if (onProgress) onProgress(describeProgress(job), job);
            return;
          }
          stop();
          if (job.status === "done" && job.result) {
            resolve(job.result);
          } else if (job.status === "cancelled") {
            reject(new Error("已中止导出"));
          } else {
            reject(new Error(job.error || "采集失败"));
          }
        } catch (err) {
          stop();
          reject(err);
        }
      };
      tick();
      timer = setInterval(tick, POLL_INTERVAL_MS);
    });
  }

  /**
   * Apply local pseudonymization to extracted messages (full conversation, no truncation),
   * producing the export bundle and its associated restore map.
   */
  function buildBundle(extracted, { maskPii, aliasRulesText }) {
    const sanitized = EchoCrypto.pseudonymizeMessages(extracted.messages, {
      maskPii: maskPii !== false,
      aliasRulesText: aliasRulesText || "",
    });
    const messagesToExport = sanitized.messages;
    const replacedTurns = sanitized.replacedTurns;
    const restoreMap = sanitized.restoreMap;

    const restoreCount = Object.keys(restoreMap.entries).length;
    const bundle = {
      format: EchoCrypto.PLAIN_FORMAT,
      title: extracted.title,
      url: extracted.url,
      strategy: extracted.strategy,
      exported_at: extracted.exported_at,
      pseudonymized: restoreCount > 0,
      messages: messagesToExport,
    };

    return { bundle, restoreMap, restoreCount, replacedTurns, messagesCount: messagesToExport.length };
  }

  /**
   * Compose the final success status line (identical wording across both views).
   */
  function composeStatus({ mode, messagesCount, restoreCount, replacedTurns, customPass }) {
    if (mode === "encrypted") {
      const sealTag = String(customPass || "").trim() ? "自定义口令加密" : "免密自加密";
      return (
        `已导出 .echo 加密包（${messagesCount} 条 · ${sealTag}` +
        (restoreCount > 0 ? ` · 含脱敏 ${replacedTurns} 条已内置）` : "）")
      );
    }
    return (
      `已导出 ${messagesCount} 条消息` +
      (restoreCount > 0 ? `（含脱敏 ${replacedTurns} 条与还原表）` : "")
    );
  }

  /**
   * Build the concrete output file list (name/content/mimeType) for a bundle.
   * Encryption happens here so both views seal identically.
   */
  async function buildArtifacts({ mode, extracted, bundle, restoreMap, restoreCount, customPass }) {
    const baseName = makeBaseName(extracted.title);
    const files = [];

    if (mode === "encrypted") {
      if (restoreCount > 0) {
        bundle.restore_map = restoreMap;
      }
      const sealedBody = await EchoCrypto.sealStealthPackage(bundle, String(customPass || "").trim(), {
        hasRestoreMap: restoreCount > 0,
      });
      files.push({ filename: `${baseName}.echo`, content: sealedBody, mimeType: "text/plain;charset=utf-8" });
    } else if (mode === "json") {
      files.push({
        filename: `${baseName}.json`,
        content: JSON.stringify(bundle, null, 2),
        mimeType: "application/json",
      });
    } else {
      files.push({
        filename: `${baseName}.md`,
        content: EchoCrypto.formatMarkdownExport(bundle),
        mimeType: "text/markdown;charset=utf-8",
      });
    }

    // Non-encrypted exports ship the restore map as a sidecar file.
    if (mode !== "encrypted" && restoreCount > 0) {
      files.push({
        filename: `${baseName}.restore_map.json`,
        content: JSON.stringify(restoreMap, null, 2),
        mimeType: "application/json",
      });
    }

    return files;
  }

  /**
   * Full build + download of an already-extracted conversation.
   * downloader(filename, content, mimeType) performs the actual save in the caller's context.
   * Returns the composed success status string.
   */
  async function finalizeExport({ mode, extracted, maskPii, aliasRulesText, customPass, downloader }) {
    if (!extracted || !extracted.messages || extracted.messages.length === 0) {
      throw new Error(COPY.noMessages);
    }

    const { bundle, restoreMap, restoreCount, replacedTurns, messagesCount } = buildBundle(extracted, {
      maskPii,
      aliasRulesText,
    });

    const files = await buildArtifacts({ mode, extracted, bundle, restoreMap, restoreCount, customPass });
    for (const f of files) {
      await downloader(f.filename, f.content, f.mimeType);
    }

    return composeStatus({ mode, messagesCount, restoreCount, replacedTurns, customPass });
  }

  return {
    COPY,
    POLL_INTERVAL_MS,
    HEALTH_CONFIRM_DELAY_MS,
    decideHealthDisplay,
    chunkString,
    sanitizeFilename,
    makeBaseName,
    describeProgress,
    validatePassphrase,
    runCollect,
    buildBundle,
    composeStatus,
    buildArtifacts,
    finalizeExport,
  };
});
