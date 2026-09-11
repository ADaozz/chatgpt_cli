/**
 * adapter.js — ChatGPT DOM 操作的隔离层
 *
 * 架构约束：
 *   - 这一层是唯一允许直接操作 `page` 的层
 *   - 不持有状态，所有操作都是 page + 参数 → 结果 的纯函数形式
 *   - 不抛出业务错误，只抛出操作错误（超时、元素不存在）
 */

const S = require('./selectors');
const { ResponseTracker } = require('./response-tracker');
const {
  extractConversationCompletion,
  isConversationTurnComplete,
} = require('./conversation-completion');
const path = require('path');
const fs = require('fs');

const DEFAULT_TIMEOUT = 15_000;

/**
 * 上传完成等待超时（毫秒）。
 *
 * 必须运行时读取 env，因为 CLI 在 parse `--timeout-ms` 后才会写
 * `process.env.CHATGPT_UPLOAD_TIMEOUT_MS`；如果在 module load 阶段把
 * 常量冻结，CLI 透传的 timeout 永远不会生效（turn_4 P0.1）。
 */
function getUploadTimeoutMs() {
  const value = Number(process.env.CHATGPT_UPLOAD_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}
const REPLY_TIMEOUT = 600_000; // GPT-5-4-Pro extended thinking can take 5+ minutes
const PROJECT_VIEWER_CAPABILITIES = {
  can_read: true,
  can_view_config: false,
  can_write: false,
  can_delete: false,
  can_export: false,
  can_share: false,
};

// ── 内部工具 ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitAndClick(page, selector, timeout = DEFAULT_TIMEOUT) {
  const el = await page.waitForSelector(selector, { timeout });
  await el.click();
  return el;
}

async function waitForAbsent(page, selector, timeout = DEFAULT_TIMEOUT) {
  await page.waitForSelector(selector, { hidden: true, timeout });
}

async function waitForEnabled(page, selector, timeout = DEFAULT_TIMEOUT) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      return !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    },
    { timeout },
    selector
  );
}

function getLocalFileMeta(absoluteFilePath) {
  const fileContent = fs.readFileSync(absoluteFilePath);
  const fileName = path.basename(absoluteFilePath);
  const fileSize = fileContent.length;

  const ext = path.extname(absoluteFilePath).toLowerCase();
  const mimeMap = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
    '.js': 'text/javascript', '.ts': 'text/typescript', '.py': 'text/x-python',
    '.html': 'text/html', '.css': 'text/css', '.csv': 'text/csv',
    '.xml': 'application/xml', '.yaml': 'application/x-yaml', '.yml': 'application/x-yaml',
    '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.zip': 'application/zip', '.gz': 'application/gzip',
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';

  return { fileContent, fileName, fileSize, mimeType };
}

async function getProjectFileInput(page) {
  const existingHandle = await page.evaluateHandle((sel) => {
    const inputs = Array.from(document.querySelectorAll(sel));
    return inputs.find((el) => el.closest('[role="dialog"]')) || null;
  }, S.files.fileInput);
  const existingInput = existingHandle.asElement();
  if (existingInput) {
    return existingInput;
  }

  const beforeCount = await page.evaluate(
    (sel) => document.querySelectorAll(sel).length,
    S.files.fileInput
  );

  await waitAndClick(page, S.files.projectModalTrigger);

  try {
    await page.waitForFunction(
      (sel, prevCount) => {
        const inputs = Array.from(document.querySelectorAll(sel));
        return (
          inputs.length > prevCount ||
          inputs.some((el) => Boolean(el.closest('[role="dialog"]')))
        );
      },
      { timeout: DEFAULT_TIMEOUT },
      S.files.fileInput,
      beforeCount
    );
  } catch {
    // 某些版本不会新增 input，而是直接复用已存在的隐藏 input。
  }

  const handle = await page.evaluateHandle((sel) => {
    const inputs = Array.from(document.querySelectorAll(sel));
    return (
      inputs.find((el) => el.closest('[role="dialog"]')) ||
      inputs[inputs.length - 1] ||
      null
    );
  }, S.files.fileInput);

  const input = handle.asElement();
  if (!input) {
    throw new Error('找不到项目文件上传输入框');
  }
  return input;
}

function normalizeLookupText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

function isLikelyFilename(value) {
  return /[a-z0-9][a-z0-9._ -]*\.(txt|md|json|csv|xml|ya?ml|pdf|png|jpe?g|gif|svg|zip|gz|py|js|ts|html|css|docx?|xlsx?|pptx?|rtf)$/i
    .test(String(value || '').trim());
}

function isTextLikeFile(file) {
  const mimeType = String(file?.mimeType || '');
  const name = String(file?.name || '');
  return (
    /^(text\/|application\/(json|xml|javascript)|image\/svg\+xml)/i.test(
      mimeType
    ) ||
    /\.(txt|md|json|csv|xml|ya?ml|js|ts|py|html|css|svg|log)$/i.test(name)
  );
}

function dedupeFiles(files) {
  const seen = new Set();
  const out = [];
  for (const file of files || []) {
    const key = [file?.id || '', file?.url || '', file?.name || ''].join('|');
    if (!key.replace(/\|/g, '')) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function getAttachmentContent(value) {
  if (!value || typeof value !== 'object') return null;
  const chunks = [
    value.content,
    value.text,
    value.preview_text,
    value.extracted_text,
    value.excerpt,
    value.summary,
  ]
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim());
  return chunks.length ? chunks.join('\n\n') : null;
}

function normalizeFileCandidate(value) {
  if (!value || typeof value !== 'object') return null;

  const name =
    [
      value.name,
      value.file_name,
      value.filename,
      value.display_name,
      value.title,
    ].find((item) => typeof item === 'string' && item.trim()) || null;

  const url =
    [
      value.download_url,
      value.downloadUrl,
      value.url,
      value.href,
    ].find((item) => typeof item === 'string' && item.trim()) || null;

  const mimeType =
    [
      value.mimeType,
      value.mime_type,
      value.content_type,
    ].find((item) => typeof item === 'string' && item.trim()) || null;

  const rawId =
    value.file_id ??
    value.fileId ??
    value.asset_pointer ??
    null;

  const rawSize = value.file_size ?? value.fileSize ?? value.size ?? null;
  const size =
    typeof rawSize === 'number'
      ? rawSize
      : Number.isFinite(Number(rawSize))
        ? Number(rawSize)
        : null;

  const hasFileSignal = Boolean(
    value.file_id ||
      value.asset_pointer ||
      value.mimeType ||
      value.mime_type ||
      value.file_size != null ||
      (url && /\/files\/|download|blob:/i.test(url)) ||
      (name && isLikelyFilename(name))
  );

  if (!hasFileSignal) return null;

  return {
    id: rawId == null ? null : String(rawId),
    name,
    mimeType: mimeType ? String(mimeType) : null,
    size,
    url,
    content: getAttachmentContent(value),
  };
}

function extractFilesFromValue(value, bucket = []) {
  if (!value) return bucket;
  if (Array.isArray(value)) {
    for (const item of value) extractFilesFromValue(item, bucket);
    return bucket;
  }
  if (typeof value !== 'object') return bucket;

  const candidate = normalizeFileCandidate(value);
  if (candidate) bucket.push(candidate);

  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      extractFilesFromValue(child, bucket);
    }
  }

  return bucket;
}

function normalizeContentParts(parts) {
  if (!Array.isArray(parts)) return [];

  const chunks = [];
  for (const part of parts) {
    if (typeof part === 'string' && part.trim()) {
      chunks.push(part.trim());
      continue;
    }
    if (!part || typeof part !== 'object') continue;

    if (typeof part.text === 'string' && part.text.trim()) {
      chunks.push(part.text.trim());
      continue;
    }
    if (typeof part.content === 'string' && part.content.trim()) {
      chunks.push(part.content.trim());
      continue;
    }
    if (Array.isArray(part.parts)) {
      chunks.push(...normalizeContentParts(part.parts));
    }
  }

  return chunks;
}

function normalizeConversationApiPayload(payload) {
  if (!payload || typeof payload !== 'object' || !payload.mapping) {
    return null;
  }

  const nodes = Object.values(payload.mapping)
    .filter((node) => node?.message)
    .sort((a, b) => {
      const aTime = a.message?.create_time ?? 0;
      const bTime = b.message?.create_time ?? 0;
      return aTime - bTime;
    });

  const messages = nodes
    .map((node) => {
      const message = node.message;
      const files = dedupeFiles(
        extractFilesFromValue({
          content: message.content,
          metadata: message.metadata,
          attachments: message.attachments,
        })
      );

      return {
        id: message.id || node.id || null,
        role: message.author?.role || 'unknown',
        text: normalizeContentParts(message.content?.parts).join('\n\n').trim(),
        files,
        createTime: message.create_time || null,
      };
    })
    .filter((message) => message.text || message.files.length);

  if (!messages.length) {
    return null;
  }

  return {
    id: payload.conversation_id || payload.id || null,
    title: payload.title || null,
    messages,
    files: dedupeFiles(messages.flatMap((message) => message.files)),
    source: 'api',
    completion: extractConversationCompletion(payload),
  };
}

