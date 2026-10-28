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
let readline, ora, Session, commands, parseInput, getCommandNames, R, autoConnect;
let session, shouldExit = false;

function loadModules() {
  readline = require('readline');
  ora = require('ora');
  Session = require('./session');
  ({ commands, parseInput, getCommandNames } = require('./commands'));
  R = require('./renderer');
  ({ autoConnect } = require('./auto-connect'));
  ({ extractConversationId } = require('./url-utils'));
  session = new Session();
}

// ── 参数解析 ──────────────────────────────────────────────────────────────────

let extractConversationId = null;

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    project: null,
    newProject: false,
    model: null,
    effort: null,
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
    } else if (a === '--effort' && args[i + 1]) {
      opts.effort = args[++i];
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
      const project = await session.client.selectProject(opts.project);
      session.setProject(project, opts.project);
    }
  }

  // 模型策略（v2）：仅 send/start（及交互模式）需要；status/messages/snapshot/upload
  // 不应因模型菜单未渲染或账号限制而阻塞只读操作。
  const needsModel = !opts.subcommand || opts.subcommand === 'send' || opts.subcommand === 'start';
  if (!needsModel) {
    // 不改变页面当前模型配置
  } else if (opts.model || opts.effort) {
    log(`应用模型配置: ${opts.model || '(默认最新)'}${opts.effort ? ` · 强度 ${opts.effort}` : ''} ...`);
    const selection = await session.client.applyModelConfig({
      model: opts.model || null,
      effort: opts.effort || null,
    });
    session.setModel(selection.modelLabel, selection.effort);
    log(`模型配置: ${selection.modelLabel}${selection.effort ? `（思考强度: ${selection.effort}）` : ''}`);
  } else {
    log('应用默认模型策略（最新模型 + 最高思考强度）...');
    const selection = await session.client.applyModelConfig({});
    session.setModel(selection.modelLabel, selection.effort);
    log(`模型配置: ${selection.modelLabel}${selection.effort ? `（思考强度: ${selection.effort}）` : ''}`);
  }

  if (opts.conversation) {
    const convId = String(opts.conversation).includes('/')
      ? extractConversationId(opts.conversation)
      : opts.conversation;
    if (session.hasProject) {
      const conv = await session.project.openConversation(convId);
      session.setConversation(conv);
    } else {
      const { Conversation } = require('./client');
      const conv = new Conversation(session.client, convId, null, null);
      await conv.open();
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
    ? extractConversationId(convRef)
    : convRef;
  if (session.hasProject) {
    session.setConversation(await session.project.openConversation(convId));
  } else {
    const { Conversation } = require('./client');
    const conv = new Conversation(session.client, convId, null, null);
    await conv.open();
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

      const result = await session.client.startMessage({
        text: message,
        conversationId: session.hasConversation ? session.conversationId : null,
        projectPath: session.hasProject ? session.project._projectPath : null,
      });
      const conversationId = result.conversationId;
      if (conversationId && !session.hasConversation) {
        const { Conversation } = require('./client');
        const conv = new Conversation(
          session.client,
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
          model: session.modelName ? { name: session.modelName, effort: session.modelEffort } : null,
          checkedAt: new Date().toISOString(),
        });
      } else {
        console.log(conversationId || '');
      }
    }

    else if (sub === 'send') {
      const message = await readMessageFromArgsOrStdin(opts, 'send');

      let result;
      if (session.hasConversation) {
        result = await session.conversation.send(message);
      } else if (session.hasProject) {
        result = await session.project.newConversation(message);
        if (result.conversationId) {
          const { Conversation } = require('./client');
          const conv = new Conversation(
            session.client,
            result.conversationId,
            session.project._projectId,
            session.project._projectPath
          );
          session.setConversation(conv);
        }
      } else {
        result = await session.client.newConversation(message);
      }

      if (isJson) {
        jsonOut({
          conversationId: result.conversationId || session.conversationId || null,
          state: result.state,
          completionSource: result.completionSource || null,
          model: result.model || (session.modelName ? { name: session.modelName, effort: session.modelEffort } : null),
          reply: result.reply || { text: '', blocks: [], hasUnsupportedContent: false },
          partial: Boolean(result.partial),
          error: result.error || null,
        });
      } else {
        if (result.state !== 'completed' && result.error) {
          process.stderr.write(`警告: 状态 ${result.state}${result.error ? ` — ${result.error}` : ''}\n`);
        }
        console.log(result.reply ? result.reply.text : '');
      }
      // 非成功终态不返回 0（不误报成功；JSON 仍输出完整结果）
      if (result.state !== 'completed') {
        process.exitCode = 1;
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

      // 与 send 共用 ResponseTracker 状态机（协议确认终态）。
      const status = opts.wait
        ? await session.conversation.waitUntilComplete({
            timeout: opts.timeoutMs || undefined,
            pollInterval: opts.pollMs || undefined,
          })
        : await session.conversation.getStatus();

      if (isJson) {
        jsonOut(status);
      } else {
        console.log(`状态: ${status.state}`);
        console.log(`消息数: ${status.messageCount} (assistant: ${status.assistantMessageCount})`);
        if (status.isResponding) console.log('对话仍在生成中...');
        if (status.error) console.log(`错误: ${status.error}`);
        if (status.snapshotError) {
          console.log('警告: 会话协议读取失败: ' + status.snapshotError);
        }
      }
      if (opts.wait && status.state !== 'completed') {
        process.exitCode = 1;
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
ChatGPT CLI — 通过 Chrome 驱动网页版 ChatGPT（CDP + Puppeteer，v2 协议）

用法:
  chatgpt-cli                                    交互模式 (REPL)
  chatgpt-cli [options] <command> [args]          非交互模式

子命令:
  start <message>                   发送消息，立即返回 conversationId（不等待回复）
  send <message>                    发送消息，协议确认完成后输出回复
  upload <path> [--project] [--timeout-ms N]
                                    上传文件（--project 上传到项目 Sources）
  snapshot <conv_id> [-o file]      导出对话快照（分页读全，未读全标记 partial）
  status <conv_id> [--wait] [--timeout-ms N] [--poll-ms N]
                                    查看对话状态；--wait 阻塞直到协议确认终态
  messages <conv_id>                列出对话消息

选项:
  --project <name>       指定项目（侧边栏模糊匹配）
  --new-project          与 --project 搭配，强制创建新项目
  --model <name>         指定模型（按当前账号菜单匹配；不存在直接报错）
  --effort <level>       思考强度: none|instant|medium|high|max（或档位序号）
                         不指定 --model/--effort 时默认 = 最新模型 + 最高强度
  --conversation <id>    在已有对话中继续
  --json                 JSON 格式输出
  -h, --help             显示帮助

完成语义:
  send/status --wait 仅在协议确认终态时返回 completed；
  timeout/unknown/cancelled 会保留部分文本并返回非零退出码（不误报成功）。

示例:
  chatgpt-cli send "1+1等于几？"
  chatgpt-cli --model GPT-6 --effort high send "分析这段代码"
  chatgpt-cli --json start "分析这个项目"
  chatgpt-cli --json status 69f1... --wait
  chatgpt-cli --project GhostVM upload ./data.csv --project
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
    if (event.type === 'thinking' || event.type === 'waiting') showStatus('thinking');
    else if (event.type === 'generating') showStatus('generating');
    else if (event.type === 'rate-limited') showStatus('thinking');
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
    const result = await session.conversation.send(text, { onState });
    finishStatusLine(Date.now() - startedAt);
    print(R.separator()); print('');
    if (result.state !== 'completed' && result.error) {
      print(R.warn(`状态: ${result.state}${result.error ? ` — ${result.error}` : ''}`));
    }
    print(R.assistant(result.reply ? result.reply.text : '(无回复文本)'));
    print('');
    return;
  }

  if (session.hasProject) {
    showStatus('thinking');
    const result = await session.project.newConversation(text, { onState });
    if (result.conversationId) {
      const { Conversation } = require('./client');
      session.setConversation(
        new Conversation(session.client, result.conversationId, session.project._projectId, session.project._projectPath)
      );
      print(R.dim(`conversation ${result.conversationId}`));
    }
    finishStatusLine(Date.now() - startedAt);
    print(R.separator()); print('');
    if (result.state !== 'completed' && result.error) {
      print(R.warn(`状态: ${result.state}${result.error ? ` — ${result.error}` : ''}`));
    }
    print(R.assistant(result.reply ? result.reply.text : '(无回复文本)'));
    print('');
    return;
  }

  showStatus('thinking');
  const result = await session.client.newConversation(text, { onState });
  finishStatusLine(Date.now() - startedAt);
  if (result.conversationId) {
    const { Conversation } = require('./client');
    session.setConversation(new Conversation(session.client, result.conversationId, null, null));
    print(R.dim(`conversation ${result.conversationId}`));
  }
  print(R.separator()); print('');
  if (result.state !== 'completed' && result.error) {
    print(R.warn(`状态: ${result.state}${result.error ? ` — ${result.error}` : ''}`));
  }
  print(R.assistant(result.reply ? result.reply.text : '(无回复文本)'));
  print('');
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
    // v2 默认策略：当前账号最新模型 + 最高思考强度（显式 --model/--effort 时在 initSession 覆盖）
    spinner.start('  Applying model policy (latest + highest effort)...');
    try {
      const selection = await session.client.applyModelConfig({});
      session.setModel(selection.modelLabel, selection.effort);
      spinner.succeed(
        `Active Model    ${selection.modelLabel}${selection.effort ? ` · ${selection.effort}` : ''}`
      );
    } catch (e) {
      spinner.warn(`Model policy failed: ${e.message}`);
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
