import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const EchoCrypto = require(path.resolve(__dirname, "../src/crypto_utils.js"));
const Extractor = require(path.resolve(__dirname, "../src/content_extractor.js"));
const Background = require(path.resolve(__dirname, "../src/background.js"));
// export_core captures root.EchoCrypto at load time (as the browser bundle does),
// so publish it as a global before requiring it.
globalThis.EchoCrypto = EchoCrypto;
const Core = require(path.resolve(__dirname, "../src/export_core.js"));

// Minimal DOM stub sufficient to exercise domToMarkdown and extractSnapshot without external packages.
function createMockNode({
  nodeType = 1,
  tagName = "div",
  className = "",
  attrs = {},
  text = "",
  children = [],
} = {}) {
  const classSet = new Set(className.split(/\s+/).filter(Boolean));
  const node = {
    nodeType,
    tagName: tagName.toUpperCase(),
    className,
    nodeValue: nodeType === 3 ? text : null,
    parentElement: null,
    previousElementSibling: null,
    childNodes: [],
    get children() {
      return this.childNodes.filter((c) => c.nodeType === 1);
    },
    get textContent() {
      if (this.nodeType === 3) return this.nodeValue || "";
      return this.childNodes.map((c) => c.textContent).join("");
    },
    get innerText() {
      return this.textContent;
    },
    classList: {
      contains: (cls) => classSet.has(cls),
    },
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    setAttribute: (name, val) => {
      attrs[name] = String(val);
    },
    matches: (selector) => {
      return selector.split(",").some((part) => {
        const s = part.trim();
        if (s.startsWith(".")) return classSet.has(s.slice(1));
        if (s === "[data-virtual-list-item-key]") return Boolean(attrs["data-virtual-list-item-key"]);
        if (s === '[role="button"]') return attrs.role === "button";
        return tagName.toLowerCase() === s.toLowerCase();
      });
    },
    querySelectorAll: (selector) => {
      const out = [];
      const visit = (cur) => {
        for (const child of cur.childNodes) {
          if (child.nodeType === 1) {
            if (child.matches(selector)) out.push(child);
            visit(child);
          }
        }
      };
      visit(node);
      return out;
    },
    querySelector: (selector) => node.querySelectorAll(selector)[0] || null,
    closest: (selector) => {
      let cur = node.parentElement;
      while (cur) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    cloneNode: () =>
      createMockNode({
        nodeType,
        tagName,
        className,
        attrs: { ...attrs },
        text,
        children: children.map((c) => (c.cloneNode ? c.cloneNode(true) : c)),
      }),
    remove: () => {
      if (!node.parentElement) return;
      node.parentElement.childNodes = node.parentElement.childNodes.filter((c) => c !== node);
    },
  };

  for (const ch of children) {
    ch.parentElement = node;
    node.childNodes.push(ch);
  }
  for (let i = 1; i < node.children.length; i += 1) {
    node.children[i].previousElementSibling = node.children[i - 1];
  }
  return node;
}

const el = (tagName, opts = {}, children = []) =>
  createMockNode({
    nodeType: 1,
    tagName,
    className: opts.className || "",
    attrs: opts.attrs || {},
    children,
  });

const txt = (text) => createMockNode({ nodeType: 3, text });

test("encryptPayload and decryptPayload round-trip cleanly", async () => {
  const sample = {
    format: EchoCrypto.PLAIN_FORMAT,
    title: "深夜对话",
    messages: [{ role: "user", content: "晚安，渡", thinking: "" }],
  };
  const envelope = await EchoCrypto.encryptPayload(sample, "secret-pass-99", { turns: 1 });
  assert.equal(envelope.format, "echo-archive-encrypted-v1");
  assert.equal(envelope.cipher, "AES-256-GCM");
  assert.equal(JSON.stringify(envelope).includes("晚安"), false);

  const decrypted = await EchoCrypto.decryptPayload(envelope, "secret-pass-99");
  assert.deepEqual(decrypted, sample);

  await assert.rejects(() => EchoCrypto.decryptPayload(envelope, "wrong-pass"));
});

test("sealStealthPackage hides encryption headers/algorithms, detects tampering, and round-trips self-sealed + passphrase modes", async () => {
  const sample = {
    format: EchoCrypto.PLAIN_FORMAT,
    title: "隐性加密测试",
    messages: [{ role: "user", content: "我在[CITY_1]等你，[U_NAME]", thinking: "" }],
    restore_map: {
      format: "echo-restore-map-v1",
      entries: { "[CITY_1]": "某市", "[U_NAME]": "张三" },
    },
  };

  // 1. Default passwordless self-sealed mode
  const sealedA = await EchoCrypto.sealStealthPackage(sample, "", { hasRestoreMap: true });
  const sealedB = await EchoCrypto.sealStealthPackage(sample, "", { hasRestoreMap: true });
  assert.notEqual(sealedA, sealedB);
  for (const forbidden of ["AES", "PBKDF2", "echo", "cipher", "salt", "{", "}"]) {
    assert.equal(sealedA.toLowerCase().includes(forbidden.toLowerCase()), false);
  }
  assert.notEqual(sealedA.slice(0, 12), sealedB.slice(0, 12));

  const metaAuto = await EchoCrypto.inspectStealthPackage(sealedA);
  assert.equal(metaAuto.isStealthPackage, true);
  assert.equal(metaAuto.version, 2);
  assert.equal(metaAuto.cipher, "AES-256-GCM");
  assert.equal(metaAuto.kdf, "HMAC-SHA256");
  assert.equal(metaAuto.keyMode, "self-sealed");
  assert.equal(metaAuto.hasRestoreMap, true);

  const openedAuto = await EchoCrypto.decryptPayload(sealedA);
  assert.deepEqual(openedAuto, sample);

  // Header tamper detection via GCM AAD
  const mutatedChar = sealedA[24] === "A" ? "B" : "A";
  const tampered = sealedA.slice(0, 24) + mutatedChar + sealedA.slice(25);
  await assert.rejects(() => EchoCrypto.openStealthPackage(tampered));

  // 2. Optional custom passphrase mode
  const sealedPass = await EchoCrypto.sealStealthPackage(sample, "custom-pass-88", {
    hasRestoreMap: true,
  });
  const metaPass = await EchoCrypto.inspectStealthPackage(sealedPass);
  assert.equal(metaPass.cipher, "AES-256-GCM");
  assert.equal(metaPass.kdf, "PBKDF2-SHA256");
  assert.equal(metaPass.keyMode, "passphrase");
  assert.equal(metaPass.iterations, 250000);

  await assert.rejects(() => EchoCrypto.decryptPayload(sealedPass, ""));
  await assert.rejects(() => EchoCrypto.decryptPayload(sealedPass, "wrong-pass"));
  const openedPass = await EchoCrypto.decryptPayload(sealedPass, "custom-pass-88");
  assert.deepEqual(openedPass, sample);
});

test("pseudonymizeMessages replaces PII and custom aliases reversibly", () => {
  const messages = [
    {
      role: "user",
      content: "我是张三，手机13800138000，在某市等小明。",
      thinking: "",
    },
    {
      role: "assistant",
      content: "记住了，张三，今晚某市风大。",
      thinking: "用户张三在某市",
    },
  ];
  const { messages: masked, replacedTurns, restoreMap } = EchoCrypto.pseudonymizeMessages(
    messages,
    {
      maskPii: true,
      aliasRulesText: "张三 -> [U_NAME]\n小明 -> [NICK_1]\n某市 -> [CITY_1]",
    }
  );

  assert.equal(replacedTurns, 2);
  assert.equal(masked[0].content.includes("张三"), false);
  assert.equal(masked[0].content.includes("13800138000"), false);
  assert.equal(masked[0].content.includes("[U_NAME]"), true);
  assert.equal(masked[0].content.includes("[NICK_1]"), true);
  assert.equal(masked[1].thinking.includes("张三"), false);

  const restored = EchoCrypto.restoreTextFromMap(masked[0].content, restoreMap);
  assert.equal(restored, messages[0].content);
});

test("extractSnapshot extracts DeepSeek DOM turns, thinking blocks, code fences, and strips cites", () => {
  const mockDoc = el("div", {}, [
    el(
      "div",
      { className: "ds-message", attrs: { "data-virtual-list-item-key": "1" } },
      [
        el("div", { className: "fbb737a4" }, [
          el("div", { className: "ds-collapsible-text" }, [txt("写一段快速问候，别说教。")]),
        ]),
      ]
    ),
    el(
      "div",
      { className: "ds-message", attrs: { "data-virtual-list-item-key": "2" } },
      [
        el("div", { className: "ds-think-content" }, [el("p", {}, [txt("保持极简短句")])]),
        el("div", { className: "ds-markdown" }, [
          el("p", {}, [
            txt("灯留着呢。"),
            el("span", { className: "ds-markdown-cite" }, [txt("1")]),
          ]),
          el("pre", {}, [el("code", { className: "language-python" }, [txt("print('hi')")])]),
        ]),
      ]
    ),
  ]);

  const snap = Extractor.extractSnapshot(mockDoc);
  assert.equal(snap.strategy, "virtual-list-key");
  assert.equal(snap.messages.length, 2);
  assert.equal(snap.messages[0].role, "user");
  assert.equal(snap.messages[0].content, "写一段快速问候，别说教。");
  assert.equal(snap.messages[1].role, "assistant");
  assert.equal(snap.messages[1].thinking, "保持极简短句");
  assert.match(snap.messages[1].content, /^灯留着呢。/);
  assert.doesNotMatch(snap.messages[1].content, /灯留着呢。1/);
  assert.match(snap.messages[1].content, /```python\nprint\('hi'\)\n```/);
});

test("extractSnapshot handles real DeepSeek wrapper rows, md-code-block banners, cite anchors, and image turns", () => {
  const mockDoc = el("div", {}, [
    // Turn 1: image-only user message with sibling action bar
    el("div", { className: "_9663006", attrs: { "data-virtual-list-item-key": "3" } }, [
      el("div", { className: "d29f3d7d ds-message _63c77b1" }, [
        el("div", { className: "eafda4ae" }, [
          el("img", { attrs: { alt: "screenshot.webp" } }),
        ]),
      ]),
      el("div", { className: "_11d6b3a" }, [el("div", { className: "dd7e4fda" }, [txt("1 / 1")])]),
    ]),
    // Turn 2: assistant message with search banner, cite inside <a>, and .md-code-block without <code>
    el("div", { className: "_4f9bf79", attrs: { "data-virtual-list-item-key": "4" } }, [
      el("div", { className: "ds-message _63c77b1" }, [
        el("div", { className: "_74c0879" }, [txt("搜索到 12 个网页")]),
        el("div", { className: "ds-markdown ds-assistant-message-main-content" }, [
          el("p", {}, [
            txt("先检查卷组状态"),
            el("a", { attrs: { href: "https://example.com/lvm#1" } }, [
              el("span", { className: "ds-markdown-cite" }, [
                el("span", {}, [txt("-")]),
                el("span", {}, [txt("1")]),
              ]),
            ]),
            txt("。"),
          ]),
          el("div", { className: "md-code-block md-code-block-dark" }, [
            el("div", { className: "md-code-block-banner-wrap" }, [
              el("div", { className: "md-code-block-banner" }, [
                el("span", { className: "d813de27" }, [txt("bash")]),
                el("div", { className: "ds-button", attrs: { role: "button" } }, [
                  el("span", { className: "code-info-button-text" }, [txt("复制")]),
                ]),
                el("div", { className: "ds-button", attrs: { role: "button" } }, [
                  el("span", { className: "code-info-button-text" }, [txt("下载")]),
                ]),
              ]),
            ]),
            el("pre", {}, [el("span", {}, [txt("sudo vgs\nsudo lvs")])]),
            el("svg", {}, [el("path", {})]),
          ]),
        ]),
        el("div", { className: "f93f59e4" }, [txt("12 个网页")]),
      ]),
    ]),
    // Turn 3: user message with image + text + branch paginator "3 / 3" in sibling bar
    el("div", { className: "_9663006", attrs: { "data-virtual-list-item-key": "13" } }, [
      el("div", { className: "d29f3d7d ds-message _63c77b1" }, [
        el("div", { className: "eafda4ae" }, [
          el("img", { attrs: { alt: "disk.webp" } }),
        ]),
        el("div", { className: "fbb737a4" }, [
          el("div", { className: "ds-collapsible-text" }, [txt("storage-vo 是另外的盘")]),
        ]),
      ]),
      el("div", { className: "_11d6b3a" }, [el("div", { className: "dd7e4fda" }, [txt("3 / 3")])]),
    ]),
  ]);

  const snap = Extractor.extractSnapshot(mockDoc);
  assert.equal(snap.strategy, "virtual-list-key");
  assert.equal(snap.messages.length, 3);

  assert.equal(snap.messages[0].role, "user");
  assert.equal(snap.messages[0].content, "[附件图片: screenshot.webp]");

  assert.equal(snap.messages[1].role, "assistant");
  assert.doesNotMatch(snap.messages[1].content, /搜索到 12 个网页/);
  assert.doesNotMatch(snap.messages[1].content, /https:\/\/example\.com\/lvm/);
  assert.doesNotMatch(snap.messages[1].content, /复制|下载/);
  assert.match(snap.messages[1].content, /^先检查卷组状态。/);
  assert.match(snap.messages[1].content, /```bash\nsudo vgs\nsudo lvs\n```/);

  assert.equal(snap.messages[2].role, "user");
  assert.equal(snap.messages[2].content, "[附件图片: disk.webp]\n\nstorage-vo 是另外的盘");
  assert.doesNotMatch(snap.messages[2].content, /3 \/ 3/);
});

test("domToMarkdown preserves KaTeX, backtick-safe code fences, and tables", () => {
  const mdRoot = el("div", { className: "ds-markdown" }, [
    el("p", {}, [
      txt("行内公式 "),
      el("span", { className: "katex" }, [
        el("annotation", { attrs: { encoding: "application/x-tex" } }, [txt("E = mc^2")]),
      ]),
      txt(" 与行内代码 "),
      el("code", {}, [txt("a`b")]),
    ]),
    el("div", { className: "katex-display" }, [
      el("annotation", { attrs: { encoding: "application/x-tex" } }, [txt("\\int_0^1 x\\,dx")]),
    ]),
    el("div", { className: "md-code-block" }, [
      el("div", { className: "md-code-block-banner-wrap" }, [
        el("div", { className: "md-code-block-banner" }, [el("span", {}, [txt("markdown")])]),
      ]),
      el("pre", {}, [txt("```js\nconsole.log(1)\n```")]),
    ]),
    el("table", {}, [
      el("tr", {}, [el("th", {}, [txt("项目")]), el("th", {}, [txt("值")])]),
      el("tr", {}, [el("td", {}, [txt("A|B")]), el("td", {}, [txt("100")])]),
    ]),
  ]);

  const md = Extractor.domToMarkdown(mdRoot);
  assert.match(md, /\$E = mc\^2\$/);
  assert.match(md, /``a`b``/);
  assert.match(md, /\$\$\n\\int_0\^1 x\\,dx\n\$\$/);
  assert.match(md, /````markdown\n```js\nconsole\.log\(1\)\n```\n````/);
  assert.match(md, /\| 项目 \| 值 \|/);
  assert.match(md, /\| A\\\|B \| 100 \|/);
});

test("runInPage inspects metrics and executes background job lifecycle", async () => {
  const prevDoc = globalThis.document;
  const prevLoc = globalThis.location;
  const mockDoc = el("div", {}, [
    el("div", { className: "_9663006", attrs: { "data-virtual-list-item-key": "1" } }, [
      el("div", { className: "ds-message" }, [
        el("div", { className: "ds-collapsible-text" }, [txt("今天外面在下雨")]),
      ]),
    ]),
    el("div", { className: "_4f9bf79", attrs: { "data-virtual-list-item-key": "2" } }, [
      el("div", { className: "ds-message" }, [
        el("div", { className: "ds-think-content" }, [el("p", {}, [txt("先接住情绪")])]),
        el("div", { className: "ds-markdown" }, [el("p", {}, [txt("伞我给你留门口了。")])]),
      ]),
    ]),
  ]);
  mockDoc.title = "雨夜对话 - DeepSeek";
  mockDoc.body = mockDoc;
  mockDoc.documentElement = mockDoc;
  mockDoc.scrollingElement = {
    scrollTop: 0,
    scrollHeight: 400,
    clientHeight: 800,
  };

  try {
    globalThis.document = mockDoc;
    globalThis.location = {
      href: "https://chat.deepseek.com/a/chat/s/demo",
      hostname: "chat.deepseek.com",
    };

    const inspected = await Extractor.runInPage({ mode: "inspect", probeSelectors: true });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.isDeepSeek, true);
    assert.equal(inspected.title, "雨夜对话");
    assert.equal(inspected.count, 2);
    assert.equal(inspected.thinkingCount, 1);
    assert.equal(inspected.selectorProbe.markdownMatches, 1);

    const started = await Extractor.runInPage({
      mode: "startJob",
      autoScroll: false,
      showHud: false,
    });
    assert.equal(started.status, "running");

    await new Promise((r) => setTimeout(r, 20));
    const polled = await Extractor.runInPage({ mode: "pollJob" });
    assert.equal(polled.status, "done");
    assert.equal(polled.result.messages.length, 2);
    assert.equal(polled.result.messages[1].thinking, "先接住情绪");

    await Extractor.runInPage({ mode: "clearJob" });
    const afterClear = await Extractor.runInPage({ mode: "pollJob" });
    assert.equal(afterClear.status, "idle");
  } finally {
    globalThis.document = prevDoc;
    globalThis.location = prevLoc;
  }
});

async function inspectWithMockDoc(children, href = "https://chat.deepseek.com/a/chat/s/demo") {
  const prevDoc = globalThis.document;
  const prevLoc = globalThis.location;
  const mockDoc = el("div", {}, children);
  mockDoc.title = "DeepSeek";
  mockDoc.body = mockDoc;
  mockDoc.documentElement = mockDoc;
  mockDoc.scrollingElement = { scrollTop: 0, scrollHeight: 400, clientHeight: 800 };
  try {
    globalThis.document = mockDoc;
    globalThis.location = { href, hostname: new URL(href).hostname, pathname: new URL(href).pathname };
    return await Extractor.runInPage({ mode: "inspect" });
  } finally {
    globalThis.document = prevDoc;
    globalThis.location = prevLoc;
  }
}

test("inspect health: ok when messages are extracted", async () => {
  const res = await inspectWithMockDoc([
    el("div", { attrs: { "data-virtual-list-item-key": "1" } }, [
      el("div", { className: "ds-message" }, [
        el("div", { className: "ds-markdown" }, [el("p", {}, [txt("你好，今天聊点什么？")])]),
      ]),
    ]),
  ]);
  assert.equal(res.count, 1);
  assert.equal(res.health, "ok");
  assert.equal(res.healthSignals.anchors.virtualListItems, 1);
  assert.equal(res.healthSignals.anchors.markdown, 1);
});

test("inspect health: empty when no conversation shell exists", async () => {
  const res = await inspectWithMockDoc([el("div", { className: "sidebar" }, [txt("新对话")])]);
  assert.equal(res.count, 0);
  assert.equal(res.health, "empty");
  assert.deepEqual(res.healthSignals.anchors, {
    virtualListItems: 0,
    messageRoots: 0,
    markdown: 0,
    scrollAreas: 0,
    virtualLists: 0,
  });
});

test("inspect health: selector_drift when shell is present but rows use unknown classes", async () => {
  // 模拟改版：滚动/列表外壳仍在，但消息节点换成了不认识的类名，也没了 virtual-list key。
  const res = await inspectWithMockDoc([
    el("div", { className: "ds-scroll-area ds-virtual-list" }, [
      el("div", { className: "x9a1c2" }, [el("div", { className: "q7m-bubble" }, [txt("今天外面在下雨")])]),
      el("div", { className: "x9a1c2" }, [el("div", { className: "q7m-answer" }, [txt("伞我给你留门口了。")])]),
    ]),
  ]);
  assert.equal(res.count, 0);
  assert.equal(res.health, "selector_drift");
  assert.equal(res.healthSignals.anchors.scrollAreas, 1);
  assert.equal(res.healthSignals.anchors.virtualLists, 1);
  assert.equal(res.healthSignals.isChatSession, true);

  // 同样的外壳出现在非会话页（如首页侧栏）时不报失效，仍按“等待对话”处理。
  const home = await inspectWithMockDoc(
    [el("div", { className: "ds-scroll-area" }, [txt("历史会话")])],
    "https://chat.deepseek.com/"
  );
  assert.equal(home.health, "empty");
});

test("assessPageHealth decision table", () => {
  const anchors = (o = {}) => ({
    virtualListItems: 0, messageRoots: 0, markdown: 0, scrollAreas: 0, virtualLists: 0, ...o,
  });
  const base = { anchors: anchors(), domNodes: 0, scrollHeight: 0, isDeepSeek: true, isChatSession: true };
  assert.equal(Extractor.assessPageHealth(3, base), "ok");
  assert.equal(Extractor.assessPageHealth(0, base), "empty");
  // 强锚点在任何 URL 下都算失效
  assert.equal(
    Extractor.assessPageHealth(0, { ...base, isChatSession: false, anchors: anchors({ messageRoots: 2 }) }),
    "selector_drift"
  );
  // 会话页体量可观但无锚点
  assert.equal(Extractor.assessPageHealth(0, { ...base, scrollHeight: 5000 }), "selector_drift");
  assert.equal(Extractor.assessPageHealth(0, { ...base, domNodes: 3000 }), "selector_drift");
  // 非 DeepSeek / 非会话页的大页面不算
  assert.equal(Extractor.assessPageHealth(0, { ...base, isDeepSeek: false, domNodes: 3000 }), "empty");
  assert.equal(Extractor.assessPageHealth(0, { ...base, isChatSession: false, scrollHeight: 5000 }), "empty");
  assert.equal(Extractor.assessPageHealth(0, null), "empty");
});

test("Core.decideHealthDisplay requires a second selector_drift before reporting", () => {
  const decide = Core.decideHealthDisplay;
  assert.equal(Core.HEALTH_CONFIRM_DELAY_MS, 900);
  // 首次结果：ok / empty 立即渲染，drift 进入确认
  assert.equal(decide({ health: "ok", attempt: 1 }), "render");
  assert.equal(decide({ health: "empty", attempt: 1 }), "render");
  assert.equal(decide({ health: undefined, attempt: 1 }), "render");
  assert.equal(decide({ health: "selector_drift", attempt: 1 }), "confirm");
  assert.equal(decide({ health: "selector_drift", attempt: 1, jobRunning: true }), "render");
  // 重查：drift→drift 报失效；drift→ok / drift→empty 按正常结果渲染（不含失效提示）
  assert.equal(decide({ health: "selector_drift", attempt: 2, isCurrent: true }), "render");
  assert.equal(decide({ health: "ok", attempt: 2, isCurrent: true }), "render");
  assert.equal(decide({ health: "empty", attempt: 2, isCurrent: true }), "render");
  // 重查竞态：换了 tab / 被新检测取代 / 抽取 job 在跑 => 丢弃
  assert.equal(decide({ health: "selector_drift", attempt: 2, isCurrent: false }), "discard");
  assert.equal(decide({ health: "ok", attempt: 2, isCurrent: false }), "discard");
  assert.equal(decide({ health: "selector_drift", attempt: 2, isCurrent: true, jobRunning: true }), "discard");
  assert.equal(decide(), "render");
});

test("background textToDataUrl encodes UTF-8 Chinese payload cleanly", () => {
  const sample = '{"title":"凌晨两点的安全屋","ok":true}';
  const url = Background.textToDataUrl(sample, "application/json;charset=utf-8");
  assert.match(url, /^data:application\/json;charset=utf-8;base64,/);
  const b64 = url.split(",")[1];
  const decoded = Buffer.from(b64, "base64").toString("utf8");
  assert.equal(decoded, sample);
});

test("Core.chunkString splits large text and round-trips exactly", () => {
  // Short input => single chunk, identity.
  assert.deepEqual(Core.chunkString("hello", 4), ["hell", "o"]);
  assert.deepEqual(Core.chunkString("", 4), [""]);
  assert.deepEqual(Core.chunkString("abc"), ["abc"]);

  // Multi-million-char body: split then join must equal the original, with bounded chunks.
  const big = "好".repeat(2_000_000) + "x".repeat(123);
  const size = 262144;
  const chunks = Core.chunkString(big, size);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= size);
  assert.equal(chunks.join(""), big);
});

test("Background.createDownloadBuffer assembles chunked transfers (incl. out-of-order) and guards gaps", () => {
  const buf = Background.createDownloadBuffer();

  // Simulate capsule -> SW chunked streaming of a large body (out-of-order delivery).
  const body = "行".repeat(1_000_000) + "_tail";
  const chunks = Core.chunkString(body, 262144);
  buf.begin("t1", { filename: "echo_x.echo", mimeType: "text/plain", total: chunks.length });
  const order = chunks.map((_, i) => i).reverse();
  for (const i of order) buf.chunk("t1", i, chunks[i]);
  assert.equal(buf.size(), 1);
  const out = buf.end("t1");
  assert.equal(out.filename, "echo_x.echo");
  assert.equal(out.mimeType, "text/plain");
  assert.equal(out.content, body);
  assert.equal(buf.size(), 0);

  // Missing chunk => END throws rather than silently writing a corrupt file.
  buf.begin("t2", { filename: "f", mimeType: "text/plain", total: 3 });
  buf.chunk("t2", 0, "a");
  buf.chunk("t2", 2, "c");
  assert.throws(() => buf.end("t2"), /不完整|缺失/);

  // Unknown transfer id is rejected.
  assert.throws(() => buf.chunk("nope", 0, "x"), /未知/);
  assert.equal(Background.assembleChunks(["a", "b", "", "c"]), "abc");
});

test("Core.validatePassphrase enforces the optional passphrase rule", () => {
  assert.equal(Core.validatePassphrase("").ok, true);
  assert.equal(Core.validatePassphrase("abcd").ok, true);
  assert.equal(Core.validatePassphrase("ab").ok, false);
});

test("Core.finalizeExport exports the full conversation as .md with thinking kept (no truncation)", async () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `消息_${i + 1}`,
    thinking: `思考_${i + 1}`,
  }));
  const extracted = {
    title: "长对话",
    url: "https://chat.deepseek.com/a/chat/s/x",
    strategy: "virtual-list-key",
    exported_at: new Date().toISOString(),
    messages,
  };
  const saved = [];
  const status = await Core.finalizeExport({
    mode: "markdown",
    extracted,
    maskPii: false,
    aliasRulesText: "",
    customPass: "",
    downloader: (filename, content, mimeType) => {
      saved.push({ filename, content, mimeType });
      return Promise.resolve(1);
    },
  });
  assert.equal(saved.length, 1); // nothing pseudonymized => no restore_map sidecar
  assert.match(saved[0].filename, /\.md$/);
  assert.match(saved[0].content, /消息_1\b/);
  assert.match(saved[0].content, /消息_20/);
  assert.match(saved[0].content, /思考_7/); // thinking kept
  assert.match(status, /已导出 20 条消息/);
});

test("Core.finalizeExport (json + PII masking) ships a restore_map sidecar", async () => {
  const saved = [];
  const status = await Core.finalizeExport({
    mode: "json",
    extracted: {
      title: "脱敏",
      url: "https://chat.deepseek.com/a/chat/s/z",
      strategy: "virtual-list-key",
      exported_at: new Date().toISOString(),
      messages: [{ role: "user", content: "电话 13800138000", thinking: "" }],
    },
    maskPii: true,
    aliasRulesText: "",
    customPass: "",
    downloader: (filename, content, mimeType) => {
      saved.push({ filename, content, mimeType });
      return Promise.resolve(1);
    },
  });
  assert.equal(saved.length, 2);
  assert.match(saved[0].filename, /\.json$/);
  assert.equal(saved[0].content.includes("13800138000"), false);
  assert.match(saved[1].filename, /\.restore_map\.json$/);
  assert.match(status, /含脱敏 1 条与还原表/);
});

test("Core.finalizeExport (encrypted) self-seals a decryptable .echo with embedded restore map", async () => {
  const extracted = {
    title: "隐私对话",
    url: "https://chat.deepseek.com/a/chat/s/y",
    strategy: "virtual-list-key",
    exported_at: new Date().toISOString(),
    messages: [
      { role: "user", content: "我是张三，手机13800138000", thinking: "" },
      { role: "assistant", content: "记住了，张三", thinking: "用户张三" },
    ],
  };
  const saved = [];
  const status = await Core.finalizeExport({
    mode: "encrypted",
    extracted,
    maskPii: true,
    aliasRulesText: "张三 -> [U_NAME]",
    customPass: "",
    downloader: (filename, content, mimeType) => {
      saved.push({ filename, content, mimeType });
      return Promise.resolve(1);
    },
  });
  assert.equal(saved.length, 1);
  assert.match(saved[0].filename, /\.echo$/);
  // Opaque: no plaintext PII, no JSON braces, no algorithm strings leak.
  assert.equal(saved[0].content.includes("张三"), false);
  assert.equal(saved[0].content.includes("13800138000"), false);
  assert.equal(saved[0].content.includes("{"), false);

  const meta = await EchoCrypto.inspectStealthPackage(saved[0].content);
  assert.equal(meta.keyMode, "self-sealed");
  assert.equal(meta.hasRestoreMap, true);

  const decoded = await EchoCrypto.decryptPayload(saved[0].content);
  assert.equal(decoded.messages[0].content.includes("[U_NAME]"), true);
  assert.ok(decoded.restore_map && decoded.restore_map.entries["[U_NAME]"] === "张三");
  assert.match(status, /\.echo 加密包/);
});

test("crypto_utils honors envelope.iterations (v1 cross-impl parity) without changing wire format", async () => {
  const sample = { format: EchoCrypto.PLAIN_FORMAT, title: "t", messages: [{ role: "user", content: "x", thinking: "" }] };
  const env = await EchoCrypto.encryptPayload(sample, "pw-1234");
  assert.equal(env.iterations, 250000);
  // Explicit matching iterations still decrypts; a mismatched count fails authentication.
  const okRoundtrip = await EchoCrypto.decryptPayload({ ...env }, "pw-1234");
  assert.deepEqual(okRoundtrip, sample);
  await assert.rejects(() => EchoCrypto.decryptPayload({ ...env, iterations: 100000 }, "pw-1234"));
});
