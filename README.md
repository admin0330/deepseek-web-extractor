# EchoArchive

[中文](#中文) · [English](#english)

---

## 中文

**EchoArchive** 是一个开源的 Chrome / Edge（Manifest V3）扩展，把你在 [DeepSeek](https://chat.deepseek.com) 网页版里的对话**完整导出到本地**：Markdown、结构化 JSON，或 AES-256-GCM 本地加密包（`.echo`）。所有处理都在你的浏览器里完成，不经过任何服务器。

### 功能

- **两个入口**：DeepSeek 页面右上角的浮动胶囊（一键导出），以及浏览器侧栏（完整控制台）。
- **全量回溯长对话**：自动滚动加载全部历史，突破虚拟列表只渲染可见部分的限制。
- **深度思考提取**：采集前自动展开折叠的思考过程（DeepThink），与回答一起导出。
- **多种格式**：
  - Markdown（`.md`）：保留代码块、表格、KaTeX 公式；
  - 结构化 JSON（`.json`）；
  - 加密包（`.echo`）：AES-256-GCM 本地加密，默认免密自封装，也可设置自定义口令。
- **本地隐私脱敏**：屏蔽手机号 / 邮箱 / 身份证号，并支持自定义替换词表（如 `张三 -> [U_NAME]`），同时生成仅存本机的可逆还原表。
- **本地解封**：在侧栏选择 `.echo` 包即可验真、解密并转出 Markdown。
- **页面结构自诊断**：DeepSeek 改版导致识别失效时会明确提示（并二次确认，避免页面加载中的误报），而不是静默显示“暂无对话”。
- 黑白极简界面与克制的过渡动画，遵循系统“减少动态效果”设置。

### 隐私

- **零联网**：扩展不向任何服务器发送数据，没有统计、遥测或远程配置。
- **不读取 Cookie / 登录态**：不申请 `cookies` 权限，只读取当前 DeepSeek 页面上已经渲染出来的对话内容。
- **最小权限**：`sidePanel`、`activeTab`、`scripting`、`downloads`、`storage`、`offscreen`，站点权限仅限 `https://chat.deepseek.com/*`。
- **纯本地加密**：使用浏览器原生 WebCrypto 完成 AES-256-GCM 加密；脱敏还原表只保存在你自己的机器上。

### 安装（加载已解压的扩展）

1. 下载或克隆本仓库：`git clone <本仓库地址>`。
2. 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`）。
3. 打开右上角的 **开发者模式**。
4. 点击 **加载已解压的扩展程序**，选择本仓库根目录（即包含 `manifest.json` 的目录）。
5. 打开或刷新任意 `https://chat.deepseek.com` 对话页：右上角出现导出胶囊；点击工具栏图标可打开侧栏。

### 从源码开发

- 源码即产物：没有构建步骤、没有打包、没有混淆，也没有第三方运行时依赖。
- 目录结构：
  - `manifest.json`：扩展清单
  - `src/content_extractor.js`：对话 DOM 抽取、自动回溯与页面健康诊断
  - `src/content_capsule.js`：页面内浮动胶囊（Shadow DOM）
  - `src/sidepanel.html` / `.css` / `.js`：侧栏界面
  - `src/export_core.js`：两个入口共用的导出流程
  - `src/crypto_utils.js`：加密、解密、脱敏与 Markdown 生成
  - `src/background.js`、`src/offscreen.*`：大文件分块下载通道
  - `tests/extension.test.mjs`：单元测试
- 运行测试（需要 Node.js 18+，无需安装依赖）：

  ```bash
  node tests/extension.test.mjs
  ```

- 修改代码后，在 `chrome://extensions/` 点击扩展卡片上的刷新按钮即可重新加载。

### 许可证

本项目以 **GNU General Public License v3.0（GPL-3.0）** 发布，全文见 [LICENSE](LICENSE)。你可以自由使用、修改和再分发；分发修改后的版本时须同样以 GPL-3.0 开放源代码。

---

## English

**EchoArchive** is an open-source Chrome / Edge (Manifest V3) extension that exports your conversations from the [DeepSeek](https://chat.deepseek.com) web app **to local files**: Markdown, structured JSON, or an AES-256-GCM locally encrypted package (`.echo`). Everything happens inside your browser; nothing goes through any server.

### Features

- **Two entry points**: a floating capsule in the top-right corner of DeepSeek pages (one-click export) and a browser side panel (full console).
- **Full history capture**: auto-scrolls to load the entire conversation, working around the virtual list that only renders visible messages.
- **DeepThink extraction**: expands collapsed reasoning blocks before capture and exports them alongside the answers.
- **Multiple formats**:
  - Markdown (`.md`) with code blocks, tables and KaTeX math preserved;
  - Structured JSON (`.json`);
  - Encrypted package (`.echo`): AES-256-GCM, self-sealed by default, with an optional custom passphrase.
- **Local pseudonymization**: masks mainland-China mobile numbers / emails / Chinese ID numbers and supports custom alias rules (e.g. `Alice -> [U_NAME]`), producing a reversible restore map that stays on your machine.
- **Local unpacking**: pick a `.echo` file in the side panel to verify, decrypt and convert it back to Markdown.
- **Page-structure self-diagnosis**: when a DeepSeek redesign breaks recognition, the extension says so explicitly (with a second confirmation to avoid false alarms while the page is loading) instead of silently showing "no conversation".
- Minimal black-and-white UI with restrained transitions that respects the OS "reduce motion" setting.

### Privacy

- **No network access**: the extension sends nothing to any server: no analytics, telemetry or remote config.
- **No cookies or session access**: it does not request the `cookies` permission and only reads conversation content already rendered on the current DeepSeek page.
- **Minimal permissions**: `sidePanel`, `activeTab`, `scripting`, `downloads`, `storage`, `offscreen`; host access is limited to `https://chat.deepseek.com/*`.
- **Local-only encryption**: AES-256-GCM via the browser's native WebCrypto; pseudonymization restore maps never leave your machine.

### Install (load unpacked)

1. Download or clone this repository: `git clone <this-repo-url>`.
2. Open `chrome://extensions/` (or `edge://extensions/` in Edge).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the repository root (the folder containing `manifest.json`).
5. Open or reload any `https://chat.deepseek.com` conversation: the export capsule appears in the top-right corner, and the toolbar icon opens the side panel.

### Working from source

- The source is the product: no build step, no bundling, no obfuscation, and no third-party runtime dependencies.
- Layout:
  - `manifest.json`: extension manifest
  - `src/content_extractor.js`: conversation DOM extraction, auto-scroll capture and page-health diagnosis
  - `src/content_capsule.js`: in-page floating capsule (Shadow DOM)
  - `src/sidepanel.html` / `.css` / `.js`: side panel UI
  - `src/export_core.js`: export pipeline shared by both entry points
  - `src/crypto_utils.js`: encryption, decryption, pseudonymization and Markdown rendering
  - `src/background.js`, `src/offscreen.*`: chunked download channel for large files
  - `tests/extension.test.mjs`: unit tests
- Run the tests (Node.js 18+, nothing to install):

  ```bash
  node tests/extension.test.mjs
  ```

- After editing, click the reload button on the extension's card in `chrome://extensions/`.

### License

Released under the **GNU General Public License v3.0 (GPL-3.0)**; see [LICENSE](LICENSE). You may use, modify and redistribute it freely; modified versions you distribute must also be released under GPL-3.0 with source code.
