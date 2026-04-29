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
let readline, ora, chalk, Session, commands, parseInput, getCommandNames, R, adapter, autoConnect;
let session, shouldExit = false;

function loadModules() {
  readline = require('readline');
  ora = require('ora');
  chalk = require('chalk');
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
  };

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--project' && args[i + 1]) { opts.project = args[++i]; }
    else if (a === '--new-project') { opts.newProject = true; }
    else if (a === '--model' && args[i + 1]) { opts.model = args[++i]; }
    else if (a === '--conversation' && args[i + 1]) { opts.conversation = args[++i]; }
    else if (a === '--json') { opts.json = true; }
    else if (a === '--help' || a === '-h') { opts.subcommand = 'help'; }
    else if (!a.startsWith('-') && !opts.subcommand) {
      opts.subcommand = a;
      opts.subargs = args.slice(i + 1).filter((x) => !x.startsWith('--') || x === '--project');
      break;
    }
    i++;
  }

  // 重新扫一遍 subargs 里的 flags
  if (opts.subcommand === 'upload') {
    const raw = args.slice(i + 1);
    opts.subargs = raw;
  } else if (opts.subcommand === 'snapshot') {
    const raw = args.slice(i + 1);
    opts.subargs = raw;
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
    session.setModel(selected || opts.model);
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

async function runNonInteractive(opts) {
  const sub = opts.subcommand;
  const isJson = opts.json;
  const log = isJson ? () => {} : (msg) => process.stderr.write(`${msg}\n`);

  if (sub === 'help') { printNonInteractiveHelp(); return; }

  loadModules();
  await initSession(opts, log);

  try {
    if (sub === 'send') {
      let message = opts.subargs.join(' ').trim();
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
        process.stderr.write('错误: send 需要消息内容\n');
        process.exit(1);
      }

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
      const toProject = opts.subargs.includes('--project');
      const filePath = opts.subargs.filter((a) => a !== '--project')[0];
      if (!filePath) { process.stderr.write('错误: upload 需要文件路径\n'); process.exit(1); }

      if (!session.hasProject) { process.stderr.write('错误: upload 需要指定 --project\n'); process.exit(1); }

      const absPath = path.resolve(filePath);
      if (!fs.existsSync(absPath)) { process.stderr.write(`错误: 文件不存在: ${absPath}\n`); process.exit(1); }

      let result;
      if (toProject) {
        result = await session.project.uploadProjectFile(absPath);
      } else {
        result = await session.project.uploadConversationAttachment(absPath);
      }

      if (isJson) {
        jsonOut(result);
      } else {
        console.log(`${result.fileName} (${result.fileSize} bytes, id: ${result.fileId || 'N/A'})`);
      }
    }

    else if (sub === 'snapshot') {
      const convRef = opts.subargs[0];
      if (!convRef && !session.hasConversation) {
        process.stderr.write('错误: snapshot 需要对话 ID\n'); process.exit(1);
      }

      if (convRef && !session.hasConversation) {
        const convId = convRef.includes('/') ? adapter.extractConversationId(convRef) : convRef;
        if (session.hasProject) {
          session.setConversation(await session.project.openConversation(convId));
        } else {
          const { Conversation } = require('./client');
          const conv = new Conversation(session.client._page, convId, null, null);
          await adapter.navigateToConversation(session.client._page, convId, null);
          session.setConversation(conv);
        }
      }

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
      const convRef = opts.subargs[0];
      if (!convRef && !session.hasConversation) {
        process.stderr.write('错误: status 需要对话 ID\n'); process.exit(1);
      }

      if (convRef && !session.hasConversation) {
        const convId = convRef.includes('/') ? adapter.extractConversationId(convRef) : convRef;
        if (session.hasProject) {
          session.setConversation(await session.project.openConversation(convId));
        } else {
          const { Conversation } = require('./client');
          const conv = new Conversation(session.client._page, convId, null, null);
          await adapter.navigateToConversation(session.client._page, convId, null);
          session.setConversation(conv);
        }
      }

      const status = await session.conversation.getStatus();
      if (isJson) {
        jsonOut(status);
      } else {
        console.log(`状态: ${status.state}`);
        console.log(`消息数: ${status.messageCount} (assistant: ${status.assistantMessageCount})`);
        if (status.isResponding) console.log('对话仍在生成中...');
      }
    }

    else if (sub === 'messages') {
      const convRef = opts.subargs[0];
      if (!convRef && !session.hasConversation) {
        process.stderr.write('错误: messages 需要对话 ID\n'); process.exit(1);
      }

      if (convRef && !session.hasConversation) {
        const convId = convRef.includes('/') ? adapter.extractConversationId(convRef) : convRef;
        if (session.hasProject) {
          session.setConversation(await session.project.openConversation(convId));
        } else {
          const { Conversation } = require('./client');
          const conv = new Conversation(session.client._page, convId, null, null);
          await adapter.navigateToConversation(session.client._page, convId, null);
          session.setConversation(conv);
        }
      }

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
  send <message>                    发送消息，输出回复后退出
  upload <path> [--project]         上传文件（--project 上传到项目 Sources）
  snapshot <conv_id> [-o file]      导出对话快照
  status <conv_id>                  查看对话状态
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
  if (session.modelName) parts.push(chalk.yellow(session.modelName));
  if (session.projectName) parts.push(chalk.magenta(session.projectName));
  if (session.conversationId) parts.push(chalk.gray(session.conversationId.slice(0, 8)));

  const ctx = parts.length ? ` ${chalk.gray('(')}${parts.join(chalk.gray(' · '))}${chalk.gray(')')}` : '';
  return `${chalk.green('●')}${ctx} ${chalk.bold('>')} `;
}

function clearLine() {
  if (process.stdout.isTTY) { process.stdout.clearLine(0); process.stdout.cursorTo(0); }
}
function showThinking(text) {
  if (process.stdout.isTTY) { clearLine(); process.stdout.write(chalk.cyan(`  ◌ ${text}`)); }
}
function hideThinking() {
  if (process.stdout.isTTY) { clearLine(); }
}

async function handleMessage(text) {
  if (session.hasConversation) {
    showThinking('thinking...');
    const reply = await session.conversation.send(text);
    hideThinking();
    print(''); print(R.assistant(reply)); print('');
    return;
  }

  if (session.hasProject) {
    showThinking('thinking...');
    const { conversation, reply } = await session.project.newConversation(text);
    session.setConversation(conversation);
    hideThinking();
    print(R.dim(`对话 ID: ${conversation.id}`));
    print(''); print(R.assistant(reply)); print('');
    return;
  }

  showThinking('thinking...');
  const reply = await adapter.sendMessage(session.client._page, text);
  hideThinking();
  try {
    const convId = await adapter.waitForConversationId(session.client._page, 5_000);
    const { Conversation } = require('./client');
    session.setConversation(new Conversation(session.client._page, convId, null, null));
    print(R.dim(`对话 ID: ${convId}`));
  } catch {}
  print(''); print(R.assistant(reply)); print('');
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
  print(chalk.bold('  ChatGPT CLI') + chalk.gray('  — 通过 Chrome 驱动网页版 ChatGPT'));
  print('');

  const spinner = ora({ spinner: 'dots', color: 'cyan' });
  spinner.start('正在初始化...');
  try {
    const { client, browserURL } = await autoConnect((msg) => { spinner.text = msg; });
    session.setClient(client, browserURL);
    spinner.succeed('已连接 ChatGPT');
  } catch (e) {
    spinner.fail(`初始化失败: ${e.message}`);
    process.exit(1);
  }

  print('');
  print(chalk.gray('  输入消息开始对话，/help 查看命令，Ctrl+C 退出'));
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
      if (!result.ready) { rl.setPrompt(chalk.gray('... ')); rl.prompt(); return; }
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
