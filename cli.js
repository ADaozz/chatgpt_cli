#!/usr/bin/env node
/**
 * cli.js — ChatGPT CLI 主入口
 *
 * 两种模式：
 *   交互模式:  node cli.js                          → REPL
 *   非交互模式: node cli.js send "message"           → 单次执行后退出
 *
 * 非交互子命令：
 *   send <message>                    发送消息，输出回复
 *   upload <path> [--project]         上传文件
 *   snapshot <conv_id> [-o path]      导出对话快照
 *   status <conv_id>                  查看对话状态
 *   messages <conv_id>                列出对话消息
 *
 * 全局选项：
 *   --project <name>       指定项目
 *   --model <name>         指定模型
 *   --conversation <id>    指定已有对话
 *   --json                 JSON 格式输出
 */

const path = require('path');
const fs = require('fs');

// Heavy modules are loaded lazily after arg parsing so --help stays fast
let readline, ora, Session, commands, parseInput, getCommandNames, R, adapter, autoConnect;
let session, shouldExit = false;

function loadModules() {
  readline = require('readline');
  ora = require('ora');
  Session = require('./session');
  ({ commands, parseInput, getCommandNames } = require('./commands'));
  R = require('./renderer');
  adapter = require('./adapter');
  ({ autoConnect } = require('./auto-connect'));
  session = new Session();
}

// ── 参数解析 ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    project: null,
    newProject: false,
    model: null,
    conversation: null,
    json: false,
    subcommand: null,
    subargs: [],
    wait: false,
    timeoutMs: null,
    pollMs: null,
  };

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--project' && args[i + 1] && !args[i + 1].startsWith('-') && !opts.subcommand) {
      // 全局 --project <name>（在 subcommand 之前）
      opts.project = args[++i];
    } else if (a === '--new-project') {
      opts.newProject = true;
    } else if (a === '--model' && args[i + 1]) {
      opts.model = args[++i];
    } else if (a === '--conversation' && args[i + 1]) {
      opts.conversation = args[++i];
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--help' || a === '-h') {
      opts.subcommand = 'help';
    } else if (!a.startsWith('-') && !opts.subcommand) {
      opts.subcommand = a;
      opts.subargs = args.slice(i + 1);
      break;
    }
    i++;
  }

  // 二次扫描 subargs：抽出 --wait / --timeout-ms / --poll-ms（适用于 status / start）。
  // upload 也会用 --timeout-ms 但保留在 subargs，由 upload handler 自取。
  const cleaned = [];
  const subargs = opts.subargs;
  for (let j = 0; j < subargs.length; j++) {
    const a = subargs[j];
    if (a === '--wait') {
      opts.wait = true;
    } else if (a === '--timeout-ms' && subargs[j + 1]) {
      opts.timeoutMs = Number(subargs[++j]);
    } else if (a === '--poll-ms' && subargs[j + 1]) {
      opts.pollMs = Number(subargs[++j]);
    } else {
      cleaned.push(a);
    }
  }
  // upload 仍依赖原始 subargs（含 --project / --timeout-ms），其它子命令使用清洗后的版本
  if (opts.subcommand !== 'upload') {
    opts.subargs = cleaned;
  } else {
    // upload 内部会扫 --timeout-ms / --project / 数字 token
    opts.subargs = subargs;
  }

  return opts;
}

// ── 非交互模式 ────────────────────────────────────────────────────────────────

async function applyModelSelection(session, title) {
  session.setModel(title, session.client._page.__chatgptModelSlug || null);
}

async function autoSelectBestModel(session, log = () => {}) {
  if (process.env.CHATGPT_AUTO_MODEL === '0') return;
  log('自动选择最高级模型...');
  const selected = session.hasProject
    ? await session.project.selectModel('best')
    : await adapter.selectBestModel(session.client._page);
  await applyModelSelection(session, selected);
  const slug = session.modelSlug || session.client._page.__chatgptModelSlug;
  if (slug && slug !== selected) {
    log(`使用模型: ${selected} (${slug})`);
  } else {
    log(`使用模型: ${selected}`);
  }
}

