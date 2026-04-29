/**
 * auto-connect.js — 启动时自动化
 *
 * 流程：
 *   1. 解析 WSL 宿主机 IP，设置 NO_PROXY
 *   2. 探测 Chrome 调试端口
 *   3. 端口不通 → 检查 Chrome 是否在 localhost 监听 → 设置 netsh 端口转发
 *   4. Chrome 没跑 → 启动 Chrome（带代理、独立 profile）
 *   5. 轮询等待 ChatGPT 登录态
 *   6. 返回已连接的 ChatGPTClient
 */

const { execSync } = require('child_process');
const { ChatGPTClient } = require('./client');

const PORT = process.env.CHATGPT_PORT || '9224';
const PROFILE_DIR = process.env.CHATGPT_PROFILE_DIR || 'C:\\chrome-cdp-profile';

function findChromeWin() {
  const candidates = [process.env.CHROME_WIN];

  // 通过 PowerShell 拿 %LOCALAPPDATA% 下的 Chrome（用户安装）
  try {
    const userChrome = execSync(
      "powershell.exe -NoProfile -Command \"(Get-ChildItem 'C:\\Users\\*\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName\"",
      { timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString().trim().replace(/\r/g, '');
    if (userChrome) candidates.push(userChrome);
  } catch {}

  candidates.push(
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  );

  for (const p of candidates) {
    if (!p) continue;
    try {
      const wslPath = execSync(`wslpath -u '${p.replace(/'/g, "'\\''")}'`, {
        timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
      execSync(`test -f '${wslPath}'`, { stdio: 'ignore', timeout: 3000 });
      return p;
    } catch {}
  }
  return null;
}

function getHostIP() {
  try {
    return execSync("ip route show default | awk '/default/ {print $3; exit}'")
      .toString().trim();
  } catch {
    return null;
  }
}

function setupNoProxy(hostIP) {
  const bypass = `${hostIP},localhost,127.0.0.1,::1`;
  process.env.NO_PROXY = bypass;
  process.env.no_proxy = bypass;
}

function probe(browserURL) {
  try {
    const out = execSync(
      `curl -sS --max-time 3 "${browserURL}/json/version"`,
      { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env } }
    ).toString();
    return out.includes('webSocketDebuggerUrl');
  } catch {
    return false;
  }
}

function chromeListeningOnLocalhost(port) {
  try {
    const out = execSync(
      `powershell.exe -Command "netstat -ano | Select-String ':${port}.*LISTENING'"`,
      { timeout: 8000 }
    ).toString().replace(/\r/g, '');
    return /127\.0\.0\.1|::1|\[::1\]/.test(out);
  } catch {
    return false;
  }
}

function setupPortProxy(port) {
  try {
    const psCmd = [
      `netsh interface portproxy delete v4tov4 listenport=${port} listenaddress=0.0.0.0 2>$null`,
      `netsh interface portproxy delete v4tov6 listenport=${port} listenaddress=0.0.0.0 2>$null`,
      `netsh interface portproxy add v4tov4 listenport=${port} listenaddress=0.0.0.0 connectport=${port} connectaddress=127.0.0.1`,
      `netsh interface portproxy add v4tov6 listenport=${port} listenaddress=0.0.0.0 connectport=${port} connectaddress=::1`,
      `Remove-NetFirewallRule -DisplayName 'Chrome CDP ${port}' -ErrorAction SilentlyContinue`,
      `New-NetFirewallRule -DisplayName 'Chrome CDP ${port}' -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow | Out-Null`,
    ].join('; ');
    execSync(
      `powershell.exe -Command "Start-Process powershell -Verb RunAs -ArgumentList '-Command','${psCmd.replace(/'/g, "''")}'  "`,
      { timeout: 15000, stdio: 'ignore' }
    );
  } catch {}
}

function launchChrome(chromeWin, port, profileDir) {
  const proxy = process.env.CHROME_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  const proxyArg = proxy ? `,'--proxy-server=${proxy}'` : '';
  try {
    execSync(
      `powershell.exe -Command "Start-Process '${chromeWin}' -ArgumentList '--remote-debugging-port=${port}','--remote-debugging-address=0.0.0.0','--user-data-dir=${profileDir}'${proxyArg},'https://chatgpt.com'"`,
      { timeout: 10000, stdio: 'ignore' }
    );
  } catch {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkLoginState(browserURL) {
  let client;
  try {
    client = await ChatGPTClient.create(browserURL);
    const loggedIn = await client._page.evaluate(async () => {
      try {
        const r = await fetch('/api/auth/session');
        const j = await r.json();
        return Boolean(j && j.accessToken);
      } catch {
        return false;
      }
    });
    if (loggedIn) return client;
    await client.disconnect().catch(() => {});
    return null;
  } catch {
    if (client) await client.disconnect().catch(() => {});
    return null;
  }
}

/**
 * @param {(msg: string) => void} log
 * @returns {Promise<{ client: ChatGPTClient, browserURL: string }>}
 */
async function autoConnect(log) {
  // 1. 宿主机 IP
  const hostIP = getHostIP();
  if (!hostIP) throw new Error('无法解析 WSL 宿主机 IP');
  setupNoProxy(hostIP);
  const browserURL = `http://${hostIP}:${PORT}`;

  // 2. 探测端口
  if (probe(browserURL)) {
    log('Chrome 调试端口已就绪');
  } else {
    // 3. Chrome 在 localhost？ → 端口转发
    if (chromeListeningOnLocalhost(PORT)) {
      log('Chrome 已在 localhost 监听，设置端口转发...');
      setupPortProxy(PORT);
    } else {
      // 4. 启动 Chrome
      const chromeWin = findChromeWin();
      if (!chromeWin) throw new Error('找不到 Windows Chrome（设置 CHROME_WIN 环境变量）');
      log('启动 Chrome...');
      launchChrome(chromeWin, PORT, PROFILE_DIR);

      // 等 Chrome 起来
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        if (chromeListeningOnLocalhost(PORT)) break;
        if (i === 29) throw new Error('Chrome 启动超时');
      }
      log('设置端口转发...');
      setupPortProxy(PORT);
    }

    // 等待端口转发生效
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      if (probe(browserURL)) break;
      if (i === 14) throw new Error('端口转发未生效。确认 UAC 弹窗已点"是"。');
    }
    log('端口已就绪');
  }

  // 5. 检查登录态
  let client = await checkLoginState(browserURL);
  if (client) {
    log('ChatGPT 登录态已确认');
    return { client, browserURL };
  }

  log('未检测到登录态，请在 Chrome 窗口登录 chatgpt.com ...');
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    client = await checkLoginState(browserURL);
    if (client) {
      log('ChatGPT 登录态已确认');
      return { client, browserURL };
    }
  }

  throw new Error('等待登录超时（10 分钟）');
}

module.exports = { autoConnect };