function mergeConversationSnapshots(primary, secondary) {
  if (!primary) return secondary;
  if (!secondary) return primary;

  const mergedMessages = [];
  const maxLen = Math.max(primary.messages.length, secondary.messages.length);

  for (let i = 0; i < maxLen; i++) {
    const a = primary.messages[i];
    const b = secondary.messages[i];
    if (a && b) {
      mergedMessages.push({
        id: a.id || b.id || null,
        role: a.role !== 'unknown' ? a.role : b.role,
        text: a.text || b.text || '',
        files: dedupeFiles([...(a.files || []), ...(b.files || [])]),
        createTime: a.createTime ?? b.createTime ?? null,
      });
      continue;
    }
    if (a || b) mergedMessages.push(a || b);
  }

  return {
    id: primary.id || secondary.id || null,
    title: primary.title || secondary.title || null,
    messages: mergedMessages,
    files: dedupeFiles(mergedMessages.flatMap((message) => message.files || [])),
    source:
      primary.source === secondary.source
        ? primary.source
        : `${primary.source}+${secondary.source}`,
    completion: primary.completion || secondary.completion || null,
  };
}

// ── URL 解析 ──────────────────────────────────────────────────────────────────

/**
 * 从 URL 提取项目 hex ID。
 * e.g. "/g/g-p-69a4014b9f5881919b68c81a6bbeda3d-ghostvm/project" → "69a4014b9f5881919b68c81a6bbeda3d"
 */
function extractProjectId(url) {
  const match = url.match(/\/g\/g-p-([a-f0-9]+)/i);
  return match ? match[1] : null;
}

/**
 * 从 URL 提取项目页面完整路径（含 slug）。
 * 对话页 `/g/g-p-.../c/{id}` 也会归一化为项目主页 `/g/g-p-.../project`。
 */
function extractProjectPath(url) {
  return normalizeProjectHomePath(url);
}

/**
 * 是否为项目内对话路径（含 /c/{uuid}）。
 */
function isConversationPath(input) {
  return /\/c\/[a-z0-9-]+/i.test(String(input || ''));
}

/**
 * 归一化为项目主页路径：/g/g-p-{id}-{slug}/project
 * - 去掉 /c/{conversationId} 及其后缀（含错误的 .../c/.../project）
 * - 裸 /g/g-p-... 路径会补全 /project
 */
function normalizeProjectHomePath(input) {
  let p = String(input || '').trim();
  if (!p) return null;

  if (p.startsWith('http://') || p.startsWith('https://')) {
    try {
      p = new URL(p).pathname;
    } catch {
      return null;
    }
  }

  p = p.split('?')[0].split('#')[0].replace(/\/$/, '');
  p = p.replace(/\/c\/[a-z0-9-]+(?:\/.*)?$/i, '');
  p = p.replace(/\/project$/i, '');

  const baseMatch = p.match(/^(\/g\/g-p-[a-f0-9]+(?:-[a-z0-9-]+)*)/i);
  if (!baseMatch) return null;

  return `${baseMatch[1]}/project`;
}

/**
 * 从 ChatGPT 对话 URL 中提取 conversation id。
 * e.g. ".../c/69b118d5-4ca4-83a8-8752-b1af35c9c742" → "69b118d5-4ca4-83a8-8752-b1af35c9c742"
 */
function extractConversationId(url) {
  const match = url.match(/\/c\/([a-z0-9-]+)/i);
  if (!match) throw new Error(`无法从 URL 提取 conversation id: ${url}`);
  return match[1];
}

// ── 导航 ──────────────────────────────────────────────────────────────────────

/**
 * 解析可直接打开的项目路径（不含域名）。
 * 支持项目主页 URL；若传入对话 URL 则提取其所属项目主页（不会保留 /c/ 段）。
 */
function parseDirectProjectPath(input) {
  return normalizeProjectHomePath(input);
}

async function gotoProjectPath(page, projectPath) {
  const normalized = normalizeProjectHomePath(projectPath);
  if (!normalized) {
    throw new Error(`无效的项目路径: ${projectPath}`);
  }
  await page.goto(`https://chatgpt.com${normalized}`, {
    waitUntil: 'domcontentloaded',
    timeout: DEFAULT_TIMEOUT,
  });
  await page.waitForSelector(S.composer.textarea, { timeout: DEFAULT_TIMEOUT });
  const url = page.url();
  return {
    projectId: extractProjectId(url),
    projectPath: extractProjectPath(url),
  };
}

function projectNameMatchesHref(name, href) {
  const slugNeedle = name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fff-]/gi, '');
  const hrefLower = String(href || '').toLowerCase();
  if (/^[a-f0-9]{20,40}$/i.test(name) && hrefLower.includes(name.toLowerCase())) return true;
  return Boolean(slugNeedle && hrefLower.includes(slugNeedle));
}

async function ensureChatGptSidebar(page) {
  const url = page.url();
  if (!url.includes('chatgpt.com')) {
    await page.goto('https://chatgpt.com/', {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT,
    });
    await sleep(1500);
  }
}

async function findProjectHrefInDocument(page, projectName) {
  return page.evaluate((name) => {
    const slugNeedle = name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\u4e00-\u9fff-]/gi, '');
    for (const el of document.querySelectorAll('[href]')) {
      let href = el.getAttribute('href') || '';
      if (!href.includes('/g/g-p-')) continue;
      href = href.split('?')[0].split('#')[0];
      if (/\/c\/[a-z0-9-]+/i.test(href)) continue;
      if (!/\/project\/?$/i.test(href)) {
        if (!/\/g\/g-p-/i.test(href)) continue;
        href = href.replace(/\/?$/, '') + '/project';
      }
      const hrefLower = href.toLowerCase();
      if (/^[a-f0-9]{20,40}$/i.test(name) && hrefLower.includes(name.toLowerCase())) {
        return href.startsWith('http') ? new URL(href).pathname : href;
      }
      if (slugNeedle && hrefLower.includes(slugNeedle)) {
        return href.startsWith('http') ? new URL(href).pathname : href;
      }
    }
    return null;
  }, projectName);
}

/** 新版 ChatGPT 侧边栏：项目在 .project-unfurl-row 里，需点「打开项目首页」。 */
async function navigateToProjectViaSidebarRow(page, projectName) {
  await ensureChatGptSidebar(page);

  const rowHandle = await page.evaluateHandle((name) => {
    const norm = (s) =>
      (s || '')
        .toLowerCase()
        .replace(/[\u200b\uFEFF]/g, '')
        .replace(/[-_\s]+/g, ' ')
        .trim();
    const needle = norm(name);
    const slugNeedle = name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\u4e00-\u9fff-]/gi, '');

    for (const row of document.querySelectorAll('[class*="project-unfurl-row"]')) {
      const label =
        row.querySelector('[data-marquee-text]')?.textContent ||
        row.querySelector('[role="button"]')?.textContent ||
        row.textContent;
      const text = norm(label);
      if (!text) continue;
      if (text === needle || text.includes(needle) || needle.includes(text)) return row;
      if (slugNeedle && text.replace(/\s+/g, '-').includes(slugNeedle)) return row;
    }
    return null;
  }, projectName);

  const row = rowHandle.asElement();
  if (!row) {
    await rowHandle.dispose();
    return null;
  }

  await row.hover();
  await sleep(300);

  const homeBtn =
    (await row.$('button[aria-label="打开项目首页"]')) ||
    (await row.$('button[aria-label*="打开项目首页"]'));

  if (!homeBtn) {
    await rowHandle.dispose();
    return null;
  }

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT }).catch(() => null),
    homeBtn.click(),
  ]);
  await rowHandle.dispose();
  await sleep(500);

  const path = extractProjectPath(page.url());
  if (!path) return null;
  return {
    projectId: extractProjectId(page.url()),
    projectPath: path,
  };
}

