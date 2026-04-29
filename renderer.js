/**
 * renderer.js — Markdown → 终端富文本渲染
 *
 * 职责：把 ChatGPT 返回的 Markdown 文本渲染成带颜色、代码高亮的终端输出。
 * 同时提供状态消息（ok / warn / err / info）的统一格式。
 */

const chalk = require('chalk');
const { marked } = require('marked');
const { markedTerminal } = require('marked-terminal');

marked.use(
  markedTerminal({
    reflowText: true,
    width: Math.min(process.stdout.columns || 80, 120),
    tab: 2,
    code: chalk.cyan,
    codespan: chalk.cyan,
    blockquote: chalk.gray.italic,
    strong: chalk.bold,
    em: chalk.italic,
    heading: chalk.bold.white,
  })
);

function renderMarkdown(text) {
  if (!text) return '';
  return marked(text).trimEnd();
}

function ok(msg) {
  return `${chalk.bold.green('[OK]')} ${msg}`;
}

function warn(msg) {
  return `${chalk.bold.yellow('[!]')} ${msg}`;
}

function err(msg) {
  return `${chalk.bold.red('[ERR]')} ${msg}`;
}

function info(msg) {
  return `${chalk.bold.cyan('[*]')} ${msg}`;
}

function dim(msg) {
  return chalk.gray(msg);
}

function statusBar(parts) {
  const segments = parts.filter(Boolean).map((p) => chalk.gray(p));
  return chalk.gray('─') + ' ' + segments.join(chalk.gray(' · ')) + ' ' + chalk.gray('─'.repeat(4));
}

function assistant(text) {
  return renderMarkdown(text);
}

function user(text) {
  return `${chalk.bold.blue('You')}: ${text}`;
}

function system(text) {
  return chalk.gray.italic(text);
}

module.exports = {
  renderMarkdown,
  ok,
  warn,
  err,
  info,
  dim,
  statusBar,
  assistant,
  user,
  system,
};
