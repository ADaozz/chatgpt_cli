#!/usr/bin/env node
'use strict';

// 可从仓库 skill 或复制到其他项目的 skill 调用，复用实际 CLI 的检测器。
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const candidates = [process.env.CHATGPT_CLI_ROOT, path.resolve(__dirname, '../../../..')].filter(Boolean);
for (const directory of (process.env.PATH || '').split(path.delimiter)) {
  try {
    const binary = fs.realpathSync(path.join(directory, 'chatgpt-cli'));
    candidates.push(path.dirname(binary));
  } catch {}
}
let script = null;
for (const root of candidates) {
  const target = path.join(root, 'scripts/check-selectors.js');
  try {
    if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name === 'chatgpt-cli' && fs.existsSync(target)) {
      script = target;
      break;
    }
  } catch {}
}
if (!script) {
  console.error('找不到 chatgpt-cli 检测器；更新 CLI 或设置 CHATGPT_CLI_ROOT 为其安装目录。');
  process.exitCode = 2;
} else {
  const result = spawnSync(process.execPath, [script, ...process.argv.slice(2)], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 2;
}
