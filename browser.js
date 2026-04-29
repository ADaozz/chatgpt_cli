/**
 * browser.js — 浏览器连接的传输层
 *
 * 职责边界：
 *   - 只负责建立和关闭 puppeteer 连接
 *   - 不知道 ChatGPT，不知道对话
 *   - 暴露 `page` 对象，供 adapter 使用
 */

const puppeteer = require('puppeteer-core');

/**
 * 连接到已运行的远程浏览器（必须以 --remote-debugging-port 启动）。
 *
 * @param {string} browserURL  e.g. "http://192.168.1.62:9224"
 * @returns {Promise<{browser: Browser, page: Page}>}
 */
async function connect(browserURL) {
  const browser = await puppeteer.connect({
    browserURL,
    defaultViewport: null, // 保持浏览器原始视口，避免布局破坏
    protocolTimeout: 600_000, // 10 分钟（GPT-5-4-Pro extended thinking 可能很久）
  });

  // 复用已有的 ChatGPT 标签页，而不是新开一个
  const pages = await browser.pages();
  const page =
    pages.find((p) => p.url().includes('chatgpt.com')) || pages[0];

  if (!page) throw new Error('远程浏览器中没有可用的标签页');

  // 确保 ChatGPT 已加载（而不是 about:blank）
  if (!page.url().includes('chatgpt.com')) {
    await page.goto('https://chatgpt.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
  }

  return { browser, page };
}

module.exports = { connect };