async function initSession(opts, log) {
  const { client, browserURL } = await autoConnect(log);
  session.setClient(client, browserURL);

  if (opts.project) {
    if (opts.newProject) {
      log(`创建新项目: ${opts.project}`);
      const project = await session.client.createProject(opts.project);
      session.setProject(project, opts.project);
    } else {
      log(`切换项目: ${opts.project}`);
      const project = await session.client.selectOrCreateProject(opts.project, { create: false });
      session.setProject(project, opts.project);
    }
  }

  if (opts.model) {
    log(`切换模型: ${opts.model}`);
    let selected;
    if (session.hasProject) {
      selected = await session.project.selectModel(opts.model);
    } else {
      selected = await adapter.selectModel(session.client._page, opts.model);
    }
    await applyModelSelection(session, selected || opts.model);
  } else {
    await autoSelectBestModel(session, log);
  }

  if (opts.conversation) {
    const convId = opts.conversation.includes('/')
      ? adapter.extractConversationId(opts.conversation)
      : opts.conversation;
    if (session.hasProject) {
      const conv = await session.project.openConversation(convId);
      session.setConversation(conv);
    } else {
      const { Conversation } = require('./client');
      const conv = new Conversation(session.client._page, convId, null, null);
      await adapter.navigateToConversation(session.client._page, convId, null);
      session.setConversation(conv);
    }
  }
}

function jsonOut(data) {
  console.log(JSON.stringify(data, null, 2));
}

async function readMessageFromArgsOrStdin(opts, commandName) {
  let message = opts.subargs
    .filter((a) => !a.startsWith('--'))
    .join(' ')
    .trim();
  if (!message && !process.stdin.isTTY) {
    message = await new Promise((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { buf += chunk; });
      process.stdin.on('end', () => resolve(buf.trim()));
      process.stdin.on('error', reject);
    });
  }
  if (!message) {
    process.stderr.write(`错误: ${commandName} 需要消息内容\n`);
    process.exit(1);
  }
  return message;
}

async function ensureConversationOpened(convRef) {
  if (!convRef && session.hasConversation) return;
  if (!convRef) {
    process.stderr.write('错误: 需要对话 ID\n');
    process.exit(1);
  }
  const convId = String(convRef).includes('/')
    ? adapter.extractConversationId(convRef)
    : convRef;
  if (session.hasProject) {
    session.setConversation(await session.project.openConversation(convId));
  } else {
    const { Conversation } = require('./client');
    const conv = new Conversation(session.client._page, convId, null, null);
    await adapter.navigateToConversation(session.client._page, convId, null);
    session.setConversation(conv);
  }
}

