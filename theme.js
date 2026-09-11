/**
 * theme.js — CLI 视觉 token 的唯一真相来源
 *
 * 与 GitHub Pages / Landing Page（stitch_chatgpt_cli_terminal_landing_page）
 * 共享同一套颜色语义：
 *
 *   Landing Page (tailwind term.*)      →  theme.js color.*
 *   ─────────────────────────────────────────────────────
 *   bg      #0b0d0e  (终端背景，不输出)
 *   panel   #101315  (终端背景，不输出)
 *   border  #1f2529  → color.border（分隔线）
 *   dim     #657077  → color.dim
 *   muted   #8e9aa1  → color.muted
 *   text    #e6ebed  → color.text
 *   bright  #f5f7f8  → color.bright
 *   green   #4ade80  → color.success
 *   cyan    #38bdf8  → color.primary
 *   yellow  #eab308  → color.warning
 *
 * 架构约束：
 *   - 只有 renderer.js / cli.js / commands.js 允许 require 本文件
 *   - adapter / client / response-tracker 等业务层禁止依赖本文件
 *   - 终端不支持 TrueColor 时 chalk 自动降级为最接近的 256/16 色，
 *     所有 token 都选择了在降级后仍可读的中高亮度色值。
 */

const chalk = require('chalk');

const color = {
  text: '#e6ebed',
  bright: '#f5f7f8',
  muted: '#8e9aa1',
  dim: '#657077',

  primary: '#38bdf8', // cyan — prompt / thinking / 参数高亮
  success: '#4ade80', // green — ✓ 完成 / 连接成功
  warning: '#eab308', // yellow — ! 警告
  error: '#f87171', // red — × 错误（landing 未定义，取同亮度红）

  border: '#1f2529', // 分隔线
};

const symbol = {
  prompt: '●',
  shell: '$',
  success: '✓',
  warning: '!',
  error: '×',
  separator: '─',
  thinking: '◌',
};

// chalk.hex() 在不支持 TrueColor 的终端会自动降级；
// 若 chalk 完全不支持颜色（NO_COLOR / 非 TTY），返回原样字符串，仍可读。
const paint = (hex) => {
  const fn = chalk.hex(hex);
  return (text) => fn(text);
};

const c = {
  text: paint(color.text),
  bright: paint(color.bright),
  muted: paint(color.muted),
  dim: paint(color.dim),
  primary: paint(color.primary),
  success: paint(color.success),
  warning: paint(color.warning),
  error: paint(color.error),
  border: paint(color.border),
};

const bold = {
  bright: (text) => chalk.bold(c.bright(text)),
  primary: (text) => chalk.bold(c.primary(text)),
  success: (text) => chalk.bold(c.success(text)),
  warning: (text) => chalk.bold(c.warning(text)),
  error: (text) => chalk.bold(c.error(text)),
};

module.exports = { color, symbol, c, bold };
