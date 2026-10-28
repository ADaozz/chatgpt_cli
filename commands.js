/**
 * commands.js — 斜杠命令
 *
 * 精简命令集：连接/断开已自动化，用户只关注对话操作。
 * 模型选择遵循 v2 策略：默认 = 账号最新模型 + 最高强度；
 * 显式指定必须命中可用配置，不降级、不自动选最高版本号。
 */

const path = require('path');
const fs = require('fs');
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
    description: '查看或切换模型与思考强度',
    usage: '/model [name] [effort]',
    detail: '不带参数：列出菜单内可用模型与强度档位（✓ 为当前选择）。带参数切换，如 /model GPT-6 high。不存在的组合直接报错，不降级。',
    example: '/model GPT-6 high',
    async run(session, args, print) {
      const modelCtl = session.client.models;
      if (args.length === 0) {
        const current = await modelCtl.readCurrent();
        if (current) {
          print(R.info(`当前配置: ${current.label}${current.effort ? `（思考强度: ${current.effort}）` : ''}`));
        }
        const available = await modelCtl.listAvailable();
        if (available) {
          print(R.dim('可用模型（按菜单顺序，最新在前）:'));
          for (const m of available.models) {
            const mark = m.selected ? ' ✓' : '';
            print(R.dim(`  ${m.label}${mark}`));
          }
          if (available.effort) {
            print(R.dim(`思考强度档位: 0..${available.effort.max}（当前 ${available.effort.position}）`));
          }
        }
        return;
      }
      const [name, effort] = args;
      print(R.info(`正在应用模型配置: ${name || '(默认: 最新+最高)'}${effort ? ` · ${effort}` : ''} ...`));
      let selected;
      if (session.hasProject) {
        selected = await session.project.selectModel(name || null, effort || null);
      } else if (session.hasConversation) {
        selected = await session.conversation.selectModel(name || null, effort || null);
      } else {
        selected = await session.client.applyModelConfig({ model: name || null, effort: effort || null });
      }
      session.setModel(selected.modelLabel || name, selected.effort || null);
      print(R.ok(`模型配置: ${selected.modelLabel}${selected.effort ? `（强度: ${selected.effort}）` : ''}`));
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
        const result = await session.project.newConversation(msg);
        session.setConversation(
          result.conversationId
            ? new (require('./client').Conversation)(session.client, result.conversationId, session.project._projectId, session.project._projectPath)
            : null
        );
        if (result.conversationId) print(R.dim(`对话 ID: ${result.conversationId}`));
        print('');
        print(R.assistant(result.reply ? result.reply.text : '(无回复文本)'));
      } else {
        const result = await session.client.newConversation(msg);
        if (result.conversationId) {
          const { Conversation } = require('./client');
          session.setConversation(new Conversation(session.client, result.conversationId, null, null));
          print(R.dim(`对话 ID: ${result.conversationId}`));
        }
        print('');
        if (result.state !== 'completed' && result.error) {
          print(R.warn(`状态: ${result.state}${result.error ? ` — ${result.error}` : ''}`));
        }
        print(R.assistant(result.reply ? result.reply.text : '(无回复文本)'));
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

      const { extractConversationId } = require('./url-utils');
      const conversationId = ref.includes('/') ? extractConversationId(ref) : ref;

      if (session.hasProject) {
        const conversation = await session.project.openConversation(conversationId);
        session.setConversation(conversation);
      } else {
        const { Conversation } = require('./client');
        const conversation = new Conversation(session.client, conversationId, null, null);
        await conversation.open();
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
        print(`  ${R.strong(cmd.usage)}  ${R.dim(cmd.description)}`);
        if (cmd.detail) print(`  ${R.dim(cmd.detail)}`);
        if (cmd.example) print(`  ${R.dim('例:')} ${R.code(cmd.example)}`);
        print('');
        return;
      }

      print('');
      print(R.info('可用命令:'));
      print('');
      for (const [name, cmd] of Object.entries(commands)) {
        const usage = cmd.usage.padEnd(32);
        print(`  ${R.strong(usage)} ${R.dim(cmd.description)}`);
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