async function listVisibleSidebarProjects(page) {
  return page.evaluate(() => {
    const out = [];
    for (const row of document.querySelectorAll('[class*="project-unfurl-row"]')) {
      const text = (
        row.querySelector('[data-marquee-text]')?.textContent ||
        row.querySelector('[role="button"]')?.textContent ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      if (text) out.push(text);
    }
    return out;
  });
}

/**
 * 在侧边栏中找到名为 `projectName` 的项目并点击进入。
 * 返回 { projectId, projectPath } 供后续构建 URL。
 */
async function navigateToProject(page, projectName) {
  const trimmed = String(projectName || '').trim();
  if (!trimmed) throw new Error('项目名为空');

  const direct = parseDirectProjectPath(trimmed);
  if (direct) {
    return gotoProjectPath(page, direct);
  }

  const currentPath = extractProjectPath(page.url());
  if (currentPath && projectNameMatchesHref(trimmed, currentPath)) {
    return {
      projectId: extractProjectId(page.url()),
      projectPath: currentPath,
    };
  }

  const docHref = await findProjectHrefInDocument(page, trimmed);
  if (docHref) {
    return gotoProjectPath(page, docHref);
  }

  const href = await page.evaluate((name) => {
    const norm = (s) =>
      (s || '')
        .toLowerCase()
        .replace(/[\u200b\uFEFF]/g, '')
        .replace(/[-_\s]+/g, ' ')
        .trim();
    const needle = norm(name);
    const slugNeedle = name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\u4e00-\u9fff-]/gi, '');
    const needles = needle.split(' ').filter(Boolean);
    const links = document.querySelectorAll('a[href*="/g/g-p-"]');
    for (const link of links) {
      const rawHref = link.getAttribute('href') || '';
      const path = rawHref.split('?')[0].split('#')[0];
      if (!/\/project\/?$/i.test(path)) continue;
      const hrefLower = path.toLowerCase();
      if (/^[a-f0-9]{20,40}$/i.test(name) && hrefLower.includes(name.toLowerCase())) {
        return path;
      }
      if (slugNeedle && hrefLower.includes(slugNeedle)) return path;
      const text = norm(link.textContent);
      if (!text) continue;
      if (needle && text.includes(needle)) return path;
      if (needles.length && needles.every((w) => text.includes(w))) return path;
    }
    return null;
  }, trimmed);

  if (href) {
    return gotoProjectPath(page, href);
  }

  const viaSidebar = await navigateToProjectViaSidebarRow(page, trimmed);
  if (viaSidebar) return viaSidebar;

  await ensureChatGptSidebar(page);
  const sidebarProjects = await listVisibleSidebarProjects(page);
  const hint = sidebarProjects.length
    ? `侧边栏「项目」区可见: ${sidebarProjects.map((v) => `"${v}"`).join(', ')}。也可传入完整路径 /g/g-p-.../project。`
    : '当前页面未发现项目；请展开侧边栏「项目」区，或传入项目主页完整路径（地址栏 /g/g-p-.../project）。';
  throw new Error(`找不到名为 "${trimmed}" 的项目。${hint}`);
}

/**
 * 导航到项目主页（用于开始新对话）。
 * projectPath 格式: "/g/g-p-{id}-{slug}/project"
 */
async function navigateToProjectHome(page, projectPath, options = {}) {
  const { forceReload = false } = options;
  const currentUrl = page.url();
  const currentPathname = new URL(currentUrl).pathname;
  // 如果已在项目主页且没有 /c/（即不在对话中），则无需重新导航
  if (
    !forceReload &&
    currentPathname === projectPath &&
    !currentUrl.includes('/c/')
  ) {
    return;
  }
  await page.goto(`https://chatgpt.com${projectPath}`, {
    waitUntil: 'domcontentloaded',
    timeout: DEFAULT_TIMEOUT,
  });
  await page.waitForSelector(S.composer.textarea, { timeout: DEFAULT_TIMEOUT });
}

/**
 * 导航到已有对话。
 * @param {string} projectRef  项目路径或项目 hex ID（可选，无则为非项目对话）
 */
async function navigateToConversation(page, conversationId, projectRef) {
  let target;
  if (projectRef) {
    const projectHome = normalizeProjectHomePath(projectRef);
    const projectBase = projectHome
      ? projectHome.replace(/\/project$/i, '')
      : projectRef.startsWith('/g/')
        ? String(projectRef).replace(/\/project$/i, '').replace(/\/c\/[a-z0-9-]+(?:\/.*)?$/i, '')
        : `/g/g-p-${projectRef}`;
    target = `https://chatgpt.com${projectBase}/c/${conversationId}`;
  } else {
    target = `https://chatgpt.com/c/${conversationId}`;
  }

  if (!page.url().includes(conversationId)) {
    await page.goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT,
    });
    // 等待消息加载和输入框就绪
    await page.waitForSelector(S.composer.textarea, { timeout: DEFAULT_TIMEOUT });
    // 额外等待消息渲染
    await sleep(2000);
  }
}

// ── 文件操作 ──────────────────────────────────────────────────────────────────

/**
 * 获取 ChatGPT access token（从 session API）。
 */
async function getAccessToken(page) {
  return page.evaluate(async () => {
    const resp = await fetch('/api/auth/session');
    return (await resp.json()).accessToken;
  });
}

