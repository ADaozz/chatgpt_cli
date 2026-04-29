/**
 * commands.js — 斜杠命令
 *
 * 精简命令集：连接/断开已自动化，用户只关注对话操作。
 */

const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const adapter = require('./adapter');
const R = require('./renderer');

function requireProject(session) {
  if (!session.hasProject) throw new Error('未选择项目。请先执行 /project <name>');
}

const commands = {
  project: {
    description: '切换或查看当前项目',
    usage: '/project <name>',
    detail: '不带参数查看当前项目，带名称切换到该项目。名称为 ChatGPT 侧边栏中的项目名（模糊匹配）。',
    example: '/project GhostVM',
    async run(session, args, print) {
      const name = args.join(' ').trim();
      if (!name) {
        print(session.projectName ? R.info(`当前项目: ${session.projectName}`) : R.warn('未选择项目'));
        return;
      }
      print(R.info(`正在切换到项目: ${name} ...`));
      const project = await session.client.selectProject(name);
      session.setProject(project, name);
      print(R.ok(`已进入项目: ${name}`));
    },
  },

  newproject: {
    description: '创建新项目',
    usage: '/newproject <name>',
    detail: '创建一个新的 ChatGPT 项目并切换进去。',
    example: '/newproject graduation-project',
    async run(session, args, print) {
      const name = args.join(' ').trim();
      if (!name) {
        print(R.warn('用法: /newproject <项目名>'));
        return;
      }
      print(R.info(`正在创建项目: ${name} ...`));
      const project = await session.client.createProject(name);
      session.setProject(project, name);
      print(R.ok(`已创建并进入项目: ${name}`));
    },
  },

  model: {
    description: '切换或查看当前模型',
    usage: '/model <name>',
    detail: '不带参数查看当前模型，带名称切换。支持模糊匹配：GPT-4o, GPT-5, o3 等。',
    example: '/model GPT-4o',
    async run(session, args, print) {
      const name = args.join(' ').trim();
      if (!name) {
        print(session.modelName ? R.info(`当前模型: ${session.modelName}`) : R.warn('未选择模型'));
        return;
      }
      print(R.info(`正在切换模型: ${name} ...`));
      let selected;
      if (session.hasProject) {
        selected = await session.project.selectModel(name);
      } else if (session.hasConversation) {
        selected = await session.conversation.selectModel(name);
      } else {
        selected = await adapter.selectModel(session.client._page, name);
      }
      session.setModel(selected || name);
      print(R.ok(`模型: ${selected || name}`));
    },
  },

  new: {
    description: '开启新对话',
    usage: '/new [message]',
    detail: '不带消息则重置到新对话状态。带消息则立即发送并等待回复。',
    example: '/new 帮我写一个快排算法',
    async run(session, args, print) {
      const msg = args.join(' ').trim();
      if (!msg) {
        session.clearConversation();
        print(R.ok('已重置到新对话状态'));
        return;
      }
      if (session.hasProject) {
        const { conversation, reply } = await session.project.newConversation(msg);
        session.setConversation(conversation);
        print(R.dim(`对话 ID: ${conversation.id}`));
        print('');
        print(R.assistant(reply));
      } else {
        const reply = await adapter.sendMessage(session.client._page, msg);
        try {
          const convId = await adapter.waitForConversationId(session.client._page, 5_000);
          const { Conversation } = require('./client');
          session.setConversation(new Conversation(session.client._page, convId, null, null));
          print(R.dim(`对话 ID: ${convId}`));
        } catch {}
        print('');
        print(R.assistant(reply));
      }
    },
  },

  open: {
    description: '打开已有对话',
    usage: '/open <id | url>',
    detail: '支持对话 ID 或完整的 ChatGPT 对话 URL。',
    example: '/open 69f173d4-aac0-83ea-a238-0a27e352150c',
    async run(session, args, print) {
      const ref = args[0];
      if (!ref) throw new Error('请提供对话 ID 或 URL');

      const conversationId = ref.includes('/') ? adapter.extractConversationId(ref) : ref;

      if (session.hasProject) {
        const conversation = await session.project.openConversation(conversationId);
        session.setConversation(conversation);
      } else {
        const { Conversation } = require('./client');
        const conversation = new Conversation(session.client._page, conversationId, null, null);
        await adapter.navigateToConversation(session.client._page, conversationId, null);
        session.setConversation(conversation);
      }
      print(R.ok(`已打开对话: ${conversationId}`));
    },
  },

  upload: {
    description: '上传文件',
    usage: '/upload <file_path> [--project]',
    detail: '默认上传为对话附件。加 --project 则上传到项目 Sources 文件区。支持相对/绝对路径。',
    example: '/upload ./data.csv --project',
    async run(session, args, print) {
      const toProject = args.includes('--project');
      const filePath = args.filter((a) => a !== '--project')[0];
      if (!filePath) throw new Error('请提供文件路径');

      const absPath = path.resolve(filePath);
      if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${absPath}`);

      if (toProject) {
        requireProject(session);
        print(R.info(`上传到项目 Sources: ${path.basename(absPath)} ...`));
        const result = await session.project.uploadProjectFile(absPath);
        print(R.ok(`${result.fileName} (${result.fileSize} bytes)`));
      } else {
        requireProject(session);
        print(R.info(`上传为对话附件: ${path.basename(absPath)} ...`));
        const result = await session.project.uploadConversationAttachment(absPath);
        print(R.ok(`${result.fileName} (${result.fileSize} bytes, id: ${result.fileId})`));
      }
    },
  },

  delete: {
    description: '删除项目文件',
    usage: '/delete <filename | file_id>',
    detail: '从项目 Sources 中删除文件。支持文件名或 file_id。',
    example: '/delete data.csv',
    async run(session, args, print) {
      requireProject(session);
      const ref = args.join(' ').trim();
      if (!ref) throw new Error('请提供文件名或 file_id');
      print(R.info(`正在删除: ${ref} ...`));
      const removed = await session.project.deleteProjectFile(ref);
      for (const file of removed) {
        print(R.ok(`已删除: ${file.fileName}`));
      }
    },
  },

  snapshot: {
    description: '导出当前对话快照',
    usage: '/snapshot [output_path]',
    detail: '将对话消息和文件信息导出为 JSON。不指定路径则自动命名。',
    example: '/snapshot ./conversation.json',
    async run(session, args, print) {
      if (!session.hasConversation) throw new Error('没有活跃对话');
      print(R.info('正在获取快照...'));
      const snapshot = await session.conversation.getSnapshot();
      const outputPath = args[0] || `snapshot-${session.conversationId || 'unknown'}.json`;
      fs.writeFileSync(path.resolve(outputPath), JSON.stringify(snapshot, null, 2), 'utf8');
      print(R.ok(`已保存: ${outputPath} (${snapshot.messages.length} messages, ${snapshot.files.length} files)`));
    },
  },

  status: {
    description: '查看对话状态',
    usage: '/status',
    detail: '显示当前对话的生成状态、消息数、最后消息角色等。',
    async run(session, _args, print) {
      if (!session.hasConversation) throw new Error('没有活跃对话');
      const status = await session.conversation.getStatus();
      print(R.info(`状态: ${status.state}`));
      print(R.dim(`  消息数: ${status.messageCount} (assistant: ${status.assistantMessageCount})`));
      print(R.dim(`  最后角色: ${status.lastMessageRole || 'N/A'}`));
      if (status.isResponding) print(R.warn('对话仍在生成中...'));
    },
  },

  messages: {
    description: '显示对话消息列表',
    usage: '/messages',
    detail: '列出当前对话中所有消息的角色和内容预览。',
    async run(session, _args, print) {
      if (!session.hasConversation) throw new Error('没有活跃对话');
      const messages = await session.conversation.getMessages();
      for (const msg of messages) {
        const role = msg.role === 'assistant' ? 'Assistant' : msg.role === 'user' ? 'You' : msg.role;
        const preview = (msg.text || '').slice(0, 120).replace(/\n/g, ' ');
        const files = msg.files?.length ? ` [${msg.files.length} files]` : '';
        print(R.dim(`  [${role}] ${preview}${files}`));
      }
      print(R.dim(`  共 ${messages.length} 条消息`));
    },
  },

  files: {
    description: '列出对话涉及的文件',
    usage: '/files',
    detail: '显示当前对话中出现的所有文件及其元信息。',
    async run(session, _args, print) {
      if (!session.hasConversation) throw new Error('没有活跃对话');
      const files = await session.conversation.getFiles();
      if (!files.length) {
        print(R.dim('  无文件'));
        return;
      }
      for (const file of files) {
        const size = file.size != null ? ` (${file.size} bytes)` : '';
        const hasContent = file.content ? ' ✓' : '';
        print(R.dim(`  ${file.name || file.id || 'unnamed'}${size}${hasContent}`));
      }
    },
  },

  help: {
    description: '显示帮助',
    usage: '/help [command]',
    detail: '不带参数列出所有命令，带命令名查看详细用法。',
    example: '/help upload',
    async run(_session, args, print) {
      const target = args[0]?.replace(/^\//, '').toLowerCase();

      if (target && commands[target]) {
        const cmd = commands[target];
        print('');
        print(`  ${chalk.bold.white(cmd.usage)}  ${R.dim(cmd.description)}`);
        if (cmd.detail) print(`  ${R.dim(cmd.detail)}`);
        if (cmd.example) print(`  ${chalk.gray('例:')} ${chalk.cyan(cmd.example)}`);
        print('');
        return;
      }

      print('');
      print(R.info('可用命令:'));
      print('');
      for (const [name, cmd] of Object.entries(commands)) {
        const usage = cmd.usage.padEnd(32);
        print(`  ${chalk.white(usage)} ${R.dim(cmd.description)}`);
      }
      print('');
    },
  },
};

function getCommandNames() {
  return Object.keys(commands).map((k) => '/' + k);
}

function parseInput(input) {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return { type: 'message', text: trimmed };
  }
  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0].toLowerCase();
  const args = parts.slice(1);
  if (commands[name]) {
    return { type: 'command', cmd: commands[name], args };
  }
  return { type: 'message', text: trimmed };
}

module.exports = { commands, parseInput, getCommandNames };
