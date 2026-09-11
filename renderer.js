/**
 * renderer.js — CLI 表现层
 *
 * 职责：
 *   1. Markdown → 终端富文本渲染（marked + marked-terminal）
 *   2. 提供语义化状态输出 API（success / warning / error / info / prompt ...）
 *
 * 架构约束：
 *   - 业务代码（cli / commands）只调用语义 API，不直接决定颜色
 *   - 所有颜色 / 符号 token 来自 theme.js，与 Landing Page 视觉语义一致
 *   - 不引入重型 TUI 框架（保持 chalk / marked / marked-terminal / ora）
 *   - --json 模式下 CLI 层不会调用本模块（stdout 保持纯 JSON）
 */

const chalk = require('chalk');
const { marked } = require('marked');
const { markedTerminal } = require('marked-terminal');
const { color, symbol, c, bold } = require('./theme');

marked.use(
  markedTerminal({
    reflowText: true,
    width: Math.min(process.stdout.columns || 80, 120),
    tab: 2,
    code: chalk.hex(color.primary),
    codespan: chalk.hex(color.primary),
    blockquote: chalk.hex(color.muted).italic,
    strong: chalk.bold,
    em: chalk.italic,
    heading: bold.bright,
  })
);

// ── Markdown ──────────────────────────────────────────────────────────────────

function renderMarkdown(text) {
  if (!text) return '';
  return marked(text).trimEnd();
}

function assistant(text) {
  return renderMarkdown(text);
}

// ── 状态行（语义 API）─────────────────────────────────────────────────────────
//
// 统一格式：  <符号> <label>  <detail>
// 例：        ✓ Project  my-app
//             × Connection failed
//               Chrome CDP endpoint unavailable: 172.x.x.x:9224

function statusLine(sym, symColor, label, detail) {
  const head = `${symColor(sym)} ${bold.bright(label || '')}`.trimEnd();
  if (detail == null || detail === '') return head;
  return `${head}  ${c.muted(detail)}`;
}

function success(label, detail) {
  return statusLine(symbol.success, bold.success, label, detail);
}

function warning(label, detail) {
  return statusLine(symbol.warning, bold.warning, label, detail);
}

function error(label, detail) {
  return statusLine(symbol.error, bold.error, label, detail);
}

function info(label, detail) {
  return statusLine(symbol.prompt, bold.primary, label, detail);
}

/** 次级说明文本（无符号），用于列表、ID、计数等 */
function dim(text) {
  return c.dim(text);
}

function muted(text) {
  return c.muted(text);
}

/** 缩进的续行（错误详情、补充说明） */
function detailLine(text) {
  return `  ${c.muted(text)}`;
}

/** 强调文本（命令 usage、标题等） */
function strong(text) {
  return bold.bright(text);
}

/** 代码 / 示例片段（primary 色） */
function code(text) {
  return c.primary(text);
}

// ── 对话视觉 ──────────────────────────────────────────────────────────────────

/** 用户输入提示符：● >  */
function promptMarker() {
  return `${bold.primary(symbol.prompt)} ${bold.bright('>')}`;
}

/** assistant 回复头：ChatGPT  <model>  */
function assistantHeader(modelName, extra) {
  const parts = [bold.bright('ChatGPT')];
  if (modelName) parts.push(c.muted(modelName));
  if (extra) parts.push(c.primary(extra));
  return parts.join('  ');
}

/** thinking / generating 中间状态（单行，可被覆盖刷新） */
function thinking(elapsedText) {
  const badge = elapsedText ? ` ${c.primary(elapsedText)}` : '';
  return `${c.primary(symbol.thinking)}${badge}`;
}

/** 生成完成：✓ Finished generation · 1.48s */
function generationDone(elapsedText) {
  return `${bold.success(symbol.success)} ${c.muted('Finished generation')}${
    elapsedText ? c.dim(` · ${elapsedText}`) : ''
  }`;
}

/** 分隔线 */
function separator(width) {
  const w = width || Math.min(process.stdout.columns || 80, 72);
  return c.border(symbol.separator.repeat(Math.max(8, w)));
}

/** 启动横幅 */
function banner(title, subtitle) {
  const lines = [bold.bright(title || 'ChatGPT CLI')];
  if (subtitle) lines.push(c.dim(subtitle));
  return lines.join('\n');
}

/** 用户消息回显（REPL 中一般由 readline 自带，这里供非交互/日志用） */
function user(text) {
  return `${promptMarker()} ${c.bright(text)}`;
}

function system(text) {
  return c.dim(text);
}

// ── 兼容旧 API（逐步迁移，避免一次性破坏 commands.js）─────────────────────────
//
// 旧：ok / warn / err / info(msg) 单参数 → 新语义 API 的薄封装。
// 单参数调用时把整段文本作为 label，保持向后兼容。

function ok(msg) {
  return success(msg);
}
function warn(msg) {
  return warning(msg);
}
function err(msg) {
  return error(msg);
}

function statusBar(parts) {
  const segments = parts.filter(Boolean).map((p) => c.muted(p));
  return `${c.border(symbol.separator)} ${segments.join(c.dim(' · '))} ${c.border(
    symbol.separator.repeat(4)
  )}`;
}

module.exports = {
  // markdown
  renderMarkdown,
  assistant,
  // 语义状态
  success,
  warning,
  error,
  info,
  dim,
  muted,
  detailLine,
  strong,
  code,
  // 对话视觉
  promptMarker,
  assistantHeader,
  thinking,
  generationDone,
  separator,
  banner,
  user,
  system,
  // 兼容旧 API
  ok,
  warn,
  err,
  statusBar,
};