async function runNonInteractive(opts) {
  const sub = opts.subcommand;
  const isJson = opts.json;
  const log = isJson ? () => {} : (msg) => process.stderr.write(`${msg}\n`);

  if (sub === 'help') { printNonInteractiveHelp(); return; }

  loadModules();
  await initSession(opts, log);

  try {
    if (sub === 'start') {
      const message = await readMessageFromArgsOrStdin(opts, 'start');

      let result;
      if (session.hasConversation) {
        result = await adapter.startMessage(session.client._page, message);
      } else if (session.hasProject) {
        await adapter.navigateToProjectHome(
          session.client._page,
          session.project._projectPath,
          { forceReload: true }
        );
        result = await adapter.startMessage(session.client._page, message);
      } else {
        result = await adapter.startMessage(session.client._page, message);
      }

      const conversationId = result.conversationId;
      if (conversationId && !session.hasConversation) {
        const { Conversation } = require('./client');
        const conv = new Conversation(
          session.client._page,
          conversationId,
          session.project?._projectId || null,
          session.project?._projectPath || null
        );
        session.setConversation(conv);
      }

      if (isJson) {
        jsonOut({
          conversationId,
          state: result.state || 'started',
          url: result.url,
          project: session.projectName || null,
          model: session.modelName || null,
          checkedAt: result.checkedAt,
        });
      } else {
        console.log(conversationId || '');
      }
    }

    else if (sub === 'send') {
      const message = await readMessageFromArgsOrStdin(opts, 'send');

      let reply, conversationId;

      if (session.hasConversation) {
        reply = await session.conversation.send(message);
        conversationId = session.conversationId;
      } else if (session.hasProject) {
        const result = await session.project.newConversation(message);
        reply = result.reply;
        session.setConversation(result.conversation);
        conversationId = result.conversation.id;
      } else {
        reply = await adapter.sendMessage(session.client._page, message);
        try {
          conversationId = await adapter.waitForConversationId(session.client._page, 5_000);
        } catch { conversationId = null; }
      }

      if (isJson) {
        jsonOut({
          reply,
          conversationId,
          project: session.projectName || null,
          model: session.modelName || null,
        });
      } else {
        console.log(reply);
      }
    }

    else if (sub === 'upload') {
      // turn_4 P0.1：明确解析 upload 参数，不要靠 filter / 正则吞数字
      let toProject = false;
      let filePath = null;
      let timeoutMs = null;
      for (let k = 0; k < opts.subargs.length; k++) {
        const arg = opts.subargs[k];
        if (arg === '--project') {
          toProject = true;
        } else if (arg === '--timeout-ms') {
          const next = opts.subargs[++k];
          const value = Number(next);
          if (!Number.isFinite(value) || value <= 0) {
            process.stderr.write('错误: --timeout-ms 需要正整数毫秒值\n');
            process.exit(1);
          }
          timeoutMs = value;
        } else if (!arg.startsWith('--') && !filePath) {
          filePath = arg;
        } else {
          process.stderr.write(`错误: upload 收到多余参数: ${arg}\n`);
          process.exit(1);
        }
      }
      if (!filePath) { process.stderr.write('错误: upload 需要文件路径\n'); process.exit(1); }
      if (!session.hasProject) { process.stderr.write('错误: upload 需要指定 --project\n'); process.exit(1); }

      const absPath = path.resolve(filePath);
      if (!fs.existsSync(absPath)) { process.stderr.write(`错误: 文件不存在: ${absPath}\n`); process.exit(1); }

      // 透传 --timeout-ms 到 adapter（adapter 现在每次调用 getUploadTimeoutMs() 动态读 env）
      const prevEnv = process.env.CHATGPT_UPLOAD_TIMEOUT_MS;
      if (timeoutMs !== null) {
        process.env.CHATGPT_UPLOAD_TIMEOUT_MS = String(timeoutMs);
      }
      let result;
      try {
        if (toProject) {
          result = await session.project.uploadProjectFile(absPath);
        } else {
          result = await session.project.uploadConversationAttachment(absPath);
        }
      } finally {
        if (prevEnv === undefined) {
          delete process.env.CHATGPT_UPLOAD_TIMEOUT_MS;
        } else {
          process.env.CHATGPT_UPLOAD_TIMEOUT_MS = prevEnv;
        }
      }

      if (isJson) {
        jsonOut(result);
      } else {
        console.log(`${result.fileName} (${result.fileSize} bytes, id: ${result.fileId || 'N/A'})`);
      }
    }

    else if (sub === 'snapshot') {
      const convRef = opts.subargs.find((a) => !a.startsWith('-'));
      await ensureConversationOpened(convRef);

      const snapshot = await session.conversation.getSnapshot();
      const outIdx = opts.subargs.indexOf('-o');
      const outPath = outIdx >= 0 ? opts.subargs[outIdx + 1] : null;

      if (outPath) {
        fs.writeFileSync(path.resolve(outPath), JSON.stringify(snapshot, null, 2), 'utf8');
        if (!isJson) console.log(`已保存: ${outPath}`);
      }

      if (isJson || !outPath) {
        jsonOut(snapshot);
      }
    }

    else if (sub === 'status') {
      const convRef = opts.subargs.find((a) => !a.startsWith('-'));
      await ensureConversationOpened(convRef);

      // turn_4 P0.2：CLI 不再自己 loop；统一走 adapter waitForConversationCompletion，
      // 避免两套完成判定逻辑分叉（snapshot streak / fallback 不一致）。
      const status = opts.wait
        ? await session.conversation.waitUntilComplete({
            timeout: opts.timeoutMs || undefined,
            pollInterval: opts.pollMs || undefined,
            stablePolls: 4,
          })
        : await session.conversation.getStatus();

      if (isJson) {
        jsonOut(status);
      } else {
        console.log(`状态: ${status.state}`);
        console.log(`消息数: ${status.messageCount} (assistant: ${status.assistantMessageCount})`);
        if (status.isResponding) console.log('对话仍在生成中...');
        if (status.backendUnavailable) {
          console.log('警告: backend snapshot 持续不可用 (streak=' + status.snapshotErrorStreak + ')');
        }
      }
    }

    else if (sub === 'messages') {
      const convRef = opts.subargs.find((a) => !a.startsWith('-'));
      await ensureConversationOpened(convRef);

      const msgs = await session.conversation.getMessages();
      if (isJson) {
        jsonOut(msgs);
      } else {
        for (const m of msgs) {
          const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'You' : m.role;
          const preview = (m.text || '').slice(0, 200).replace(/\n/g, ' ');
          console.log(`[${role}] ${preview}`);
        }
      }
    }

    else {
      process.stderr.write(`未知子命令: ${sub}\n`);
      printNonInteractiveHelp();
      process.exit(1);
    }
  } finally {
    await session.client.disconnect().catch(() => {});
  }
}

