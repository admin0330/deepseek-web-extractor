/**
 * Shared browser/Node WebCrypto AES-256-GCM envelope and reversible pseudonymizer.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.EchoCrypto = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const KDF_ITERATIONS = 250000;
  const ENVELOPE_FORMAT = "echo-archive-encrypted-v1";
  const PLAIN_FORMAT = "echo-archive-plain-v1";
  const STEALTH_VERSION = 2;
  const STEALTH_MAGIC_0 = 0xe4;
  const STEALTH_MAGIC_1 = 0xa9;
  const MODE_SELF_SEALED = 0x11;
  const MODE_PASSPHRASE = 0x12;

  const STEALTH_CIPHER_MODES = {
    [MODE_SELF_SEALED]: {
      id: MODE_SELF_SEALED,
      code: "a256g-hs256-seal",
      cipher: "AES-256-GCM",
      kdf: "HMAC-SHA256",
      keyMode: "self-sealed",
      kdfProfile: 0x01,
      iterations: 1,
    },
    [MODE_PASSPHRASE]: {
      id: MODE_PASSPHRASE,
      code: "a256g-pbkdf2-pass",
      cipher: "AES-256-GCM",
      kdf: "PBKDF2-SHA256",
      keyMode: "passphrase",
      kdfProfile: 0x25,
      iterations: KDF_ITERATIONS,
    },
  };

  // Internal 256-bit byte seeds used only for stealth header masking and auto self-sealing.
  const MASK_SEED_BYTES = new Uint8Array([
    0x9f, 0x3c, 0xe1, 0x54, 0x8b, 0x27, 0xd6, 0x61, 0xa4, 0x19, 0x7e, 0xc2, 0x35, 0xf8, 0x4d, 0x0b,
    0x6e, 0xd3, 0x1a, 0x89, 0x42, 0xf0, 0x5c, 0xb7, 0x28, 0x91, 0xe4, 0x0f, 0x73, 0xc5, 0x3b, 0xa2,
  ]);
  const SEAL_ROOT_BYTES = new Uint8Array([
    0x47, 0xbe, 0x12, 0xd9, 0x85, 0x63, 0xf4, 0x0a, 0xc8, 0x31, 0x5e, 0x97, 0x2d, 0xab, 0x74, 0xe6,
    0x18, 0x7f, 0xa3, 0x52, 0xce, 0x09, 0x84, 0xd1, 0x6b, 0x24, 0x9d, 0xf5, 0x3e, 0x80, 0x4c, 0xb6,
  ]);

  const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const ID_CARD_RE = /(?<!\d)\d{17}[\dXx](?!\d)/g;

  function getSubtleCrypto() {
    if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) {
      return globalThis.crypto;
    }
    throw new Error("WebCrypto API (crypto.subtle) is unavailable in this environment.");
  }

  function bytesToBase64(bytes) {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(bytes).toString("base64");
    }
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToBytes(b64) {
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(b64, "base64"));
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  async function deriveAesKey(passphrase, saltBytes, usages, iterations = KDF_ITERATIONS) {
    // Wire protocol is unchanged: all historical envelopes/stealth packages were written
    // with KDF_ITERATIONS (250000). This optional parameter only lets decryptPayload honor
    // an envelope's own `iterations` field so JS matches Python / renderer.py byte-for-byte,
    // without altering any salt/iv/ciphertext layout. Absurd values are rejected.
    const iters = Math.trunc(Number(iterations));
    if (!Number.isFinite(iters) || iters < 1000 || iters > 10000000) {
      throw new Error("Invalid PBKDF2 iteration count.");
    }
    const cryptoObj = getSubtleCrypto();
    const enc = new TextEncoder();
    const baseKey = await cryptoObj.subtle.importKey(
      "raw",
      enc.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return cryptoObj.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: saltBytes,
        iterations: iters,
        hash: "SHA-256",
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      usages
    );
  }

  /**
   * Encrypt any JSON-serializable payload with PBKDF2-SHA256 + AES-256-GCM.
   */
  async function encryptPayload(payloadObj, passphrase, publicStats = {}) {
    if (!passphrase || passphrase.length < 4) {
      throw new Error("加密口令长度至少需要 4 个字符。");
    }
    const cryptoObj = getSubtleCrypto();
    const salt = cryptoObj.getRandomValues(new Uint8Array(16));
    const iv = cryptoObj.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(passphrase, salt, ["encrypt"]);
    const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj));
    const encryptedBuf = await cryptoObj.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      plaintext
    );

    return {
      format: ENVELOPE_FORMAT,
      kdf: "PBKDF2-SHA256",
      iterations: KDF_ITERATIONS,
      cipher: "AES-256-GCM",
      salt_b64: bytesToBase64(salt),
      iv_b64: bytesToBase64(iv),
      ciphertext_b64: bytesToBase64(new Uint8Array(encryptedBuf)),
      stats: publicStats,
      created_at: new Date().toISOString(),
    };
  }

  function concatBytes(...chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlToBytes(text) {
    const clean = String(text || "").replace(/\s+/g, "");
    if (!clean || !/^[A-Za-z0-9_-]+$/.test(clean) || clean.length % 4 === 1) {
      return null;
    }
    const padLen = (4 - (clean.length % 4)) % 4;
    const b64 = clean.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
    return base64ToBytes(b64);
  }

  function wrapCompactText(str, width = 76) {
    const out = [];
    for (let i = 0; i < str.length; i += width) {
      out.push(str.slice(i, i + width));
    }
    return out.join("\n");
  }

  async function deriveHeaderMask(nonceSeed) {
    const cryptoObj = getSubtleCrypto();
    const digest = await cryptoObj.subtle.digest("SHA-256", concatBytes(MASK_SEED_BYTES, nonceSeed));
    return new Uint8Array(digest).subarray(0, 8);
  }

  async function deriveAutoSealKey(saltBytes, nonceSeed, metaPrefix6, usages) {
    const cryptoObj = getSubtleCrypto();
    const hmacKey = await cryptoObj.subtle.importKey(
      "raw",
      SEAL_ROOT_BYTES,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const derivedRaw = await cryptoObj.subtle.sign(
      "HMAC",
      hmacKey,
      concatBytes(saltBytes, nonceSeed, metaPrefix6)
    );
    return cryptoObj.subtle.importKey(
      "raw",
      derivedRaw,
      { name: "AES-GCM", length: 256 },
      false,
      usages
    );
  }

  /**
   * Inspect an opaque .echo package and decode its masked encryption method marker.
   * Returns null if input is not a valid stealth v2 package.
   */
  async function inspectStealthPackage(rawText) {
    if (typeof rawText !== "string") return null;
    const bytes = base64UrlToBytes(rawText);
    if (!bytes || bytes.length < 68) return null;

    const nonceSeed = bytes.subarray(0, 16);
    const maskedMeta = bytes.subarray(16, 24);
    const mask = await deriveHeaderMask(nonceSeed);
    const meta = new Uint8Array(8);
    for (let i = 0; i < 8; i += 1) {
      meta[i] = maskedMeta[i] ^ mask[i];
    }

    if (meta[0] !== STEALTH_MAGIC_0 || meta[1] !== STEALTH_MAGIC_1 || meta[2] !== STEALTH_VERSION) {
      return null;
    }
    const expectChk0 = (meta[0] ^ meta[2] ^ meta[4] ^ 0x5a) & 0xff;
    const expectChk1 = (meta[1] ^ meta[3] ^ meta[5] ^ 0xa5) & 0xff;
    if (meta[6] !== expectChk0 || meta[7] !== expectChk1) {
      return null;
    }

    const modeInfo = STEALTH_CIPHER_MODES[meta[3]];
    if (!modeInfo || meta[4] !== modeInfo.kdfProfile) {
      return null;
    }

    return {
      isStealthPackage: true,
      version: STEALTH_VERSION,
      cipherId: meta[3],
      kdfProfileId: meta[4],
      flags: meta[5],
      hasRestoreMap: Boolean(meta[5] & 0x01),
      methodCode: modeInfo.code,
      cipher: modeInfo.cipher,
      kdf: modeInfo.kdf,
      keyMode: modeInfo.keyMode,
      iterations: modeInfo.iterations,
      byteLength: bytes.length,
    };
  }

  /**
   * Seal any JSON-serializable payload into an opaque .echo stealth binary container
   * with no visible JSON keys, algorithm strings, or file magic headers.
   */
  async function sealStealthPackage(payloadObj, passphrase = "", options = {}) {
    const pass = String(passphrase || "");
    const hasPass = pass.length > 0;
    if (hasPass && pass.length < 4) {
      throw new Error("加密口令长度至少需要 4 个字符。");
    }

    const modeInfo = STEALTH_CIPHER_MODES[hasPass ? MODE_PASSPHRASE : MODE_SELF_SEALED];
    const cryptoObj = getSubtleCrypto();
    const nonceSeed = cryptoObj.getRandomValues(new Uint8Array(16));
    const salt = cryptoObj.getRandomValues(new Uint8Array(16));
    const iv = cryptoObj.getRandomValues(new Uint8Array(12));

    const flags = (options && options.hasRestoreMap ? 0x01 : 0x00) | 0x02;
    const plainMeta = new Uint8Array([
      STEALTH_MAGIC_0,
      STEALTH_MAGIC_1,
      STEALTH_VERSION,
      modeInfo.id,
      modeInfo.kdfProfile,
      flags,
      0,
      0,
    ]);
    plainMeta[6] = (plainMeta[0] ^ plainMeta[2] ^ plainMeta[4] ^ 0x5a) & 0xff;
    plainMeta[7] = (plainMeta[1] ^ plainMeta[3] ^ plainMeta[5] ^ 0xa5) & 0xff;

    const mask = await deriveHeaderMask(nonceSeed);
    const maskedMeta = new Uint8Array(8);
    for (let i = 0; i < 8; i += 1) {
      maskedMeta[i] = plainMeta[i] ^ mask[i];
    }

    const aad = concatBytes(nonceSeed, maskedMeta, salt);
    const key =
      modeInfo.id === MODE_PASSPHRASE
        ? await deriveAesKey(pass, salt, ["encrypt"], modeInfo.iterations)
        : await deriveAutoSealKey(salt, nonceSeed, plainMeta.subarray(0, 6), ["encrypt"]);

    const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj));
    const encryptedBuf = await cryptoObj.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      plaintext
    );

    const wired = concatBytes(aad, iv, new Uint8Array(encryptedBuf));
    return wrapCompactText(bytesToBase64Url(wired), 76) + "\n";
  }

  /**
   * Open an opaque .echo stealth container back into its decoded JSON payload.
   */
  async function openStealthPackage(rawText, passphrase = "") {
    const info = await inspectStealthPackage(rawText);
    if (!info) {
      throw new Error("无效的隐性加密归档格式。");
    }
    const bytes = base64UrlToBytes(rawText);
    const nonceSeed = bytes.subarray(0, 16);
    const maskedMeta = bytes.subarray(16, 24);
    const salt = bytes.subarray(24, 40);
    const iv = bytes.subarray(40, 52);
    const ciphertext = bytes.subarray(52);
    const aad = bytes.subarray(0, 40);

    const mask = await deriveHeaderMask(nonceSeed);
    const plainMetaPrefix = new Uint8Array(6);
    for (let i = 0; i < 6; i += 1) {
      plainMetaPrefix[i] = maskedMeta[i] ^ mask[i];
    }

    let key;
    if (info.cipherId === MODE_PASSPHRASE) {
      if (!passphrase) {
        throw new Error("该加密包设置了自定义口令，请填写解密口令。");
      }
      key = await deriveAesKey(String(passphrase), salt, ["decrypt"], info.iterations);
    } else {
      key = await deriveAutoSealKey(salt, nonceSeed, plainMetaPrefix, ["decrypt"]);
    }

    const cryptoObj = getSubtleCrypto();
    const decryptedBuf = await cryptoObj.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      ciphertext
    );
    return JSON.parse(new TextDecoder().decode(decryptedBuf));
  }

  /**
   * Decrypt either a stealth .echo package or a legacy echo-archive-encrypted-v1 JSON envelope.
   */
  async function decryptPayload(envelopeOrRaw, passphrase = "") {
    if (typeof envelopeOrRaw === "string") {
      const trimmed = envelopeOrRaw.trim();
      if (trimmed.startsWith("{")) {
        envelopeOrRaw = JSON.parse(trimmed);
      } else {
        return openStealthPackage(trimmed, passphrase);
      }
    }
    const envelope = envelopeOrRaw;
    if (!envelope || envelope.format !== ENVELOPE_FORMAT) {
      throw new Error("无效的加密包格式。");
    }
    const cryptoObj = getSubtleCrypto();
    const salt = base64ToBytes(envelope.salt_b64);
    const iv = base64ToBytes(envelope.iv_b64);
    const ciphertext = base64ToBytes(envelope.ciphertext_b64);
    const key = await deriveAesKey(passphrase, salt, ["decrypt"], envelope.iterations || KDF_ITERATIONS);
    const decryptedBuf = await cryptoObj.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return JSON.parse(new TextDecoder().decode(decryptedBuf));
  }

  /**
   * Parse user-entered alias rules like:
   *   林屿 -> [U_NAME]
   *   上海
   */
  function parseAliasRulesText(rawText) {
    const rules = [];
    let autoCounter = 1;
    const seenOriginals = new Set();

    for (const rawLine of String(rawText || "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      let original = line;
      let alias = "";
      const arrowIdx = line.indexOf("->");
      if (arrowIdx !== -1) {
        original = line.slice(0, arrowIdx).trim();
        alias = line.slice(arrowIdx + 2).trim();
      } else {
        const eqIdx = line.indexOf("=");
        if (eqIdx !== -1) {
          original = line.slice(0, eqIdx).trim();
          alias = line.slice(eqIdx + 1).trim();
        }
      }

      if (!original || seenOriginals.has(original)) continue;
      seenOriginals.add(original);
      if (!alias) {
        alias = `[ALIAS_${autoCounter}]`;
        autoCounter += 1;
      }
      rules.push({ original, alias });
    }

    // Replace longest strings first to avoid partial shadowing.
    rules.sort((a, b) => b.original.length - a.original.length);
    return rules;
  }

  /**
   * Locally replace PII and custom terms, returning sanitized messages + local restore map.
   */
  function pseudonymizeMessages(messages, options = {}) {
    const maskPii = options.maskPii !== false;
    const customRules = parseAliasRulesText(options.aliasRulesText || "");
    const restoreEntries = {};
    let replacedTurns = 0;

    function applyMapAndRecord(text, regex, prefix) {
      let idx = 1;
      return text.replace(regex, (match) => {
        for (const [token, orig] of Object.entries(restoreEntries)) {
          if (orig === match) return token;
        }
        let token = `[${prefix}_${idx}]`;
        while (Object.prototype.hasOwnProperty.call(restoreEntries, token)) {
          idx += 1;
          token = `[${prefix}_${idx}]`;
        }
        restoreEntries[token] = match;
        return token;
      });
    }

    const sanitized = messages.map((msg) => {
      let content = String(msg.content || "");
      let thinking = String(msg.thinking || "");
      const beforeContent = content;
      const beforeThinking = thinking;

      if (maskPii) {
        content = applyMapAndRecord(content, PHONE_RE, "PHONE");
        content = applyMapAndRecord(content, EMAIL_RE, "EMAIL");
        content = applyMapAndRecord(content, ID_CARD_RE, "ID");
        thinking = applyMapAndRecord(thinking, PHONE_RE, "PHONE");
        thinking = applyMapAndRecord(thinking, EMAIL_RE, "EMAIL");
        thinking = applyMapAndRecord(thinking, ID_CARD_RE, "ID");
      }

      for (const { original, alias } of customRules) {
        if (content.includes(original) || thinking.includes(original)) {
          restoreEntries[alias] = original;
          content = content.split(original).join(alias);
          thinking = thinking.split(original).join(alias);
        }
      }

      if (content !== beforeContent || thinking !== beforeThinking) {
        replacedTurns += 1;
      }

      return {
        ...msg,
        content,
        thinking,
      };
    });

    return {
      messages: sanitized,
      replacedTurns,
      restoreMap: {
        format: "echo-restore-map-v1",
        created_at: new Date().toISOString(),
        entries: restoreEntries,
      },
    };
  }

  /**
   * Restore pseudonymized tokens back to original strings locally in browser.
   */
  function restoreTextFromMap(text, restoreMap) {
    const entries = (restoreMap && restoreMap.entries) || {};
    let result = String(text || "");
    const tokens = Object.keys(entries).sort((a, b) => b.length - a.length);
    for (const token of tokens) {
      result = result.split(token).join(entries[token]);
    }
    return result;
  }

  function formatMarkdownExport(bundle) {
    const lines = [
      `# ${bundle.title || "DeepSeek 对话导出"}`,
      "",
      `- **来源地址**：${bundle.url || ""}`,
      `- **导出时间**：${bundle.exported_at || ""}`,
      `- **总消息数**：${(bundle.messages || []).length}`,
      "",
    ];

    for (const msg of bundle.messages || []) {
      const heading = msg.role === "user" ? "### User" : "### DeepSeek";
      lines.push(heading);
      if (msg.thinking) {
        lines.push("<details>", "<summary>深度思考</summary>", "", msg.thinking, "", "</details>", "");
      }
      lines.push(msg.content || "", "");
    }
    return lines.join("\n").trim() + "\n";
  }

  return {
    ENVELOPE_FORMAT,
    PLAIN_FORMAT,
    KDF_ITERATIONS,
    STEALTH_VERSION,
    MODE_SELF_SEALED,
    MODE_PASSPHRASE,
    STEALTH_CIPHER_MODES,
    encryptPayload,
    decryptPayload,
    sealStealthPackage,
    inspectStealthPackage,
    openStealthPackage,
    parseAliasRulesText,
    pseudonymizeMessages,
    restoreTextFromMap,
    formatMarkdownExport,
  };
});
