/**
 * EchoArchive MV3 Service Worker
 * - Enables persistent Side Panel on toolbar icon click
 * - Bridges large local downloads for the in-page capsule via a chunked transfer and a
 *   single Offscreen Document that builds Blob URLs (the SW itself has no DOM / no
 *   URL.createObjectURL). This replaces the old data:base64 URL path, which hit
 *   Chromium's data-URL / IPC size cap on multi-million-char long chats.
 * Zero external network calls. Zero cookie/session access.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const OFFSCREEN_PATH = "src/offscreen.html";

  // Retained as a graceful-degradation fallback for environments without
  // chrome.offscreen, and exercised directly by the unit tests.
  function textToDataUrl(text, mimeType) {
    const bytes = new TextEncoder().encode(String(text || ""));
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    const base64 = btoa(binary);
    const cleanMime = String(mimeType || "text/plain").split(";")[0].trim() || "text/plain";
    return `data:${cleanMime};charset=utf-8;base64,${base64}`;
  }

  /**
   * Pure, chrome-free accumulator for chunked downloads (content script -> SW).
   * Keeps each in-flight transfer's ordered chunks until END assembles the full body.
   * Unit-tested without any browser APIs.
   */
  function createDownloadBuffer() {
    const transfers = new Map();
    return {
      begin(transferId, meta) {
        transfers.set(String(transferId), {
          filename: String((meta && meta.filename) || "echo_export.txt"),
          mimeType: String((meta && meta.mimeType) || "text/plain"),
          total: Number((meta && meta.total) || 0),
          chunks: [],
        });
      },
      chunk(transferId, index, data) {
        const t = transfers.get(String(transferId));
        if (!t) throw new Error("未知的下载传输会话。");
        t.chunks[Number(index)] = String(data == null ? "" : data);
      },
      end(transferId) {
        const id = String(transferId);
        const t = transfers.get(id);
        if (!t) throw new Error("未知的下载传输会话。");
        transfers.delete(id);
        if (t.total && t.chunks.length !== t.total) {
          throw new Error("下载分块不完整，请重试。");
        }
        for (let i = 0; i < t.chunks.length; i += 1) {
          if (typeof t.chunks[i] !== "string") throw new Error("下载分块缺失，请重试。");
        }
        return { filename: t.filename, mimeType: t.mimeType, content: t.chunks.join("") };
      },
      has(transferId) {
        return transfers.has(String(transferId));
      },
      size() {
        return transfers.size;
      },
    };
  }

  function assembleChunks(chunks) {
    return (Array.isArray(chunks) ? chunks : []).map((c) => String(c == null ? "" : c)).join("");
  }

  function enableSidePanelOnClick() {
    if (typeof chrome !== "undefined" && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    }
  }

  async function refreshExistingDeepSeekTabs() {
    if (
      typeof chrome === "undefined" ||
      !chrome.tabs ||
      !chrome.tabs.query ||
      !chrome.scripting ||
      !chrome.runtime ||
      !chrome.runtime.getManifest
    ) {
      return;
    }
    try {
      const manifest = chrome.runtime.getManifest();
      const files =
        (manifest.content_scripts && manifest.content_scripts[0] && manifest.content_scripts[0].js) ||
        [];
      if (!files.length) return;
      const tabs = await chrome.tabs.query({ url: "https://chat.deepseek.com/*" });
      for (const tab of tabs) {
        if (!tab || !tab.id) continue;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              if (typeof globalThis.__ECHO_ARCHIVE_CAPSULE_DISPOSE__ === "function") {
                try {
                  globalThis.__ECHO_ARCHIVE_CAPSULE_DISPOSE__();
                } catch (_) {}
              }
              const old = document.getElementById("echo-archive-capsule-host");
              if (old) old.remove();
            },
          });
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files,
          });
        } catch (_) {}
      }
    } catch (_) {}
  }

  // ---- Offscreen singleton management (mutex guards concurrent creation) ----
  let offscreenCreating = null;

  async function hasOffscreenDocument() {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
      });
      return contexts.length > 0;
    }
    // Fallback for older runtimes without getContexts.
    if (chrome.extension && chrome.extension.getViews) {
      const url = chrome.runtime.getURL(OFFSCREEN_PATH);
      return chrome.extension.getViews().some((v) => v.location && v.location.href === url);
    }
    return false;
  }

  async function ensureOffscreenDocument() {
    if (await hasOffscreenDocument()) return;
    // Single-flight: if another download is already creating it, await that one.
    if (offscreenCreating) {
      await offscreenCreating;
      return;
    }
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["BLOBS"],
        justification: "Assemble large conversation export into a Blob for local download.",
      })
      .catch(async (err) => {
        // Lost a race: a concurrent call already created it. Tolerate that.
        if (await hasOffscreenDocument()) return;
        throw err;
      });
    try {
      await offscreenCreating;
    } finally {
      offscreenCreating = null;
    }
  }

  async function closeOffscreenIfIdle() {
    if (pendingDownloads.size > 0 || downloadBuffer.size() > 0) return;
    try {
      if (await hasOffscreenDocument()) {
        await chrome.offscreen.closeDocument();
      }
    } catch (_) {}
  }

  function sendToOffscreen(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ target: "offscreen", ...message }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(resp);
        }
      });
    });
  }

  const downloadBuffer = createDownloadBuffer();
  // downloadId -> { url } so onChanged can revoke the exact Blob URL once finished.
  const pendingDownloads = new Map();

  async function finalizeTransfer(transferId) {
    const assembled = downloadBuffer.end(transferId);
    await ensureOffscreenDocument();

    const built = await sendToOffscreen({
      type: "ECHO_OFFSCREEN_BUILD",
      content: assembled.content,
      mimeType: assembled.mimeType,
    });
    if (!built || !built.ok || !built.url) {
      await closeOffscreenIfIdle();
      throw new Error((built && built.error) || "离屏文档构建 Blob 失败。");
    }

    const blobUrl = built.url;
    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: blobUrl,
          filename: assembled.filename,
          saveAs: false,
          conflictAction: "uniquify",
        },
        (id) => {
          if (chrome.runtime.lastError || !id) {
            reject(new Error(chrome.runtime.lastError?.message || "下载失败"));
          } else {
            resolve(id);
          }
        }
      );
    }).catch(async (err) => {
      // Download never started: revoke immediately so we don't leak the Blob URL.
      try {
        await sendToOffscreen({ type: "ECHO_OFFSCREEN_REVOKE", url: blobUrl });
      } catch (_) {}
      await closeOffscreenIfIdle();
      throw err;
    });

    pendingDownloads.set(downloadId, { url: blobUrl });
    return downloadId;
  }

  async function revokeAndCleanup(downloadId) {
    const entry = pendingDownloads.get(downloadId);
    if (!entry) return;
    pendingDownloads.delete(downloadId);
    try {
      await sendToOffscreen({ type: "ECHO_OFFSCREEN_REVOKE", url: entry.url });
    } catch (_) {}
    await closeOffscreenIfIdle();
  }

  if (typeof chrome !== "undefined" && chrome.runtime) {
    if (chrome.runtime.onInstalled) {
      chrome.runtime.onInstalled.addListener(() => {
        enableSidePanelOnClick();
        refreshExistingDeepSeekTabs();
      });
    }
    if (chrome.runtime.onStartup) {
      chrome.runtime.onStartup.addListener(enableSidePanelOnClick);
    }
    enableSidePanelOnClick();

    // Revoke each Blob URL precisely when its download completes or is interrupted.
    if (chrome.downloads && chrome.downloads.onChanged) {
      chrome.downloads.onChanged.addListener((delta) => {
        if (!delta || !delta.state || !delta.state.current) return;
        const state = delta.state.current;
        if (state === "complete" || state === "interrupted") {
          revokeAndCleanup(delta.id);
        }
      });
    }

    if (chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || sender.id !== chrome.runtime.id) return false;
        // Ignore messages addressed to the offscreen document.
        if (msg.target === "offscreen") return false;

        // Chunked large-file download channel (capsule -> SW -> offscreen).
        if (msg.type === "ECHO_DL_BEGIN") {
          try {
            downloadBuffer.begin(msg.transferId, {
              filename: msg.filename,
              mimeType: msg.mimeType,
              total: msg.total,
            });
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
          return true;
        }
        if (msg.type === "ECHO_DL_CHUNK") {
          try {
            downloadBuffer.chunk(msg.transferId, msg.index, msg.data);
            sendResponse({ ok: true });
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
          return true;
        }
        if (msg.type === "ECHO_DL_END") {
          finalizeTransfer(msg.transferId)
            .then((downloadId) => sendResponse({ ok: true, downloadId }))
            .catch((err) => sendResponse({ ok: false, error: err.message }));
          return true;
        }

        // Backward-compatible single-shot path (small payloads / no offscreen support).
        if (msg.type === "ECHO_DOWNLOAD") {
          const url = textToDataUrl(msg.content, msg.mimeType);
          chrome.downloads.download(
            {
              url,
              filename: String(msg.filename || "echo_export.txt"),
              saveAs: false,
              conflictAction: "uniquify",
            },
            (downloadId) => {
              if (chrome.runtime.lastError || !downloadId) {
                sendResponse({
                  ok: false,
                  error: chrome.runtime.lastError?.message || "下载失败",
                });
              } else {
                sendResponse({ ok: true, downloadId });
              }
            }
          );
          return true;
        }
        return false;
      });
    }
  }

  return { textToDataUrl, createDownloadBuffer, assembleChunks };
});