function printNonInteractiveHelp() {
  console.log(`
ChatGPT CLI — 通过 Chrome 驱动网页版 ChatGPT

用法:
  chatgpt-cli                                    交互模式 (REPL)
  chatgpt-cli [options] <command> [args]          非交互模式

子命令:
  start <message>                   发送消息，立即返回 conversationId（不等待回复）
  send <message>                    发送消息，输出回复后退出
  upload <path> [--project] [--timeout-ms N]
                                    上传文件（--project 上传到项目 Sources）
  snapshot <conv_id> [-o file]      导出对话快照（含完整 messages，backend API）
  status <conv_id> [--wait] [--timeout-ms N] [--poll-ms N]
                                    查看对话状态；--wait 时阻塞至 completed
  messages <conv_id>                列出对话消息

选项:
  --project <name>       指定项目（侧边栏模糊匹配）
  --new-project          与 --project 搭配，强制创建新项目
  --model <name>         指定模型
  --conversation <id>    在已有对话中继续
  --json                 JSON 格式输出
  -h, --help             显示帮助

示例:
  chatgpt-cli send "1+1等于几？"
  chatgpt-cli --project GhostVM --model GPT-5 send "分析架构"
  chatgpt-cli --project "My New Proj" --new-project send "hello"
  chatgpt-cli --json --conversation 69f1... send "继续"
  chatgpt-cli --project GhostVM upload ./data.csv --project
  chatgpt-cli --json snapshot 69f1... -o out.json
`.trim());
}

// ── 交互模式 ──────────────────────────────────────────────────────────────────

function print(msg) {
  if (msg != null) console.log(msg);
}

function getPrompt() {
  const parts = [];
  if (session.modelName) parts.push(R.code(session.modelName));
  if (session.projectName) parts.push(R.muted(session.projectName));
  if (session.conversationId) parts.push(R.dim(session.conversationId.slice(0, 8)));

  const ctx = parts.length ? ` ${R.dim('(')}${parts.join(R.dim(' · '))}${R.dim(')')}` : '';
  return `${R.promptMarker()}${ctx} `;
}

function clearLine() {
  if (process.stdout.isTTY) { process.stdout.clearLine(0); process.stdout.cursorTo(0); }
}

