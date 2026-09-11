<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const version = __CHATGPT_CLI_VERSION__;
const copied = ref(false);
const activeMode = ref('analysis');
const visibleCodex = ref(0);
const visibleCli = ref(0);
const animationDone = ref(false);
let timers = [];

const codexLines = [
  { text: '$ codex', tone: 'dim' },
  { text: '› 在实现前，使用 chatgpt-driven-iteration 分析当前项目。', tone: 'bright' },
  { text: '● 模式路由：analysis  ·  ChatGPT = Analyst', tone: 'cyan' },
  { text: '  → 检查 chatgpt-cli、Chrome 登录态与 Git baseline', tone: 'muted' },
  { text: '  → 读取 templates/analysis.md，构造最终 Prompt', tone: 'muted' },
  { text: '  → 打包源码并同步到 ChatGPT Project Sources', tone: 'muted' },
  { text: '✓ 已发起对话，记录 conversationId 并归档对话链接', tone: 'green' },
  { text: '✓ 原始回复保存到 docs/iterations/turn_<N>.md', tone: 'green' },
  { text: '› 根据分析产物继续实现、测试与下一轮 Review。', tone: 'bright' },
];

const cliLines = [
  { text: '$ chatgpt-cli --project my-project upload project.tar.gz --project', tone: 'bright' },
  { text: 'project.tar.gz (184320 bytes, id: file-…)', tone: 'muted' },
  { text: '$ cat analysis-prompt.md | chatgpt-cli --json --project my-project send', tone: 'bright' },
  { text: '────────────────────────────────────────', tone: 'border' },
  { text: '{', tone: 'text' },
  { text: '  "reply": "Analysis Summary…",', tone: 'text' },
  { text: '  "conversationId": "69f17f25-…",', tone: 'cyan' },
  { text: '  "project": "my-project",', tone: 'text' },
  { text: '  "model": "GPT-5.6 Thinking"', tone: 'text' },
  { text: '}', tone: 'text' },
  { text: '$ chatgpt-cli --json messages 69f17f25-… > messages.json', tone: 'bright' },
];

const modeContent = {
  analysis: {
    label: 'MODE: ANALYSIS',
    title: '架构分析 / 方案比较 / 风险评估',
    timing: '触发时机：动手写第一行代码之前',
    text: '把当前代码和约束交给独立推理节点，先明确依赖、风险和可行方案，再进入实现。',
    checks: ['全局模块拓扑与依赖关系', '至少两种可行方案的利弊', '网络、进程与并发边界风险', '改动范围与验证里程碑'],
    outputs: ['推荐方案与理由', '潜在 breaking changes', '预计涉及的文件范围', '实施前的前置条件'],
    tone: 'cyan',
  },
  review: {
    label: 'MODE: REVIEW',
    title: '独立 Code Review / 严苛审查',
    timing: '触发时机：代码完成、测试通过之后',
    text: '在改动完成后审查 correctness、lifecycle、并发和失败路径，避免实现者只看到自己的局部视角。',
    checks: ['Correctness：边缘条件与空值处理', 'Lifecycle：资源释放与悬挂任务', 'Concurrency：竞态条件与状态同步', 'Failure path：异常、重试和回退路径'],
    outputs: ['P0：阻断级问题', 'P1：需要优先修复的问题', 'P2：可维护性与测试建议', '每项 finding 的复现证据'],
    tone: 'yellow',
  },
  verify: {
    label: 'MODE: VERIFY',
    title: '验证 Review Findings 修复',
    timing: '触发时机：Coding Agent 修复 P0 / P1 后',
    text: '围绕已报告的问题检查修复、回归测试和副作用，判断结果是否可以进入下一步。',
    checks: ['Finding 的针对性修复已经落盘', '对应回归测试已经加入', '修复没有引入直接副作用', '没有出现同级或更高的新问题'],
    outputs: ['PASS：可以合入或发布', 'REJECT：修复不完整，需要继续处理', '未通过项的可验证证据', '下一轮所需的最小修改'],
    tone: 'green',
  },
  implementation: {
    label: 'MODE: IMPLEMENTATION',
    title: '转化为可执行的 Implementation Plan',
    timing: '触发时机：Analysis 确认后，实施之前',
    text: '把已确认的技术决策拆成 Coding Agent 可以逐项执行、验证和回顾的工作序列。',
    checks: ['按依赖顺序拆分改动步骤', '说明每一步的目标与影响范围', '给出对应验证命令或验收条件', '标明需要保留的安全边界'],
    outputs: ['按顺序的实现步骤', '每一步的验证方式', '风险和回滚注意事项', '可交给 Coding Agent 的明确任务'],
    tone: 'purple',
  },
};

