/**
 * project-controller.js — 项目导航 / 创建 / 列表
 *
 * 侧栏行选择器（[class*="project-unfurl-row"]、打开项目首页按钮）继承自
 * v1.2.2（2026-09/10 验证），标注 probe-pending：下次实机采集时复核。
 * 创建走 /backend-api/gizmos/snorlax/upsert（写载荷 probe-pending）。
 */

'use strict';

const S = require('./selectors');
const {
  extractProjectId,
  extractProjectPath,
  normalizeProjectHomePath,
} = require('./url-utils');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_TIMEOUT = 15_000;

class ProjectController {
  constructor({ pageController, protocol, files }) {
    this.pages = pageController;
    this.protocol = protocol;
    this.files = files;
  }

  async ensureSidebar() {
    const hasLinks = await this.pages.page.evaluate(
      (sel) => Boolean(document.querySelector(sel.sidebarLinks)),
      S.project
    );
    if (!hasLinks) {
      await this.pages.page.goto('https://chatgpt.com', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      }).catch(() => {});
      await sleep(1200);
    }
  }

  /** 在文档中按项目名 / gizmo id 找项目主页 href。 */
  async findProjectHref(projectName) {
    return this.pages.page.evaluate((name) => {
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

  /** 通过侧栏行进入项目（新版侧栏需 hover 后点「打开项目首页」）。 */
  async navigateViaSidebarRow(projectName) {
    await this.ensureSidebar();
    const rowHandle = await this.pages.page.evaluateHandle((name) => {
      const norm = (s) =>
        (s || '').toLowerCase().replace(/[\u200b\uFEFF]/g, '').replace(/[-_\s]+/g, ' ').trim();
      const needle = norm(name);
      const slugNeedle = name
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9\u4e00-\u9fff-]/gi, '');
      for (const row of document.querySelectorAll('[class*="project-unfurl-row"]')) {
        const label =
          (row.querySelector('[data-marquee-text]') || {}).textContent ||
          (row.querySelector('[role="button"]') || {}).textContent ||
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
      await rowHandle.dispose().catch(() => {});
      return null;
    }

    await row.hover().catch(() => {});
    await sleep(300);

    const homeBtn =
      (await row.$('button[aria-label="打开项目首页"]')) ||
      (await row.$('button[aria-label*="打开项目首页"]'));
    if (!homeBtn) {
      await rowHandle.dispose().catch(() => {});
      return null;
    }

    await Promise.all([
      this.pages.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT }).catch(() => null),
      homeBtn.click(),
    ]);
    await rowHandle.dispose().catch(() => {});
    await sleep(500);

    const projectPath = extractProjectPath(this.pages.url());
    if (!projectPath) return null;
    return { projectId: extractProjectId(this.pages.url()), projectPath };
  }

  /**
   * 打开项目（支持名称 / g-p id / 完整 URL）。
   * @returns {Promise<{projectId, projectPath}>}
   */
  async openProject(projectRef) {
    const direct = normalizeProjectHomePath(projectRef);
    if (direct) {
      await this.pages.gotoProjectHome(direct);
      return { projectId: extractProjectId(this.pages.url()), projectPath: extractProjectPath(this.pages.url()) || direct };
    }

    const viaSidebar = await this.navigateViaSidebarRow(projectRef).catch(() => null);
    if (viaSidebar) return viaSidebar;

    const href = await this.findProjectHref(projectRef).catch(() => null);
    if (href) {
      await this.pages.gotoProjectHome(href);
      return { projectId: extractProjectId(this.pages.url()), projectPath: extractProjectPath(this.pages.url()) };
    }

    throw new Error(`找不到项目: ${projectRef}`);
  }

  /** 当前项目上下文（基于 URL）。 */
  currentProject() {
    const url = this.pages.url();
    const projectId = extractProjectId(url);
    const projectPath = extractProjectPath(url);
    return projectId ? { projectId, projectPath } : null;
  }

  /** 创建项目（upsert 后 UI 会自动跳转，用 race 提取路径）。 */
  async createProject(projectName) {
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
      tools: [{ type: 'retrieval' }, { type: 'python' }],
      memory_scope: 'unset',
      files: [],
      training_disabled: false,
      sharing: [{ type: 'private', capabilities: PROJECT_VIEWER_CAPABILITIES }],
    };

    let projectPath = null;
    const evalPromise = this.protocol.upsertProject(payload).catch(() => null);
    const navPromise = this.pages.page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT })
      .then(() => 'navigated')
      .catch(() => null);

    const race = await Promise.race([
      evalPromise.then((r) => ({ type: 'eval', data: r })),
      navPromise.then((v) => (v ? { type: 'nav' } : new Promise(() => {}))),
    ]).catch(() => null);

    if (race && race.type === 'eval' && race.data) {
      const gizmo = race.data.resource?.gizmo || race.data.gizmo || race.data;
      const id = gizmo?.id || gizmo?.gizmo_id;
      if (id) {
        const slug = (gizmo?.short_url || '').split('g-p-')[1] || gizmo?.slug || id;
        projectPath = `/g/${id.startsWith('g-p-') ? id : `g-p-${id}`}${id.startsWith('g-p-') ? '' : slug !== id ? `-${slug}` : ''}`.replace(/--+/g, '-');
        if (!/\/project$/.test(projectPath)) {
          projectPath = `/g/${id.startsWith('g-p-') ? id : `g-p-${slug}`}/project`;
        }
      }
    }
    if (!projectPath) {
      await sleep(2000);
      projectPath = normalizeProjectHomePath(this.pages.url());
    }
    if (!projectPath) {
      throw new Error(`创建项目后无法确定项目路径（当前 URL: ${this.pages.url()}）`);
    }
    await this.pages.gotoProjectHome(projectPath);
    return {
      projectId: extractProjectId(this.pages.url()),
      projectPath: extractProjectPath(this.pages.url()) || projectPath,
    };
  }

  /** 项目会话列表（走 gizmo conversations 端点）。 */
  async listProjectConversations(gizmoId, { limit = 20 } = {}) {
    const payload = await this.protocol.listConversations({ limit, gizmoId });
    return Array.isArray(payload?.items) ? payload.items : (Array.isArray(payload) ? payload : []);
  }

  /** 项目 Sources 文件列表（来自 gizmo 配置）。 */
  async listProjectFiles(gizmoId) {
    const config = await this.protocol.fetchGizmoConfig(gizmoId);
    return Array.isArray(config.files) ? config.files : [];
  }
}

const PROJECT_VIEWER_CAPABILITIES = {
  can_read: true, can_view_config: false, can_write: false,
  can_delete: false, can_export: false, can_share: false,
};

module.exports = { ProjectController };