// ── thinking / generation 状态行 ─────────────────────────────────────────────
//
// 状态直接来自 ResponseTracker 的 onState 事件（adapter → tracker → cli），
// CLI 不再自己实现等待逻辑：
//   responding → "ChatGPT  <model>  thinking 1.2s"
//   generating → "ChatGPT  <model>  generating 3.4s"
//   complete   → "✓ Finished generation · 1.48s"

let statusLineActive = false;
let statusTimer = null;
let statusStartedAt = 0;
let statusPhase = 'thinking';

function fmtElapsed(ms) {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

function paintStatusLine() {
  if (!process.stdout.isTTY || !statusLineActive) return;
  const elapsed = fmtElapsed(Date.now() - statusStartedAt);
  const label = statusPhase === 'generating' ? `generating ${elapsed}` : `thinking ${elapsed}`;
  clearLine();
  process.stdout.write(R.assistantHeader(session.modelName, label));
}

function showStatus(phase) {
  if (!process.stdout.isTTY) return;
  if (!statusLineActive) {
    statusLineActive = true;
    statusStartedAt = Date.now();
    statusTimer = setInterval(paintStatusLine, 200);
    if (statusTimer.unref) statusTimer.unref();
  }
  statusPhase = phase || statusPhase;
  paintStatusLine();
}

function hideStatus() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  if (statusLineActive) { clearLine(); statusLineActive = false; }
  statusPhase = 'thinking';
}

/** 构造传给 adapter/client 的 onState 回调（ResponseTracker 事件 → 状态行） */
function trackerStateHandler() {
  return (event) => {
    if (!event || !process.stdout.isTTY) return;
    if (event.type === 'responding') showStatus('thinking');
    else if (event.type === 'generating') showStatus('generating');
  };
}

function finishStatusLine(elapsedMs) {
  if (!process.stdout.isTTY) return;
  hideStatus();
  print(R.generationDone(elapsedMs != null ? fmtElapsed(elapsedMs) : null));
}

// 兼容旧调用（commands.js 等）
function showThinking(text) {
  if (process.stdout.isTTY) { clearLine(); process.stdout.write(R.thinking(text)); }
}
function hideThinking() {
  hideStatus();
  if (process.stdout.isTTY) { clearLine(); }
}

async function handleMessage(text) {
  const startedAt = Date.now();
  const onState = trackerStateHandler();

  if (session.hasConversation) {
    showStatus('thinking');
    const reply = await session.conversation.send(text, { onState });
    finishStatusLine(Date.now() - startedAt);
    print(R.separator()); print(''); print(R.assistant(reply)); print('');
    return;
  }

  if (session.hasProject) {
    showStatus('thinking');
    const { conversation, reply } = await session.project.newConversation(text, { onState });
    session.setConversation(conversation);
    finishStatusLine(Date.now() - startedAt);
    print(R.dim(`conversation ${conversation.id}`));
    print(R.separator()); print(''); print(R.assistant(reply)); print('');
    return;
  }

  showStatus('thinking');
  const reply = await adapter.sendMessage(session.client._page, text, { onState });
  finishStatusLine(Date.now() - startedAt);
  try {
    const convId = await adapter.waitForConversationId(session.client._page, 5_000);
    const { Conversation } = require('./client');
    session.setConversation(new Conversation(session.client._page, convId, null, null));
    print(R.dim(`conversation ${convId}`));
  } catch {}
  print(R.separator()); print(''); print(R.assistant(reply)); print('');
}

let multilineBuffer = null;
function processLine(line) {
  if (multilineBuffer !== null) {
    if (line.trim() === '}}') { const t = multilineBuffer; multilineBuffer = null; return { ready: true, text: t }; }
    multilineBuffer += '\n' + line;
    return { ready: false };
  }
  const trimmed = line.trim();
  if (trimmed === '{{') { multilineBuffer = ''; return { ready: false }; }
  if (trimmed.endsWith('\\')) { multilineBuffer = trimmed.slice(0, -1); return { ready: false }; }
  return { ready: true, text: trimmed };
}

