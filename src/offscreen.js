/**
 * EchoArchive Offscreen Document
 *
 * The MV3 service worker has no DOM and therefore no URL.createObjectURL. This hidden
 * offscreen document (reason: BLOBS) assembles the export text into a Blob and hands the
 * SW a Blob URL for chrome.downloads.download, then revokes it on the SW's instruction
 * once the download completes or is interrupted. No network, no storage, no cookies.
 */
(function () {
  "use strict";

  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.onMessage) return;

  // Track live Blob URLs so we only revoke URLs we actually created.
  const liveUrls = new Set();

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== "offscreen") return false;
    if (sender.id && sender.id !== chrome.runtime.id) return false;

    if (msg.type === "ECHO_OFFSCREEN_BUILD") {
      try {
        const blob = new Blob([String(msg.content == null ? "" : msg.content)], {
          type: String(msg.mimeType || "text/plain;charset=utf-8"),
        });
        const url = URL.createObjectURL(blob);
        liveUrls.add(url);
        sendResponse({ ok: true, url });
      } catch (err) {
        sendResponse({ ok: false, error: (err && err.message) || "Blob 构建失败" });
      }
      return true;
    }

    if (msg.type === "ECHO_OFFSCREEN_REVOKE") {
      try {
        if (msg.url) {
          URL.revokeObjectURL(msg.url);
          liveUrls.delete(msg.url);
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: (err && err.message) || "revoke 失败" });
      }
      return true;
    }

    return false;
  });
})();