const currentMode = computed(() => modeContent[activeMode.value]);

function schedule(callback, delay) {
  timers.push(window.setTimeout(callback, delay));
}

function playAnimation() {
  timers.forEach(window.clearTimeout);
  timers = [];
  visibleCodex.value = 0;
  visibleCli.value = 0;
  animationDone.value = false;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    visibleCodex.value = codexLines.length;
    visibleCli.value = cliLines.length;
    animationDone.value = true;
    return;
  }

  codexLines.forEach((_, index) => {
    const delay = index < 6 ? 230 + index * 510 : 4650 + (index - 6) * 580;
    schedule(() => { visibleCodex.value = index + 1; }, delay);
  });
  cliLines.forEach((_, index) => {
    schedule(() => { visibleCli.value = index + 1; }, 2500 + index * 360);
  });
  schedule(() => { animationDone.value = true; }, 6650);
}

async function copyClone() {
  await navigator.clipboard?.writeText('git clone https://github.com/ADaozz/chatgpt_cli.git');
  copied.value = true;
  schedule(() => { copied.value = false; }, 1600);
}

onMounted(playAnimation);
onBeforeUnmount(() => timers.forEach(window.clearTimeout));
</script>

<template>
  <header class="nav">
    <div class="nav-inner">
      <a class="brand" href="#top"><span>$</span> ChatGPT CLI</a>
      <span class="version">v{{ version }}</span>
      <nav aria-label="Page navigation">
        <a class="nav-section" href="#workflow"><span>[01]</span> 工作流</a>
        <a class="nav-section" href="#skill-modes"><span>[02]</span> 工程模式</a>
        <a class="nav-section" href="#advantages"><span>[03]</span> 项目优势</a>
        <a class="nav-section" href="#architecture"><span>[04]</span> 工作原理</a>
        <a class="nav-section" href="#agent-workflow"><span>[05]</span> 调用方式</a>
        <a class="github-link" href="https://github.com/ADaozz/chatgpt_cli" target="_blank" rel="noreferrer">GitHub ↗</a>
      </nav>
    </div>
  </header>

  <main id="top">
    <section class="hero page-grid">
      <h1>给你的 Coding Agent<br /><em>增加第二个推理引擎。</em></h1>
      <p class="lede">让你的 Coding Agent 把耗时的深度分析、Review 和 Plan 交给 ChatGPT。</p>

      <div class="terminal-pair" aria-label="Simulated project workflow">
        <article class="terminal codex-terminal">
          <div class="terminal-bar"><span class="traffic"><i></i><i></i><i></i></span><span>codex — project workspace</span><small>SIMULATED</small></div>
          <div class="terminal-content">
            <p v-for="(line, index) in codexLines.slice(0, visibleCodex)" :key="index" :class="['line', line.tone]">{{ line.text }}</p>
            <span v-if="visibleCodex < codexLines.length || animationDone" class="cursor" aria-hidden="true"></span>
          </div>
        </article>

        <article class="terminal cli-terminal">
          <div class="terminal-bar"><span class="traffic"><i></i><i></i><i></i></span><span>chatgpt-cli — Chrome CDP</span><small>SIMULATED</small></div>
          <div class="terminal-content">
            <p v-for="(line, index) in cliLines.slice(0, visibleCli)" :key="index" :class="['line', line.tone]">{{ line.text }}</p>
            <span v-if="visibleCli < cliLines.length || animationDone" class="cursor" aria-hidden="true"></span>
          </div>
        </article>
      </div>

      <div class="hero-actions" id="get-started">
        <div class="copy-command"><span>$ git clone https://github.com/ADaozz/chatgpt_cli.git</span><button type="button" @click="copyClone">{{ copied ? 'COPIED' : 'COPY' }}</button></div>
        <a class="primary-button" href="https://github.com/ADaozz/chatgpt_cli" target="_blank" rel="noreferrer">View on GitHub ↗</a>
        <small>Node.js ≥ 18 · Chrome · CDP :9224</small>
      </div>
    </section>

    <section id="workflow" class="section page-grid">
      <div class="section-heading"><span>[01]</span><h2>两个终端，一次明确的交接</h2><p>项目中的 Codex 与底层 chatgpt-cli 是两层不同职责。</p></div>
      <div class="handoff-grid">
        <article class="role-card"><span class="role-number">01</span><h3>Codex + 迭代 Skill</h3><p>Codex 负责读取项目、选择工作模式、调用 <code>chatgpt-driven-iteration</code>，并根据返回的证据继续写代码或验证改动。</p><code>project context → skill orchestration → implementation</code></article>
        <article class="role-card"><span class="role-number">02</span><h3>chatgpt-cli</h3><p>CLI 连接已登录的 Chrome，通过 Puppeteer 和 CDP 操作 ChatGPT Web，并向调用方返回完整回复。</p><code>CDP → ChatGPT Web → structured result</code></article>
      </div>
    </section>

    <section id="skill-modes" class="section page-grid modes">
      <div class="section-heading"><span>[02]</span><h2>一个 Skill，四种工程模式</h2><p>一个 Skill 覆盖分析、审查、验证和实施规划；点击 Tab 查看每种模式的委派目标和输出。</p></div>
      <div class="mode-panel">
        <div class="tabs" :class="`active-${activeMode}`" role="tablist" aria-label="Skill modes">
          <button v-for="(_, key, index) in modeContent" :key="key" :class="{ active: activeMode === key }" type="button" role="tab" @click="activeMode = key">[0{{ index + 1 }}] {{ key }}</button>
        </div>
        <div class="mode-content" :class="currentMode.tone">
          <div class="mode-title"><div><span>{{ currentMode.label }}</span><h3>{{ currentMode.title }}</h3></div><small>{{ currentMode.timing }}</small></div>
          <p>{{ currentMode.text }}</p>
          <div class="mode-grid">
            <div><b>审查与执行要点 / Checks</b><ul><li v-for="item in currentMode.checks" :key="item">{{ item }}</li></ul></div>
            <div><b>交付物 / Artifacts</b><ul><li v-for="item in currentMode.outputs" :key="item">{{ item }}</li></ul></div>
          </div>
        </div>
      </div>
    </section>

    <section id="advantages" class="section page-grid">
      <div class="section-heading"><span>[03]</span><h2>用等待时间，换取独立推理</h2><p>Skill 将长时间分析、Review 与 Plan 留在 ChatGPT Web 会话中，让 Coding Agent 保持干净的实现上下文，并为每轮交互留下可追溯产物。</p></div>
      <div class="comparison-grid">
        <article class="comparison-card without"><div class="comparison-head"><b>不做委派 / One agent loop</b><span>单一视角</span></div><div class="context-meter"><div><small>主 Agent Context</small><strong>高负载 · 示意</strong></div><i><em></em></i></div><p>实现、Plan、Review 和验证都由同一个 Agent 在同一段上下文中完成。</p><div class="comparison-list"><span>01. 项目背景和约束需要在每轮重复携带</span><span>02. 深度分析与审查持续占用主 Agent token</span><span>03. 实现者与审查者容易共享同一盲点</span><span>04. 每轮结论缺少统一的归档与回溯入口</span></div><small>结果：主任务上下文膨胀，独立验证成本也更高。</small></article>
        <article class="comparison-card with"><div class="comparison-head"><b>使用 chatgpt-cli Skill 委派</b><span>上下文保持干净</span></div><div class="context-meter"><div><small>主 Agent Context</small><strong>保持聚焦 · 示意</strong></div><i><em></em></i></div><p>Skill 负责编排，chatgpt-cli 负责传输；Codex 将长分析、Review 和 Plan 交给 ChatGPT Web 会话。</p><div class="comparison-list"><span>01. 源码、Prompt 与规则在独立会话中完成推理</span><span>02. Coding Agent 保留实现、测试与决策所需的精简上下文</span><span>03. analysis / review / verify / implementation 都保存原始交互产物</span><span>04. conversationId 与对话链接形成每轮可追溯的审计记录</span></div><small>优势：减少主 Agent 在 Plan 和 Review 中的 token 消耗，同时保留完整证据链。</small></article>
      </div>
    </section>

    <section id="architecture" class="section page-grid">
      <div class="section-heading"><span>[04]</span><h2>它实际上是怎样工作的？</h2><p>运行在本地：不需要 OpenAI API Key，复用浏览器的 ChatGPT 登录态。</p></div>
      <div class="architecture">
        <div class="flow-diagram" aria-label="chatgpt-cli architecture flow"><div><b>Node.js</b><span>chatgpt-cli</span></div><i>Puppeteer / CDP</i><div><b>Google Chrome</b><span>--remote-debugging-port=9224</span></div><i>已登录的浏览器会话</i><div><b>chatgpt.com</b><span>Web DOM + backend-api</span></div></div>
        <div class="architecture-copy">
          <h3>Event-driven reply tracking</h3>
          <p>回复完成主要由页面内的 <code>MutationObserver</code> 追踪 assistant 文本、Stop 按钮和消息变化；静默窗口确认完成。低频 watchdog 负责 DOM 采样、监听恢复，backend snapshot 只作为异常场景的回退校验。</p>
          <div class="fact-row"><span>Runtime</span><strong>Node.js / CommonJS</strong></div>
          <div class="fact-row"><span>Browser bridge</span><strong>puppeteer-core + CDP</strong></div>
          <div class="fact-row"><span>Terminal theme</span><strong>chalk · cyan / green / yellow</strong></div>
        </div>
      </div>
    </section>

    <section id="agent-workflow" class="section page-grid">
      <div class="section-heading"><span>[05]</span><h2>Agent 实际是怎么调用它的？</h2><p>以下是 Skill 中的实际编排：打包、上传、按模板发送 Prompt，并保存每轮的原始交互产物。</p></div>
      <div class="agent-workflow"><div class="shell-steps"><b>Agent subshell sequence</b><div><small># 1. 打包当前源码与证据</small><code><i>tar</i> czf project.tar.gz --exclude='project/.git' --exclude='project/node_modules' --exclude='project/dist' project</code></div><div><small># 2. 上传到 ChatGPT Project Sources</small><code><i>chatgpt-cli</i> --project my-project upload project.tar.gz --project</code></div><div><small># 3. 按模式模板发送最终 Prompt</small><code><i>cat</i> analysis-prompt.md | <i>chatgpt-cli</i> --json --project my-project send</code></div><div><small># 4. 归档完整对话产物</small><code><i>chatgpt-cli</i> --json messages &lt;conversation_id&gt; &gt; messages.json</code></div></div><div class="json-output"><div><b>stdout payload (JSON)</b><span>exit code: 0</span></div><pre>{
  <em>"reply"</em>: <strong>"Review completed…"</strong>,
  <em>"conversationId"</em>: <strong>"69f17f25-…"</strong>,
  <em>"project"</em>: <strong>"my-project"</strong>,
  <em>"model"</em>: <strong>"GPT-5.6 Thinking"</strong>
}</pre><p>调用方可以读取 JSON 中的 <code>reply</code>，将结论交回 Codex 继续执行。</p></div></div>
    </section>

  </main>

  <footer><span>ChatGPT CLI</span><span>Local terminal workflow for ChatGPT Web</span><span>Built by ADaozz</span></footer>
</template>