async function doExit() {
  shouldExit = true;
  if (session.connected) await session.client.disconnect().catch(() => {});
  print(R.dim('Bye.'));
  process.exit(0);
}

async function runInteractive() {
  loadModules();
  print('');
  print(
    R.banner('ChatGPT CLI', 'Drive ChatGPT directly from your terminal.')
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
  );
  print('');

  // ora 默认符号（✔ / ⚠ / ✖）与 theme.symbol 语义一致，保持轻量不另造 spinner
  const spinner = ora({ spinner: 'dots', color: 'cyan' });
  spinner.start('  Connecting over CDP...');
  try {
    const { client, browserURL } = await autoConnect((msg) => { spinner.text = `  ${msg}`; });
    session.setClient(client, browserURL);
    spinner.succeed(`Chrome DevTools Protocol connected  ${browserURL || ''}`.trimEnd());
    if (process.env.CHATGPT_AUTO_MODEL !== '0') {
      spinner.start('  Resolving best model...');
      try {
        await autoSelectBestModel(session);
        spinner.succeed(`Active Model    ${session.modelName}`);
      } catch (e) {
        spinner.warn(`Model auto-select failed: ${e.message}`);
      }
    }
  } catch (e) {
    spinner.fail(`Connection failed`);
    print(R.detailLine(e.message));
    process.exit(1);
  }

  print('');
  print(R.dim('  输入消息开始对话，/help 查看命令，Ctrl+C 退出'));
  print('');

  let lastSigint = 0;
  process.on('SIGINT', () => {
    const now = Date.now();
    if (now - lastSigint < 2000) { doExit(); return; }
    lastSigint = now;
    hideThinking();
    print('');
    print(R.dim('再按一次 Ctrl+C 退出'));
    if (rl) { rl.setPrompt(getPrompt()); rl.prompt(); }
  });

  let rl = null;
  let busy = false;

  function completer(line) {
    if (line.startsWith('/')) {
      const all = getCommandNames();
      const hits = all.filter((c) => c.startsWith(line));
      return [hits.length === 1 ? [hits[0] + ' '] : (hits.length ? hits : all), line];
    }
    return [[], line];
  }

  function createRL() {
    if (rl) { rl.removeAllListeners(); rl.close(); }
    rl = readline.createInterface({
      input: process.stdin, output: process.stdout,
      prompt: getPrompt(), terminal: process.stdin.isTTY !== false,
      historySize: 500, completer,
    });

    rl.on('line', async (line) => {
      const result = processLine(line);
      if (!result.ready) { rl.setPrompt(R.dim('... ')); rl.prompt(); return; }
      const text = result.text;
      if (!text) { rl.setPrompt(getPrompt()); rl.prompt(); return; }

      const parsed = parseInput(text);
      busy = true;
      try {
        if (parsed.type === 'command') { await parsed.cmd.run(session, parsed.args, print); }
        else { await handleMessage(parsed.text); }
      } catch (e) { hideThinking(); print(R.err(e.message)); }

      busy = false;
      if (shouldExit) { await doExit(); return; }
      rl.setPrompt(getPrompt()); rl.prompt();
    });

    rl.on('close', () => {
      if (shouldExit) return;
      if (process.stdin.isTTY && !process.stdin.destroyed) {
        setImmediate(() => { if (!shouldExit) { createRL(); rl.prompt(); } });
        return;
      }
      if (busy) shouldExit = true; else doExit();
    });

    rl.on('SIGINT', () => { process.emit('SIGINT'); });
  }

  createRL();
  rl.prompt();
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv);

if (opts.subcommand) {
  runNonInteractive(opts).catch((e) => {
    process.stderr.write(`错误: ${e.message}\n`);
    process.exit(1);
  });
} else {
  runInteractive().catch((e) => {
    const msg = R ? R.err(e.message) : e.message;
    console.error(msg);
    process.exit(1);
  });
}