async function createRemoteFile(page, accessToken, payload) {
  const res = await page.evaluate(async (body, token) => {
    const resp = await fetch('/backend-api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: resp.status, ok: resp.ok, text, json };
  }, payload, accessToken);

  if (!res.ok || !res.json?.upload_url || !res.json?.file_id) {
    throw new Error(`文件创建失败: ${res.text || JSON.stringify(res.json || {})}`);
  }

  return res.json;
}

async function deleteRemoteFile(page, accessToken, fileId) {
  const res = await page.evaluate(async (id, token) => {
    const resp = await fetch(`/backend-api/files/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: resp.status, ok: resp.ok, text, json };
  }, fileId, accessToken);

  if (!res.ok || res.json?.success === false) {
    throw new Error(`项目文件删除失败: ${res.text || JSON.stringify(res.json || {})}`);
  }
}

async function uploadBlobToUrl(page, uploadUrl, fileContent, mimeType) {
  const res = await page.evaluate(async (url, b64, contentType) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-version': '2020-04-08',
      },
      body: bytes,
    });
    const text = await resp.text().catch(() => '');
    return { status: resp.status, ok: resp.ok, text };
  }, uploadUrl, fileContent.toString('base64'), mimeType || 'application/octet-stream');

  if (!res.ok && res.status !== 201) {
    throw new Error(`Blob 上传失败: ${res.status} ${res.text || ''}`.trim());
  }
}

async function processProjectUpload(page, accessToken, payload) {
  const res = await page.evaluate(async (body, token) => {
    const resp = await fetch('/backend-api/files/process_upload_stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    return { status: resp.status, ok: resp.ok, text };
  }, payload, accessToken);

  if (!res.ok) {
    throw new Error(`项目文件处理失败: ${res.status} ${res.text || ''}`.trim());
  }
  if (!/"event":"file\.processing\.completed"/.test(res.text)) {
    throw new Error(`项目文件处理未完成: ${res.text || 'missing completion event'}`);
  }
}

async function fetchProjectConfig(page, accessToken, gizmoId) {
  const config = await page.evaluate(async (id, token) => {
    const resp = await fetch(`/backend-api/gizmos/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return resp.json();
  }, gizmoId, accessToken);

  if (!config?.gizmo?.id) {
    throw new Error(`读取项目配置失败: ${gizmoId}`);
  }
  return config;
}

function normalizeProjectSharingSubject(subject) {
  if (!subject) return null;

  switch (subject.type) {
    case 1:
    case 'user':
      return {
        type: 'user',
        user_id: subject.user_id,
        user_name: subject.user_name,
        user_email: subject.user_email,
        avatar_url: subject.avatar_url ?? null,
        capabilities: subject.capabilities || PROJECT_VIEWER_CAPABILITIES,
      };
    case 2:
    case 'group':
      return {
        type: 'group',
        group_id: subject.group_id,
        group_name: subject.group_name,
        capabilities: subject.capabilities || PROJECT_VIEWER_CAPABILITIES,
      };
    case 3:
    case 'workspace':
    case 'workspace_link':
      return {
        type: 'workspace_link',
        capabilities: subject.capabilities || PROJECT_VIEWER_CAPABILITIES,
      };
    case 4:
    case 'all':
    case 'link':
      return {
        type: 'link',
        capabilities: subject.capabilities || PROJECT_VIEWER_CAPABILITIES,
      };
    default:
      return null;
  }
}

function buildProjectSharingPayload(gizmo) {
  const subjects = (gizmo?.sharing?.subjects || [])
    .map(normalizeProjectSharingSubject)
    .filter(Boolean);
  const recipient = gizmo?.share_recipient || gizmo?.sharing?.recipient || 'private';

  if (recipient === 'link' || recipient === 'workspace_link') {
    return [
      ...subjects,
      { type: recipient, capabilities: PROJECT_VIEWER_CAPABILITIES },
    ];
  }

  return [{ type: 'private', capabilities: PROJECT_VIEWER_CAPABILITIES }, ...subjects];
}

function shouldIndexProjectFile(gizmo, fileName, mimeType) {
  if (!gizmo?.use_injest_path) {
    return false;
  }

  return (
    isTextLikeFile({ name: fileName, mimeType }) ||
    /\.(pdf|docx?|pptx?|xlsx?)$/i.test(fileName)
  );
}

function normalizeProjectFileForUpsert(file) {
  return {
    ...file,
    location: 'fs',
  };
}

function dedupeProjectUpsertFiles(files) {
  const seen = new Set();
  const out = [];

  for (const file of files || []) {
    const key = file?.file_id || file?.id || file?.name;
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }

  return out;
}

function buildProjectUpsertPayload(projectConfig, files) {
  const gizmo = projectConfig.gizmo || {};
  return {
    gizmo_id: gizmo.id,
    instructions: gizmo.instructions || '',
    display: {
      name: gizmo.display?.name || '',
      description: gizmo.display?.description || '',
      emoji: gizmo.display?.emoji || null,
      theme: gizmo.display?.theme || null,
      profile_pic_id: gizmo.display?.profile_pic_id || null,
      profile_picture_url: gizmo.display?.profile_picture_url || null,
      prompt_starters: gizmo.display?.prompt_starters || [],
    },
    tools: Array.isArray(projectConfig.tools) ? projectConfig.tools : [],
    memory_scope: gizmo.memory_scope || 'unset',
    files: dedupeProjectUpsertFiles((files || []).map(normalizeProjectFileForUpsert)),
    training_disabled: Boolean(gizmo.training_disabled),
    sharing: buildProjectSharingPayload(gizmo),
  };
}

async function upsertProject(page, accessToken, payload) {
  const res = await page.evaluate(async (body, token) => {
    const resp = await fetch('/backend-api/gizmos/snorlax/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: resp.status, ok: resp.ok, text, json };
  }, payload, accessToken);

  if (!res.ok || res.json?.error) {
    throw new Error(`项目配置回写失败: ${res.text || JSON.stringify(res.json || {})}`);
  }

  return res.json;
}

/**
 * 通过 backend API 创建新项目，返回 { projectId, projectPath }。
 *
 * upsert 创建成功后 ChatGPT UI 会自动跳转，导致 page.evaluate 的
 * execution context 被销毁。因此使用 CDP Fetch 域在 Node 侧发请求，
 * 不经过页面 JS 上下文。
 */
async function createProject(page, projectName) {
  const accessToken = await getAccessToken(page);

  const payload = {
    instructions: '',
    display: {
      name: projectName,
      description: '',
      emoji: null,
      theme: null,
      profile_pic_id: null,
      profile_picture_url: null,
      prompt_starters: [],
    },
    tools: [
      { type: 'retrieval' },
      { type: 'python' },
    ],
    memory_scope: 'unset',
    files: [],
    training_disabled: false,
    sharing: [{ type: 'private', capabilities: PROJECT_VIEWER_CAPABILITIES }],
  };

  // page.evaluate 中的 fetch 成功后 ChatGPT UI 会自动跳转到新项目，
  // 导致 execution context 被销毁。用 race：若 evaluate 成功则从返回值提取；
  // 若被导航打断则从导航后的 URL 提取。
  let gizmoResult = null;
  const evalPromise = page.evaluate(async (body, token) => {
    const resp = await fetch('/backend-api/gizmos/snorlax/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: resp.status, ok: resp.ok, text, json };
  }, payload, accessToken);

  const navPromise = page.waitForNavigation({
    waitUntil: 'domcontentloaded',
    timeout: DEFAULT_TIMEOUT,
  }).then(() => 'navigated');

  const raceResult = await Promise.race([
    evalPromise.then((r) => ({ type: 'eval', data: r })),
    navPromise.then(() => ({ type: 'nav' })),
  ]).catch((err) => {
    if (/context.*destroy|navigat/i.test(err.message)) return { type: 'nav' };
    throw err;
  });

  let projectPath;

  if (raceResult.type === 'eval') {
    const result = raceResult.data;
    if (!result.ok || result.json?.error) {
      throw new Error(`创建项目失败: ${result.text || JSON.stringify(result.json || {})}`);
    }
    const gizmo = result.json?.resource?.gizmo
      || result.json?.gizmo
      || result.json;
    const id = gizmo?.id || gizmo?.gizmo_id;
    if (!id) {
      throw new Error(`创建项目失败: 返回中无 gizmo id — ${JSON.stringify(result.json).slice(0, 300)}`);
    }
    const slug = gizmo?.short_url?.split('g-p-')[1]
      || gizmo?.slug
      || id;
    projectPath = `/g/g-p-${slug}/project`;
  } else {
    // UI 已跳转到新项目页面，从 URL 提取
    await sleep(2000);
    projectPath = normalizeProjectHomePath(page.url());
    if (!projectPath) {
      throw new Error(`创建项目后无法从 URL 提取路径: ${page.url()}`);
    }
  }

  await sleep(1000);

  await page.goto(`https://chatgpt.com${projectPath}`, {
    waitUntil: 'domcontentloaded',
    timeout: DEFAULT_TIMEOUT,
  });
  await page.waitForSelector(S.composer.textarea, { timeout: DEFAULT_TIMEOUT });

  const url = page.url();
  return {
    projectId: extractProjectId(url),
    projectPath: extractProjectPath(url),
  };
}

async function waitForProjectFileAttachment(
  page,
  accessToken,
  gizmoId,
  fileId,
  timeout = getUploadTimeoutMs()
) {
  await page.waitForFunction(
    async (id, token, targetFileId) => {
      const resp = await fetch(`/backend-api/gizmos/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      return Boolean((data.files || []).some((file) => file.file_id === targetFileId));
    },
    { timeout },
    gizmoId,
    accessToken,
    fileId
  );
}

async function waitForProjectFileRemoval(page, accessToken, gizmoId, fileIds, timeout = 30_000) {
  const targets = Array.from(new Set((fileIds || []).filter(Boolean)));
  await page.waitForFunction(
    async (id, token, targetIds) => {
      const resp = await fetch(`/backend-api/gizmos/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      const currentIds = new Set((data.files || []).map((file) => file.file_id).filter(Boolean));
      return targetIds.every((targetId) => !currentIds.has(targetId));
    },
    { timeout },
    gizmoId,
    accessToken,
    targets
  );
}

function matchesProjectFileRef(file, fileRef) {
  return file?.file_id === fileRef || file?.name === fileRef;
}

/**
 * 通过 API 上传文件为后续对话附件（3 步流程）。
 *
 * 流程：
 *   1. POST /backend-api/files → 获取 upload_url + file_id
 *   2. PUT upload_url（Azure Blob）→ 上传文件内容
 *   3. POST /backend-api/files/{id}/uploaded → 确认上传
 *
 * @returns {{ fileId: string, fileName: string, fileSize: number, mimeType: string }}
 */
async function apiUploadConversationAttachment(page, absoluteFilePath) {
  const accessToken = await getAccessToken(page);
  const { fileContent, fileName, fileSize, mimeType } =
    getLocalFileMeta(absoluteFilePath);

  // Step 1: 创建上传
  const createRes = await createRemoteFile(page, accessToken, {
    file_name: fileName,
    file_size: fileSize,
    use_case: 'ace_upload',
  });

  // Step 2: 上传到 Azure Blob
  await uploadBlobToUrl(page, createRes.upload_url, fileContent, 'application/octet-stream');

  // Step 3: 确认上传
  await page.evaluate(async (fid, token) => {
    await fetch(`/backend-api/files/${fid}/uploaded`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
  }, createRes.file_id, accessToken);

  return {
    fileId: createRes.file_id,
    fileName,
    fileSize,
    mimeType,
  };
}

/**
 * 通过项目内部 API 上传文件到项目 Sources。
 *
 * 真实链路：
 *   1. POST /backend-api/files 创建 file entry
 *   2. PUT blob URL 上传文件内容
 *   3. POST /backend-api/files/process_upload_stream 让项目库完成处理
 *   4. POST /backend-api/gizmos/snorlax/upsert 把文件挂到项目配置
 *
 * @returns {{ fileId: string, fileName: string, fileSize: number, mimeType: string }}
 */
async function uploadProjectFile(page, absoluteFilePath) {
  const accessToken = await getAccessToken(page);
  const projectHexId = extractProjectId(page.url());
  if (!projectHexId) {
    throw new Error('当前页面不是项目页面，无法上传项目文件');
  }

  const gizmoId = `g-p-${projectHexId}`;
  const { fileContent, fileName, fileSize, mimeType } = getLocalFileMeta(absoluteFilePath);
  const lastModified = Math.trunc(fs.statSync(absoluteFilePath).mtimeMs || Date.now());

  const createRes = await createRemoteFile(page, accessToken, {
    file_name: fileName,
    file_size: fileSize,
    use_case: 'agent',
    gizmo_id: gizmoId,
    timezone_offset_min: new Date().getTimezoneOffset(),
    reset_rate_limits: false,
    store_in_library: true,
  });

  await uploadBlobToUrl(page, createRes.upload_url, fileContent, mimeType);

  const configBeforeUpsert = await fetchProjectConfig(page, accessToken, gizmoId);
  await processProjectUpload(page, accessToken, {
    file_id: createRes.file_id,
    use_case: 'agent',
    gizmo_id: gizmoId,
    index_for_retrieval: shouldIndexProjectFile(
      configBeforeUpsert.gizmo,
      fileName,
      mimeType
    ),
    file_name: fileName,
    metadata: {
      store_in_library: true,
      library_file_info: {
        gizmo_id: gizmoId,
        is_project: true,
      },
    },
  });

  const currentProjectConfig = await fetchProjectConfig(page, accessToken, gizmoId);
  const nextFiles = [
    ...(Array.isArray(currentProjectConfig.files) ? currentProjectConfig.files : []),
    {
      file_id: createRes.file_id,
      name: fileName,
      size: fileSize,
      type:
        mimeType && mimeType !== 'application/octet-stream'
          ? mimeType
          : '',
      last_modified: lastModified,
      location: 'fs',
    },
  ];
  await upsertProject(
    page,
    accessToken,
    buildProjectUpsertPayload(currentProjectConfig, nextFiles)
  );
  await waitForProjectFileAttachment(page, accessToken, gizmoId, createRes.file_id);

  return {
    fileId: createRes.file_id,
    fileName,
    fileSize,
    mimeType,
  };
}

/**
 * 从当前项目中彻底删除文件。
 *
 * 说明：
 *   - 优先调用 /backend-api/files/{file_id}，同时删除项目 Sources 绑定和后端文件条目。
 *   - 若个别条目缺少 file_id，则回退到仅从项目配置里移除。
 *   - fileRef 支持 file_id 或文件名。
 *
 * @returns {Array<{ fileId: string, fileName: string, fileSize: number|null, mimeType: string|null }>}
 */
async function deleteProjectFile(page, fileRef) {
  const accessToken = await getAccessToken(page);
  const projectHexId = extractProjectId(page.url());
  if (!projectHexId) {
    throw new Error('当前页面不是项目页面，无法删除项目文件');
  }

  const gizmoId = `g-p-${projectHexId}`;
  const currentProjectConfig = await fetchProjectConfig(page, accessToken, gizmoId);
  const currentFiles = Array.isArray(currentProjectConfig.files) ? currentProjectConfig.files : [];
  const removedFiles = currentFiles.filter((file) => matchesProjectFileRef(file, fileRef));

  if (!removedFiles.length) {
    throw new Error(`项目中未找到文件: ${fileRef}`);
  }

  const hardDeleteTargets = removedFiles.filter((file) => file.file_id);
  for (const file of hardDeleteTargets) {
    await deleteRemoteFile(page, accessToken, file.file_id);
  }

  const softDeleteTargets = removedFiles.filter((file) => !file.file_id);
  if (softDeleteTargets.length) {
    const nextFiles = currentFiles.filter((file) => !matchesProjectFileRef(file, fileRef));
    await upsertProject(
      page,
      accessToken,
      buildProjectUpsertPayload(currentProjectConfig, nextFiles)
    );
  }

  const removedFileIds = removedFiles.map((file) => file.file_id).filter(Boolean);
  if (removedFileIds.length) {
    await waitForProjectFileRemoval(
      page,
      accessToken,
      gizmoId,
      removedFileIds
    );
  }

  return removedFiles.map((file) => ({
    fileId: file.file_id,
    fileName: file.name,
    fileSize: file.size ?? null,
    mimeType: file.type || null,
  }));
}

// ── 模型选择 ──────────────────────────────────────────────────────────────────

const AUTO_MODEL_ALIASES = /^(best|auto|highest|top|max)$/i;

async function fetchModelsCatalog(page) {
  return page.evaluate(async () => {
    const token = (await (await fetch('/api/auth/session')).json()).accessToken;
    const resp = await fetch('/backend-api/models', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new Error(`无法获取模型列表: HTTP ${resp.status}`);
    }
    return resp.json();
  });
}

function parseModelVersion(slug) {
  const match = String(slug || '').match(/gpt-(\d+)-(\d+)/i);
  if (!match) return [0, 0];
  return [Number(match[1]), Number(match[2])];
}

function scoreModelSlug(slug) {
  const [major, minor] = parseModelVersion(slug);
  const s = String(slug || '').toLowerCase();
  let lane = 0;
  if (/research/.test(s)) lane = 450;
  else if (/thinking/.test(s) && !/mini|t-mini/.test(s)) lane = 400;
  else if (/instant/.test(s)) lane = 300;
  else if (/^gpt-\d+-\d+$/.test(s) || /-wm$/.test(s)) lane = 250;
  else if (/mini|t-mini/.test(s)) lane = 100;
  else lane = 200;
  return major * 1_000_000 + minor * 10_000 + lane;
}

function pickBestModelSlug(catalog) {
  const slugs = (catalog?.models || []).map((m) => m.slug).filter(Boolean);
  if (slugs.length) {
    return slugs.sort((a, b) => scoreModelSlug(b) - scoreModelSlug(a))[0];
  }
  return catalog?.default_model_slug || null;
}

function getModelTitle(catalog, slug) {
  const model = (catalog?.models || []).find((m) => m.slug === slug);
  if (model?.title) return model.title;
  const category = (catalog?.categories || []).find((c) => c.default_model === slug);
  if (category?.human_category_short_name) return category.human_category_short_name;
  return slug;
}

function resolveModelSlug(catalog, modelName) {
  const trimmed = String(modelName || '').trim();
  if (!trimmed || AUTO_MODEL_ALIASES.test(trimmed)) {
    return pickBestModelSlug(catalog);
  }

  const target = normalizeLookupText(trimmed);
  for (const model of catalog?.models || []) {
    if (normalizeLookupText(model.slug) === target) return model.slug;
    if (normalizeLookupText(model.title).includes(target)) return model.slug;
    if (target.includes(normalizeLookupText(model.title))) return model.slug;
  }

  for (const category of catalog?.categories || []) {
    const fields = [
      category.human_category_name,
      category.human_category_short_name,
      category.action_pill_short_name,
      category.default_model,
    ];
    for (const field of fields) {
      const norm = normalizeLookupText(field);
      if (norm && (norm.includes(target) || target.includes(norm))) {
        return category.default_model;
      }
    }
  }

  if (/^[a-f0-9-]{10,}$/i.test(trimmed)) return null;
  for (const model of catalog?.models || []) {
    if (String(model.slug || '').toLowerCase().includes(trimmed.toLowerCase())) {
      return model.slug;
    }
  }
  return null;
}

async function resolveModelSelection(page, modelName) {
  const catalog = await fetchModelsCatalog(page);
  const slug = resolveModelSlug(catalog, modelName);
  if (!slug) {
    throw new Error(`找不到模型: ${modelName}`);
  }
  return {
    slug,
    title: getModelTitle(catalog, slug),
    catalog,
  };
}

function listModelChoices(catalog) {
  return (catalog?.models || []).map((model) => ({
    slug: model.slug,
    title: model.title,
    description: model.description || '',
  }));
}

function rememberPageModelSlug(page, slug) {
  if (slug) page.__chatgptModelSlug = slug;
}

async function getSendModelSlug(page, explicitSlug) {
  if (explicitSlug) return explicitSlug;
  if (page.__chatgptModelSlug) return page.__chatgptModelSlug;
  if (process.env.CHATGPT_AUTO_MODEL === '0') return null;
  const catalog = await fetchModelsCatalog(page);
  return pickBestModelSlug(catalog);
}

function patchConversationPayload(payload, { modelSlug, fileAttachments } = {}) {
  if (modelSlug) payload.model = modelSlug;
  if (fileAttachments?.length && payload.messages?.[0]) {
    const msg = payload.messages[0];
    if (!msg.metadata) msg.metadata = {};
    msg.metadata.attachments = [
      ...(msg.metadata.attachments || []),
      ...fileAttachments.map((f) => ({
        id: f.fileId,
        name: f.fileName,
        size: f.fileSize,
        mimeType: f.mimeType,
      })),
    ];
  }
  return payload;
}

async function withConversationFetchPatch(page, options, fn) {
  const modelSlug = await getSendModelSlug(page, options.modelSlug);
  const fileAttachments = options.fileAttachments || null;
  if (!modelSlug && !fileAttachments?.length) return fn();

  const cdp = await page.createCDPSession();
  await cdp.send('Fetch.enable', {
    patterns: [{
      urlPattern: '*backend-api/f/conversation',
      requestStage: 'Request',
    }],
  });

  let patched = false;
  const onPaused = async (event) => {
    const { requestId, request } = event;
    if (request.method === 'POST' && request.postData && !patched) {
      patched = true;
      try {
        const payload = patchConversationPayload(JSON.parse(request.postData), {
          modelSlug,
          fileAttachments,
        });
        await cdp.send('Fetch.continueRequest', {
          requestId,
          postData: Buffer.from(JSON.stringify(payload)).toString('base64'),
        });
        return;
      } catch {}
    }
    await cdp.send('Fetch.continueRequest', { requestId });
  };

  cdp.on('Fetch.requestPaused', onPaused);
  try {
    return await fn();
  } finally {
    cdp.off('Fetch.requestPaused', onPaused);
    await cdp.send('Fetch.disable').catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

async function trySelectModelInUi(page, selection) {
  const target = normalizeLookupText(selection.title || selection.slug);
  const trigger = (await page.$(S.model.trigger)) || null;
  if (trigger) {
    await trigger.click();
    await page.waitForFunction(
      (optionSelector, normalizedTarget) => {
        const normalize = (value) =>
          String(value || '')
            .toLowerCase()
            .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        return Array.from(document.querySelectorAll(optionSelector)).some(
          (el) => isVisible(el) && normalize(el.innerText).includes(normalizedTarget)
        );
      },
      { timeout: 5_000 },
      S.model.options,
      target
    ).catch(() => null);
    const selected = await page.evaluate((optionSelector, normalizedTarget) => {
      const normalize = (value) =>
        String(value || '')
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const targetOption = Array.from(document.querySelectorAll(optionSelector)).find(
        (el) => isVisible(el) && normalize(el.innerText).includes(normalizedTarget)
      );
      if (!targetOption) return null;
      targetOption.click();
      return (targetOption.innerText || '').trim();
    }, S.model.options, target);
    if (selected) {
      await sleep(300);
      return selected;
    }
  }

  const labels = new Set([
    selection.title,
    ...(selection.catalog?.categories || [])
      .filter((c) => c.default_model === selection.slug)
      .flatMap((c) => [c.action_pill_short_name, c.human_category_short_name]),
  ].filter(Boolean));

  for (const label of labels) {
    const clicked = await page.evaluate((text) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const btn = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find((el) => norm(el.innerText) === text || norm(el.getAttribute('aria-label')) === text);
      if (!btn) return false;
      btn.click();
      return true;
    }, label);
    if (clicked) {
      await sleep(300);
      return label;
    }
  }
  return null;
}

/**
 * 解析并记录模型选择。新版 ChatGPT 常无 DOM 模型选择器，发送时通过
 * backend-api/f/conversation 的 model 字段注入 slug。
 */
async function selectModel(page, modelName) {
  const selection = await resolveModelSelection(page, modelName);
  rememberPageModelSlug(page, selection.slug);
  await trySelectModelInUi(page, selection).catch(() => {});
  return selection.title;
}

async function selectBestModel(page) {
  return selectModel(page, 'best');
}

// ── 对话快照 ──────────────────────────────────────────────────────────────────

async function fetchConversationApiPayload(page, conversationId) {
  const accessToken = await getAccessToken(page);
  return page.evaluate(async (id, token) => {
    try {
      const resp = await fetch(`/backend-api/conversation/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }, conversationId, accessToken);
}

async function getConversationSnapshotFromDom(page) {
  return page.evaluate((allMsgSelector, markdownSelector) => {
    const normalizeText = (value) =>
      String(value || '').replace(/\u200b/g, '').trim();

    const isVisible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const looksLikeFile = (value) =>
      /[a-z0-9][a-z0-9._ -]*\.(txt|md|json|csv|xml|ya?ml|pdf|png|jpe?g|gif|svg|zip|gz|py|js|ts|html|css|docx?|xlsx?|pptx?|rtf)$/i
        .test(String(value || '').trim());

    const messages = Array.from(document.querySelectorAll(allMsgSelector))
      .map((messageEl, index) => {
        const role =
          messageEl.getAttribute('data-message-author-role') || 'unknown';
        const root = messageEl.closest('article') || messageEl;
        const markdown = messageEl.querySelector(markdownSelector) || messageEl;
        const text = normalizeText(markdown.innerText || messageEl.innerText);

        const seen = new Set();
        const files = Array.from(
          root.querySelectorAll('a, button, [role="button"], div, span')
        )
          .filter(isVisible)
          .map((el) => {
            const href = el.getAttribute('href') || null;
            const download = el.getAttribute('download') || null;
            const label = normalizeText(
              download ||
                el.getAttribute('aria-label') ||
                el.innerText ||
                ''
            );
            const testId = String(el.getAttribute('data-testid') || '').toLowerCase();
            const match = label.match(
              /[a-z0-9][a-z0-9._ -]*\.[a-z0-9]{1,10}/i
            );
            const name = download || (match ? match[0].trim() : null);
            const isFileLike = Boolean(
              download ||
                (href && /\/files\/|download|blob:/i.test(href)) ||
                testId.includes('attachment') ||
                testId.includes('file') ||
                (name && looksLikeFile(name))
            );

            if (!isFileLike) return null;

            const key = [href || '', name || '', label].join('|');
            if (seen.has(key)) return null;
            seen.add(key);

            return {
              id: null,
              name,
              mimeType: null,
              size: null,
              url: href,
              content: label && label !== name ? label : null,
            };
          })
          .filter(Boolean);

        return {
          id: `dom-${index}`,
          role,
          text,
          files,
        };
      })
      .filter((message) => message.text || message.files.length);

    const fileSeen = new Set();
    const files = [];
    for (const message of messages) {
      for (const file of message.files) {
        const key = [file.id || '', file.url || '', file.name || ''].join('|');
        if (fileSeen.has(key)) continue;
        fileSeen.add(key);
        files.push(file);
      }
    }

    return {
      id: null,
      title: document.title || null,
      messages,
      files,
      source: 'dom',
    };
  }, S.response.allMessages, S.response.messageContent);
}

async function tryReadTextFile(page, file) {
  if (!file?.url || !isTextLikeFile(file)) {
    return null;
  }

  return page.evaluate(async (url) => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const text = await resp.text();
      if (text.length <= 100_000) return text;
      return `${text.slice(0, 100_000)}\n\n...[truncated]`;
    } catch {
      return null;
    }
  }, file.url);
}

async function hydrateConversationSnapshotFiles(page, snapshot) {
  const cache = new Map();

  for (const message of snapshot.messages) {
    const hydrated = [];
    for (const file of message.files || []) {
      const key = [file.id || '', file.url || '', file.name || ''].join('|');
      if (!cache.has(key)) {
        const fetchedContent = await tryReadTextFile(page, file);
        cache.set(key, {
          ...file,
          content:
            fetchedContent ||
            (file.content && file.content !== file.name ? file.content : null),
        });
      }
      hydrated.push(cache.get(key));
    }
    message.files = hydrated;
  }

  snapshot.files = dedupeFiles(
    snapshot.messages.flatMap((message) => message.files || [])
  );
  return snapshot;
}

async function getConversationSnapshot(page, conversationId) {
  const apiPayload = conversationId
    ? await fetchConversationApiPayload(page, conversationId).catch(() => null)
    : null;
  const apiSnapshot = normalizeConversationApiPayload(apiPayload);
  const domSnapshot = await getConversationSnapshotFromDom(page).catch(
    () => null
  );

  const snapshot =
    mergeConversationSnapshots(apiSnapshot, domSnapshot) ||
    {
      id: conversationId || null,
      title: null,
      messages: [],
      files: [],
      source: 'empty',
    };

  snapshot.id = snapshot.id || conversationId || null;
  snapshot.completion =
    extractConversationCompletion(apiPayload) || snapshot.completion || null;
  return hydrateConversationSnapshotFiles(page, snapshot);
}

// 从 snapshot.messages 取最后一条非空 assistant 文本。
// 用于 backend-api 是真正的"完成"信号源（DOM 在 thinking 模型上会失真）。
function getLastAssistantFromSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.messages)) return '';
  for (let i = snapshot.messages.length - 1; i >= 0; i--) {
    const msg = snapshot.messages[i];
    if (msg && msg.role === 'assistant') {
      const text = String(msg.text || '').trim();
      if (text) return text;
    }
  }
  return '';
}

async function getConversationStatus(
  page,
  conversationId = null,
  projectRef = null
) {
  if (
    conversationId &&
    !page.url().includes(`/c/${conversationId}`)
  ) {
    await navigateToConversation(page, conversationId, projectRef);
  }

  const domStatus = await page.evaluate(
    (stopSel, allMsgSel, assistantSel, mdSel) => {
      const normalizeText = (value) =>
        String(value || '').replace(/\u200b/g, '').trim();

      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const allMessages = Array.from(document.querySelectorAll(allMsgSel));
      const assistantMessages = Array.from(document.querySelectorAll(assistantSel));
      const lastMessage = allMessages[allMessages.length - 1] || null;
      const lastAssistant = assistantMessages[assistantMessages.length - 1] || null;
      const lastAssistantMarkdown =
        lastAssistant?.querySelector(mdSel) || lastAssistant;

      return {
        url: location.href,
        isResponding: isVisible(document.querySelector(stopSel)),
        messageCount: allMessages.length,
        assistantMessageCount: assistantMessages.length,
        lastMessageRole:
          lastMessage?.getAttribute('data-message-author-role') || null,
        lastAssistantText: normalizeText(
          lastAssistantMarkdown?.innerText || lastAssistant?.innerText || ''
        ),
      };
    },
    S.composer.stopBtn,
    S.response.allMessages,
    S.response.assistantMsgs,
    S.response.messageContent
  );

  let resolvedConversationId = conversationId || null;
  if (!resolvedConversationId) {
    try {
      resolvedConversationId = extractConversationId(domStatus.url);
    } catch {
      resolvedConversationId = null;
    }
  }

  // turn_3 §4.2 / turn_4 B1 收紧：DOM 上 lastAssistantText 在 thinking
  // 模型流式输出期间会"看起来稳定"或干脆为空。对 status 调用，我们顺手用
  // backend-api 重新拿一次最后 assistant 文本与消息计数；失败则退回 DOM，
  // 并把 snapshot 错误暴露给上层 wait loop 用 streak/backoff 判定。
  let apiLastAssistantText = '';
  let apiMessageCount = null;
  let apiAssistantMessageCount = null;
  let snapshotOk = false;
  let snapshotError = null;
  let snapshotCompletion = null;
  if (resolvedConversationId) {
    try {
      const snapshot = await getConversationSnapshot(page, resolvedConversationId);
      snapshotOk = true;
      snapshotCompletion = snapshot.completion || null;
      apiLastAssistantText = getLastAssistantFromSnapshot(snapshot);
      apiMessageCount = snapshot.messages?.length ?? null;
      apiAssistantMessageCount = (snapshot.messages || []).filter(
        (m) => m && m.role === 'assistant'
      ).length;
    } catch (err) {
      snapshotError = String(err && err.message ? err.message : err);
    }
  }

  const turnComplete = isConversationTurnComplete(snapshotCompletion);
  const stillGenerating = Boolean(domStatus.isResponding) || turnComplete === false;

  return {
    conversationId: resolvedConversationId,
    url: domStatus.url,
    state: stillGenerating ? 'running' : 'completed',
    isResponding: stillGenerating,
    messageCount: apiMessageCount ?? domStatus.messageCount,
    assistantMessageCount: apiAssistantMessageCount ?? domStatus.assistantMessageCount,
    lastMessageRole: domStatus.lastMessageRole,
    lastAssistantText: apiLastAssistantText || domStatus.lastAssistantText,
    snapshotOk,
    snapshotError,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * 等待对话完成生成（status --wait / Conversation.waitUntilComplete 路径）。
 *
 * 与 sendMessage 复用同一个 ResponseTracker 完成判定：
 *   - requireNewActivity=false：status --wait 观察的是「当前对话是否结束」；
 *   - backend async_status / reasoning_status 为未完成时不得返回 completed；
 *   - 信号不足时退回 DOM quiet + 连续 snapshot 稳定；
 *   - 保留旧签名的 options（timeout / pollInterval / stablePolls）。
 *
 * @returns {Promise<object>} 与旧版 getConversationStatus 兼容的状态对象
 */
async function waitForConversationCompletion(
  page,
  conversationId = null,
  projectRef = null,
  options = {}
) {
  const {
    timeout = REPLY_TIMEOUT,
    pollInterval = 2_000,
    minAssistantCount = null,
    stablePolls = 4,
    completeSettleMs = 20_000,
  } = options;

  if (
    conversationId &&
    !page.url().includes(`/c/${conversationId}`)
  ) {
    await navigateToConversation(page, conversationId, projectRef);
  }

  let resolvedConversationId = conversationId || null;
  if (!resolvedConversationId) {
    try {
      resolvedConversationId = extractConversationId(page.url());
    } catch {
      resolvedConversationId = null;
    }
  }

  const tracker = new ResponseTracker(page, {
    previousAssistantCount: null,
    conversationId: resolvedConversationId,
    requireNewActivity: false,
    timeout,
    stablePolls: Math.max(stablePolls, 4),
    completeSettleMs,
    // watchdog 兼作低频 backend 校验间隔（沿用 pollInterval，但不低于 2s）
    domEventGapMs: Math.max(pollInterval, 2_000),
    quietWindowMs: 8_000,
    backend: _trackerBackend(page),
  });

  await tracker.start();
  let result;
  try {
    result = await tracker.waitForComplete();
  } finally {
    await tracker.stop().catch(() => {});
  }

  const sample = result.sample || {};
  const status = {
    conversationId: result.conversationId || resolvedConversationId,
    url: sample.url || page.url(),
    state: result.state === 'completed' ? 'completed' : result.state,
    isResponding: Boolean(sample.isResponding),
    messageCount: sample.messageCount ?? 0,
    assistantMessageCount: sample.assistantMessageCount ?? 0,
    lastMessageRole: sample.lastMessageRole ?? null,
    lastAssistantText: result.text || '',
    snapshotOk: result.snapshotErrorStreak === 0,
    snapshotError: result.snapshotError || null,
    checkedAt: result.checkedAt,
  };

  if (result.state === 'completed') {
    if (minAssistantCount != null) {
      status.assistantMessageCount = Math.max(
        status.assistantMessageCount,
        minAssistantCount
      );
    }
    return status;
  }

  if (result.state === 'unknown') {
    return {
      ...status,
      state: 'unknown',
      backendUnavailable: true,
      snapshotErrorStreak: result.snapshotErrorStreak,
      snapshotError: result.snapshotError,
    };
  }

  throw new Error(`等待对话完成超时: ${timeout}ms`);
}

/**
 * 发送消息并附带文件。
 *
 * 策略：通过 CDP Fetch.enable 拦截 /backend-api/f/conversation 请求，
 * 注入 metadata.attachments 后放行。
 *
 * @param {Page} page
 * @param {string} text           消息文本
 * @param {Array} fileAttachments 文件附件信息数组 [{ fileId, fileName, fileSize, mimeType }]
 * @returns {Promise<string>}     assistant 回复文本
 */
async function sendMessageWithFiles(page, text, fileAttachments, options = {}) {
  // 记录发送前的 assistant 消息数量
  const prevAssistantCount = await page.evaluate(
    (sel) => document.querySelectorAll(sel).length,
    S.response.assistantMsgs
  );

  // 输入消息
  await page.evaluate((msg) => {
    const el = document.querySelector('#prompt-textarea');
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, msg);
  }, text);
  await sleep(800);

  // 等待 send 按钮就绪
  await page.waitForSelector(S.composer.sendBtn, { timeout: 5000 });
  await waitForEnabled(page, S.composer.sendBtn, 30_000);

  const content = await withConversationFetchPatch(
    page,
    { modelSlug: options.modelSlug, fileAttachments },
    async () =>
      _runTracker(
        page,
        prevAssistantCount,
        async () => {
          await page.evaluate((sel) => document.querySelector(sel).click(), S.composer.sendBtn);
        },
        { onState: options.onState }
      )
  );

  return content;
}

// ── 对话 ──────────────────────────────────────────────────────────────────────

/**
 * 内部：构造 ResponseTracker 所需的 backend 兜底能力。
 * backend-api（getConversationSnapshot / getLastAssistantFromSnapshot）
 * 继续保留，但只在 tracker 判定「确认完成 / DOM 空文本 / DOM 事件静默 /
 * 超时」时被调用，不再 2s 高频轮询。
 */
function _trackerBackend(page) {
  return {
    getSnapshot: (conversationId) =>
      getConversationSnapshot(page, conversationId),
    getLastAssistantText: (snapshot) => getLastAssistantFromSnapshot(snapshot),
    isTurnComplete: (snapshot) =>
      isConversationTurnComplete(snapshot && snapshot.completion),
  };
}

/**
 * 内部：把 tracker 结果转换为回复文本或抛出错误。
 */
function _resolveTrackerResult(result, timeoutMs) {
  if (result && result.state === 'completed' && result.text && result.text.trim()) {
    return result.text;
  }
  if (result && result.state === 'unknown') {
    throw new Error(
      `backend snapshot 持续不可用且 DOM 无回复文本${
        result.snapshotError ? `: ${result.snapshotError}` : ''
      }`
    );
  }
  throw new Error(`等待 assistant 回复超时: ${timeoutMs}ms`);
}

/**
 * 内部：运行一次 ResponseTracker 到完成。
 *
 * 事件驱动改造（原 2s 轮询 × 5 轮稳定判定 → MutationObserver + debounce）：
 *   - 主路径：页面内 MutationObserver 实时推送 assistant 文本 / stop 按钮
 *     状态变化，Node 侧维护 IDLE → RESPONDING → CANDIDATE_COMPLETE → COMPLETE
 *     状态机，用 quiet window（默认 600ms，长响应自动放大到 2.5s）debounce；
 *   - 兜底：backend snapshot 只在确认完成 / DOM 空文本 / DOM 事件静默 /
 *     超时时调用；backend 持续 5xx 且 DOM 无文本时返回 unknown，不无限等待；
 *   - thinking 模型兼容：stop 按钮短暂消失后重新出现会撤销 CANDIDATE_COMPLETE；
 *     DOM 空文本但 backend 已有最终答案时走 backend-fallback。
 *
 * @param {Page} page
 * @param {number} prevAssistantCount 发送前的 assistant 消息数
 * @param {Function|null} sendAction  可选：在 observer 安装后执行的发送动作
 * @param {object} [options]
 * @param {Function} [options.onState] UI 状态回调（responding / generating / complete ...）
 * @returns {Promise<string>} assistant 回复文本
 */
async function _runTracker(page, prevAssistantCount, sendAction, options = {}) {
  const tracker = new ResponseTracker(page, {
    previousAssistantCount: prevAssistantCount,
    requireNewActivity: true,
    backend: _trackerBackend(page),
    onState: options.onState,
  });

  // 先安装 observer 再执行发送动作，确保极快回复也能被完整观察到。
  await tracker.start();
  let result;
  try {
    if (typeof sendAction === 'function') await sendAction();
    result = await tracker.waitForComplete();
  } finally {
    await tracker.stop().catch(() => {});
  }
  return _resolveTrackerResult(result, tracker.timeoutMs);
}

/**
 * 内部：等待 assistant 回复完成并返回文本（发送动作已在外部完成）。
 * 保留此入口以兼容 startMessage 之外、observer 需在点击后安装的调用路径。
 */
async function _waitForReply(page, prevAssistantCount, options = {}) {
  return _runTracker(page, prevAssistantCount, null, options);
}

/**
 * 在当前对话中发送消息，等待完整回复后返回文本。
 *
 * 完成检测策略（事件驱动）：
 *   1. 主路径：MutationObserver 实时观察 assistant 文本 / stop 按钮变化，
 *      quiet window debounce 判定完成（见 response-tracker.js）；
 *   2. 兜底：backend snapshot 在确认完成 / DOM 空文本 / DOM 事件静默 / 超时时校验。
 *
 * @param {Page} page
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.modelSlug]
 * @param {Function} [options.onState] UI 状态回调（responding / generating / complete ...）
 */
async function sendMessage(page, text, options = {}) {
  const prevAssistantCount = await page.evaluate(
    (sel) => document.querySelectorAll(sel).length,
    S.response.assistantMsgs
  );

  // 输入消息（ProseMirror contenteditable）
  await page.evaluate((msg) => {
    const el = document.querySelector('#prompt-textarea');
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, msg);
  }, text);
  await sleep(800);

  return withConversationFetchPatch(page, { modelSlug: options.modelSlug }, async () =>
    _runTracker(
      page,
      prevAssistantCount,
      async () => {
        // observer 已由 tracker.start() 安装，此处再触发发送，确保极快回复也被观察到
        try {
          await page.waitForSelector(S.composer.sendBtn, { timeout: 5_000 });
          await waitForEnabled(page, S.composer.sendBtn, 15_000);
          await page.evaluate((sel) => document.querySelector(sel).click(), S.composer.sendBtn);
        } catch {
          await page.keyboard.press('Enter');
        }
      },
      { onState: options.onState }
    )
  );
}

/**
 * 类似 sendMessage，但**只**发送消息并尽快拿到 conversationId，**不**等待回复。
 *
 * 设计意图（turn_3 §4.1）：
 *   - PR-7 ChatGPTIterationRunner 用 backend snapshot/status 判完成，
 *     不依赖 DOM 完成判定。
 *   - DOM 完成判定在 thinking 模型上常常返回空 lastAssistantText，
 *     导致 send 误超时。
 *
 * 返回 `{ conversationId, prevAssistantCount, url, state, checkedAt }`。
 */
async function startMessage(page, text, options = {}) {
  const prevAssistantCount = await page.evaluate(
    (sel) => document.querySelectorAll(sel).length,
    S.response.assistantMsgs
  );

  await page.evaluate((msg) => {
    const el = document.querySelector('#prompt-textarea');
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, msg);
  }, text);
  await sleep(800);

  await withConversationFetchPatch(page, { modelSlug: options.modelSlug }, async () => {
    try {
      await page.waitForSelector(S.composer.sendBtn, { timeout: 5_000 });
      await waitForEnabled(page, S.composer.sendBtn, 15_000);
      await page.evaluate(
        (sel) => document.querySelector(sel).click(),
        S.composer.sendBtn
      );
    } catch {
      await page.keyboard.press('Enter');
    }
  });

  // 第一轮：等 URL 跳到 /c/<id>。后续轮（已经在对话页）：当前 URL 即可。
  // thinking 模型可能要 30s+ 才会跳转，所以总等待预算放宽到 START_CONV_ID_TIMEOUT。
  const startConvIdTimeout = Math.max(
    5_000,
    Number(process.env.CHATGPT_START_CONV_ID_TIMEOUT_MS || 90_000)
  );
  let conversationId = null;
  try {
    conversationId = extractConversationId(page.url());
  } catch {
    conversationId = null;
  }
  if (!conversationId) {
    conversationId = await waitForConversationId(page, startConvIdTimeout).catch(() => null);
  }
  // 兜底：waitForConversationId 可能在边界时序下未捕获到，但此刻 URL 已经更新；再尝试一次。
  if (!conversationId) {
    try {
      conversationId = extractConversationId(page.url());
    } catch {
      conversationId = null;
    }
  }

  return {
    conversationId,
    prevAssistantCount,
    url: page.url(),
    state: 'started',
    checkedAt: new Date().toISOString(),
  };
}

/**
 * 等待 URL 中出现 /c/{id} 并提取 conversation id。
 */
async function waitForConversationId(page, timeout = 30_000) {
  await page.waitForFunction(() => location.href.includes('/c/'), { timeout });
  return extractConversationId(page.url());
}

module.exports = {
  // URL 解析
  extractProjectId,
  extractProjectPath,
  extractConversationId,
  normalizeProjectHomePath,
  isConversationPath,
  // 导航
  navigateToProject,
  navigateToProjectHome,
  navigateToConversation,
  createProject,
  selectModel,
  selectBestModel,
  fetchModelsCatalog,
  pickBestModelSlug,
  listModelChoices,
  resolveModelSelection,
  // 文件
  apiUploadConversationAttachment,
  uploadProjectFile,
  deleteProjectFile,
  sendMessageWithFiles,
  // 对话
  getConversationStatus,
  waitForConversationCompletion,
  getConversationSnapshot,
  getLastAssistantFromSnapshot,
  extractConversationCompletion,
  isConversationTurnComplete,
  startMessage,
  sendMessage,
  waitForConversationId,
};
