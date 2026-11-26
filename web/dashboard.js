'use strict';

const byId = id => document.getElementById(id);
const THEME_KEY = 'rcm_theme';
const FREE_QUOTA = 10000;
const terminalStates = new Set(['succeeded', 'failed', 'denied', 'cancelled', 'timed_out', 'interrupted']);
const labels = {
  queued: '排队中', dispatched: '已派发', awaiting_approval: '待本机确认', running: '运行中',
  succeeded: '已完成', failed: '失败', denied: '已拒绝', cancelled: '已取消', timed_out: '已超时', interrupted: '已中断'
};
const capabilityNames = { read: '读取', write: '写入', exec: '命令' };
const platformNames = { darwin: 'macOS', win32: 'Windows', linux: 'Linux', android: 'Android' };
const panels = {
  devices: ['设备', '通过 Remote MCP 让 AI 客户端安全访问你的电脑。'],
  usage: ['用量', '查看本月工具调用额度与近 6 个月趋势。'],
  plan: ['套餐与计费', '管理 Free（10,000 次/月）与 Pro（Unlimited）套餐权益。'],
  activity: ['任务与审计', '跟踪远程工具调用、本机审批与安全审计记录。'],
  settings: ['设置', '管理账号资料、外观主题与外部 OAuth 授权。'],
  'admin-overview': ['全站管理', '管理员专属全站运营与安全治理视图。']
};

let csrf = '';
let currentSession = null;
let devices = [];
let auditRecords = [];
let oauthClients = [];
let activePanel = 'devices';
let activeActivity = 'tasks';
let activePromptCat = 'inspect';
const promptTemplates = {
  inspect: [
    {
      title: '检查在线设备与权限',
      safety: '只读',
      readOnly: true,
      prompt: '请调用 Remote.Command 的 who_am_i 和 list_devices，列出当前账号、在线设备及可用权限，不要修改任何文件或执行命令。'
    },
    {
      title: '扫描工作区并总结结构',
      safety: '只读',
      readOnly: true,
      prompt: '使用 Remote.Command 先选定我的在线设备，再读取工作区目录结构并总结项目技术栈与核心文件，保持只读不作任何修改。'
    },
    {
      title: '全文检索关键词或 TODO',
      safety: '只读',
      readOnly: true,
      prompt: '使用 Remote.Command 的搜索工具在工作区中查找所有 "TODO" 或 "FIXME"，按文件和行号汇总成清单，不要改动代码。'
    }
  ],
  files: [
    {
      title: '排查大文件与清理清单',
      safety: '先出方案',
      readOnly: false,
      prompt: '使用 Remote.Command 检查工作区目录大小与占用较高的临时或冗余文件，先整理可清理清单和风险说明等我确认，未确认前不要删除或移动文件。'
    },
    {
      title: '梳理文件命名与目录规范',
      safety: '先出方案',
      readOnly: false,
      prompt: '使用 Remote.Command 只读浏览工作区文件名与目录层级，先输出结构重命名对照表与迁移方案供我审核，不要直接写文件。'
    }
  ],
  debug: [
    {
      title: '日志与源码联动排错',
      safety: '先出方案',
      readOnly: false,
      prompt: '使用 Remote.Command 读取工作区最近的报错日志与相关源码文件，定位根因后先向我解释问题并给出最小修复方案，先不要修改文件。'
    },
    {
      title: '比对两份配置文件差异',
      safety: '只读',
      readOnly: true,
      prompt: '使用 Remote.Command 读取两份配置文件并逐项对比差异与潜在风险，只输出对比分析报告，不要写入任何配置。'
    }
  ],
  ops: [
    {
      title: '检查磁盘、内存与进程状态',
      safety: '只读',
      readOnly: true,
      prompt: '使用 Remote.Command 只读查看目标设备的磁盘剩余空间、内存占用与当前运行进程概况，汇总潜在异常，不要执行重启或终止操作。'
    },
    {
      title: '排查最近日志尾部报错',
      safety: '只读',
      readOnly: true,
      prompt: '使用 Remote.Command 读取工作区日志目录中最新日志文件末尾 100 行，归纳错误或告警原因，保持只读，不要更改服务配置。'
    }
  ]
};
let currentTask = '';
let refreshing = false;
let verifiedCode = '';
let watchOnlineDeviceId = '';
let watchOnlineBaselineCount = 0;
let watchOnlineTimer = null;

// --- Theme Management (Light / Dark / System) ---
function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') {
    document.documentElement.setAttribute('data-theme', mode);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  document.querySelectorAll('.theme-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeChoice === mode);
  });
}

function getTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

applyTheme(getTheme());

// --- DOM Helpers ---
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(label, className, action) {
  const el = node('button', className, label);
  el.type = 'button';
  el.addEventListener('click', () => act(action));
  return el;
}

function notice(message, failed = false) {
  const el = byId('notice');
  el.textContent = message;
  el.className = 'notice' + (failed ? ' error' : '');
  el.hidden = false;
}

async function api(path, data) {
  const options = { credentials: 'same-origin', headers: {} };
  if (data !== undefined) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
    options.headers['X-CSRF-Token'] = csrf;
    options.body = JSON.stringify(data);
  }
  const response = await fetch('/manage/api/' + path, options);
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(result.error || '请求失败，请稍后重试。');
  }
  return result;
}

async function act(action) {
  try { await action(); }
  catch (error) { notice(error.message, true); }
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未连接';
}

function relativeTime(value) {
  if (!value) return '从未连接';
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (diffSec < 60) return '刚刚在线';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return `${Math.floor(diffSec / 86400)} 天前`;
}

function relativeActivityTime(value) {
  if (!value) return '暂无记录';
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  return `${Math.floor(diffSec / 86400)} 天前`;
}

function clientInitials(label) {
  return String(label || '').replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, '').slice(0, 2).toUpperCase() || 'MC';
}

function nextMonthResetLabel() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const daysLeft = Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 86400000));
  return { label: `${next.getUTCMonth() + 1}月1日`, daysLeft };
}

function statePill(state) {
  return node('span', 'pill ' + state, labels[state] || state);
}

function detectOS() {
  const ua = (navigator.userAgent || '').toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  return 'linux';
}

async function copyText(text, label = '已复制到剪贴板。') {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  notice(label);
}

async function copyElement(id, label) {
  const el = byId(id);
  if (!el) return;
  await copyText(el.textContent, label);
}

// --- Auth & App Shell ---
function showLogin() {
  stopOnlineWatch();
  csrf = '';
  currentSession = null;
  byId('notice').hidden = true;
  byId('login-username').value = 'admin';
  byId('login-password').value = '';
  byId('app-view').hidden = true;
  byId('login-view').hidden = false;
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  const googleBtn = byId('google-login-btn');
  const pwFields = byId('password-login-fields');
  if (googleBtn) {
    const returnTo = location.pathname + (location.search || '');
    googleBtn.href = '/auth/google/start?return_to=' + encodeURIComponent(returnTo);
  }
  fetch('/manage/api/auth-config', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null))
    .then(cfg => {
      if (!cfg) return;
      if (googleBtn) googleBtn.hidden = !cfg.googleEnabled;
      if (pwFields) pwFields.hidden = !!(cfg.googleEnabled && !cfg.hasPasswordAdmin);
    })
    .catch(() => {});
}

async function showApp(session) {
  csrf = session.csrf;
  currentSession = session;
  byId('login-view').hidden = true;
  byId('app-view').hidden = false;

  const displayName = session.displayName || session.email || session.username || 'User';
  const initials = displayName.replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, '').slice(0, 2).toUpperCase() || 'U';
  byId('sidebar-avatar').textContent = initials;
  byId('sidebar-user').textContent = session.email || session.username || displayName;
  byId('sidebar-role').textContent = (session.plan === 'pro' ? 'Pro' : 'Free') + (session.role === 'admin' ? ' · Admin' : '');
  byId('settings-avatar').textContent = initials;
  byId('settings-email').textContent = session.email || session.username || displayName;
  byId('settings-meta').textContent = `角色：${session.role === 'admin' ? '管理员' : '普通用户'} · 当前套餐：${session.plan === 'pro' ? 'Pro (Unlimited)' : 'Free (10,000/月)'}`;
  byId('admin-nav-group').hidden = session.role !== 'admin';

  const gateway = session.origin || location.origin;
  byId('device-start-ps').textContent = 'irm ' + gateway + '/install.ps1 | iex';
  byId('device-start-sh').textContent = 'curl -fsSL ' + gateway + '/install.sh | bash';
  const mcpUrl = session.mcpUrl || location.origin + '/mcp';
  byId('mcp-url').textContent = mcpUrl;
  byId('overview-mcp-url').textContent = mcpUrl;

  applyTheme(getTheme());
  renderPromptLibrary();
  await refresh();

  const query = new URLSearchParams(location.search);
  const code = query.get('user_code');
  if (code && /^[A-Za-z0-9-]{4,32}$/.test(code)) {
    openVerification(code);
    query.delete('user_code');
    history.replaceState(null, '', location.pathname + (query.size ? '?' + query.toString() : ''));
  }
}

function switchPanel(name) {
  if (!panels[name]) return;
  activePanel = name;
  byId('page-title').textContent = panels[name][0];
  byId('page-description').textContent = panels[name][1];
  document.querySelectorAll('.panel').forEach(panel => {
    panel.hidden = panel.id !== 'panel-' + name;
  });
  document.querySelectorAll('.nav-link').forEach(link => {
    const active = link.dataset.panel === name;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

// --- Quota & Usage Rendering ---
function renderQuotaAndUsage(totalCalls) {
  const isPro = currentSession?.plan === 'pro';
  const { label: resetLabel, daysLeft } = nextMonthResetLabel();
  const pct = isPro ? 0 : Math.min(100, Math.round((totalCalls / FREE_QUOTA) * 100));

  // Sidebar quota card
  byId('sidebar-quota-pct').textContent = isPro ? 'Pro' : `${pct}%`;
  const sFill = byId('sidebar-quota-fill');
  sFill.style.width = isPro ? '100%' : `${pct}%`;
  sFill.className = 'quota-fill' + (!isPro && pct >= 100 ? ' full' : !isPro && pct >= 80 ? ' warn' : '');
  byId('sidebar-quota-text').textContent = isPro
    ? `${totalCalls.toLocaleString()} 次 · Unlimited`
    : `${totalCalls.toLocaleString()} / ${FREE_QUOTA.toLocaleString()} 本月`;
  byId('sidebar-quota-reset').textContent = isPro ? '无限次工具调用已启用' : `将于 ${resetLabel} 重置`;
  byId('sidebar-upgrade-btn').hidden = isPro;

  // Global top banner
  const banner = byId('quota-banner');
  if (!isPro && pct >= 80) {
    banner.hidden = false;
    banner.className = 'quota-banner' + (pct >= 100 ? ' full' : '');
    byId('quota-banner-text').textContent = pct >= 100
      ? `本月 ${FREE_QUOTA.toLocaleString()} 次免费工具调用已用完，将于 ${resetLabel} 重置。`
      : `本月免费工具调用已使用 ${pct}%（${totalCalls.toLocaleString()} / ${FREE_QUOTA.toLocaleString()}），将于 ${resetLabel} 重置。`;
  } else {
    banner.hidden = true;
  }

  // Usage KPI cards
  byId('usage-month-value').textContent = isPro
    ? `${totalCalls.toLocaleString()} · Unlimited`
    : `${totalCalls.toLocaleString()} / ${FREE_QUOTA.toLocaleString()}`;
  const uFill = byId('usage-quota-fill');
  uFill.style.width = isPro ? '100%' : `${pct}%`;
  uFill.className = sFill.className;
  byId('usage-month-sub').textContent = isPro
    ? '当前为 Pro 套餐，不限制月度调用次数'
    : `已使用 ${pct}% · ${resetLabel} 重置（剩余 ${daysLeft} 天）`;
  const dayOfMonth = Math.max(1, new Date().getUTCDate());
  byId('usage-daily-avg').textContent = Math.round(totalCalls / dayOfMonth).toLocaleString();

  // Plan cards active state
  byId('plan-card-free').classList.toggle('active-plan', !isPro);
  byId('plan-card-pro').classList.toggle('active-plan', isPro);
  byId('badge-plan-free').hidden = isPro;
  byId('badge-plan-pro').hidden = !isPro;

  renderUsageChart(totalCalls);
}

function renderUsageChart(currentMonthCalls) {
  const wrap = byId('usage-chart');
  wrap.replaceChildren();
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ label: `${d.getUTCMonth() + 1}月`, value: i === 0 ? currentMonthCalls : 0 });
  }
  const maxVal = Math.max(10, ...months.map(m => m.value));
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'usage-svg');
  svg.setAttribute('viewBox', '0 0 600 200');

  const padL = 44, padB = 28, padT = 16, chartH = 200 - padT - padB, chartW = 600 - padL - 16;
  for (let i = 0; i <= 2; i++) {
    const y = padT + (chartH / 2) * i;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(padL));
    line.setAttribute('x2', String(600 - 16));
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    svg.appendChild(line);

    const lbl = document.createElementNS(ns, 'text');
    lbl.setAttribute('x', String(padL - 8));
    lbl.setAttribute('y', String(y + 4));
    lbl.setAttribute('text-anchor', 'end');
    lbl.textContent = String(Math.round(maxVal * (1 - i / 2)));
    svg.appendChild(lbl);
  }

  const slotW = chartW / months.length;
  const barW = Math.min(46, slotW * 0.48);
  months.forEach((m, idx) => {
    const h = m.value > 0 ? Math.max(6, (m.value / maxVal) * chartH) : 2;
    const x = padL + idx * slotW + (slotW - barW) / 2;
    const y = padT + chartH - h;
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('class', 'bar');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(barW));
    rect.setAttribute('height', String(h));
    svg.appendChild(rect);

    const xText = document.createElementNS(ns, 'text');
    xText.setAttribute('x', String(x + barW / 2));
    xText.setAttribute('y', String(200 - 8));
    xText.setAttribute('text-anchor', 'middle');
    xText.textContent = m.label;
    svg.appendChild(xText);
  });

  wrap.appendChild(svg);
}

// --- Devices Rendering ---
function renderDevices() {
  const container = byId('devices');
  container.replaceChildren();
  const activeCount = devices.filter(d => !d.revoked).length;
  const onlineCount = devices.filter(d => d.online).length;
  byId('device-count').textContent = activeCount
    ? `${onlineCount} 台在线 · 共 ${activeCount} 台已配对设备`
    : '还没有配对设备，点击右上角「+ 添加设备」开始。';
  byId('device-filters').hidden = devices.length < 4;

  const query = byId('device-search').value.trim().toLowerCase();
  const statusFilter = byId('device-status').value;
  const visible = devices.filter(d => {
    if (statusFilter === 'online' && !d.online) return false;
    if (statusFilter === 'offline' && (d.online || d.revoked)) return false;
    if (statusFilter === 'revoked' && !d.revoked) return false;
    if (query && !d.name.toLowerCase().includes(query) && !d.id.toLowerCase().includes(query)) return false;
    return true;
  });

  if (!visible.length) {
    container.appendChild(node('div', 'empty-state', devices.length ? '没有匹配的设备。' : '点击「+ 添加设备」，在目标电脑运行一行命令即可连接。'));
    return;
  }

  for (const device of visible) {
    const row = node('div', 'device-row');
    const main = node('div', 'device-main');
    main.appendChild(node('span', 'status-dot' + (device.online ? ' online' : '')));

    const info = node('div', 'device-info');
    const title = node('div', 'device-name');
    title.appendChild(node('span', '', device.name));
    if (device.platform) title.appendChild(node('span', 'pill', platformNames[device.platform] || device.platform));
    title.appendChild(node('span', 'pill ' + (device.revoked ? 'revoked' : device.online ? 'online' : ''), device.revoked ? '已撤销' : device.online ? 'Online' : 'Offline'));
    info.appendChild(title);

    const capsText = (device.capabilities || []).map(c => capabilityNames[c] || c).join(' · ');
    const seenText = device.online ? '当前在线' : `最后在线 ${relativeTime(device.lastSeen)}`;
    info.appendChild(node('div', 'device-meta', `${seenText} · 权限：${capsText || '只读'}`));
    main.appendChild(info);

    const actions = node('div', 'device-actions');
    if (!device.revoked) {
      if (!device.online) {
        actions.appendChild(button('重连', 'primary', () => openDeviceDialog({ mode: 'reconnect', device })));
      }
      actions.appendChild(button('重命名', 'secondary', async () => {
        const renamed = await confirmAction('重命名设备', `修改「${device.name}」的显示名称。`, device.name);
        if (!renamed) return;
        await api(`devices/${device.id}/rename`, { name: renamed });
        notice('设备名称已更新。');
        await refresh();
      }));
      actions.appendChild(button(device.online ? '撤销' : '移除', 'danger', async () => {
        if (!await confirmAction('撤销设备', `确认撤销「${device.name}」？撤销后需重新配对，进行中任务将中断。`)) return;
        await api(`devices/${device.id}/revoke`, {});
        notice(`已撤销设备「${device.name}」。`);
        await refresh();
      }));
    }
    row.append(main, actions);
    container.appendChild(row);
  }
}

// --- 3-Step Add Device & 2-Step Reconnect Dialog (with Auto Online Detection) ---
function setDialogOS(os) {
  document.querySelectorAll('.os-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.os === os));
  byId('os-panel-windows').hidden = os !== 'windows';
  byId('os-panel-unix').hidden = os === 'windows';
}

function setDialogStep(stepNum) {
  byId('step-1').classList.toggle('active', stepNum === 1);
  byId('step-2').classList.toggle('active', stepNum === 2);
  byId('step-3').classList.toggle('active', stepNum === 3);
  byId('step-2-hint').hidden = stepNum < 2;
}

function stopOnlineWatch() {
  if (watchOnlineTimer) {
    clearInterval(watchOnlineTimer);
    watchOnlineTimer = null;
  }
  watchOnlineDeviceId = '';
}

function startOnlineWatch(targetDeviceId) {
  stopOnlineWatch();
  watchOnlineDeviceId = targetDeviceId || '';
  watchOnlineBaselineCount = devices.filter(d => d.online).length;
  watchOnlineTimer = setInterval(async () => {
    const dialog = byId('start-device-dialog');
    if (!dialog.open || !csrf) {
      stopOnlineWatch();
      return;
    }
    try {
      const overview = await api('overview');
      devices = overview.devices;
      renderDevices();
      if (watchOnlineDeviceId) {
        const target = devices.find(d => d.id === watchOnlineDeviceId);
        if (target?.online) {
          stopOnlineWatch();
          dialog.close();
          notice(`设备「${target.name}」已重新上线！`);
        }
      } else if (devices.filter(d => d.online).length > watchOnlineBaselineCount) {
        stopOnlineWatch();
        dialog.close();
        notice('新设备已成功连接并上线！');
      }
    } catch { /* ignore transient poll errors */ }
  }, 2500);
}

function openDeviceDialog({ mode = 'add', device = null } = {}) {
  const isReconnect = mode === 'reconnect' && device;
  byId('start-device-title').textContent = isReconnect ? `重新连接 ${device.name}` : '连接新设备';
  byId('start-device-sub').textContent = isReconnect
    ? `在「${device.name}」的终端运行下方命令即可恢复在线，上线后此窗口会自动关闭。`
    : '选择目标电脑的操作系统，复制命令在终端运行即可自动配置环境并连接。';
  byId('step-3-sep').hidden = !!isReconnect;
  byId('step-3').hidden = !!isReconnect;
  byId('start-enter-code').hidden = !!isReconnect;
  byId('other-connect-ways').hidden = !!isReconnect;
  byId('reconnect-live-pill').hidden = !isReconnect;
  setDialogStep(1);

  const preferredOs = isReconnect && device.platform === 'win32'
    ? 'windows'
    : isReconnect && device.platform === 'darwin'
      ? 'macos'
      : isReconnect && device.platform === 'linux'
        ? 'linux'
        : detectOS();
  setDialogOS(preferredOs);

  byId('start-device-dialog').showModal();
  startOnlineWatch(isReconnect ? device.id : '');
}

// --- Tasks & Audit ---
async function refreshTasks() {
  const devSelect = byId('task-device');
  const prev = devSelect.value;
  devSelect.replaceChildren(node('option', '', '全部设备'));
  devSelect.firstChild.value = '';
  for (const d of devices) {
    const opt = node('option', '', d.name);
    opt.value = d.id;
    devSelect.appendChild(opt);
  }
  devSelect.value = devices.some(d => d.id === prev) ? prev : '';

  const qs = devSelect.value ? '?device=' + encodeURIComponent(devSelect.value) : '';
  const { tasks } = await api('tasks' + qs);
  const statusFilter = byId('task-status').value;
  const filtered = tasks.filter(t => {
    if (!statusFilter) return true;
    if (statusFilter === 'active') return !terminalStates.has(t.status);
    return t.status === statusFilter;
  });

  const tbody = byId('tasks');
  tbody.replaceChildren();
  if (!filtered.length) {
    const tr = document.createElement('tr');
    const td = node('td', 'subtle', '暂无匹配的任务记录。');
    td.colSpan = 5;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const t of filtered) {
    const tr = document.createElement('tr');
    const devName = devices.find(d => d.id === t.device)?.name || t.device.slice(0, 8);
    tr.append(
      node('td', '', t.toolName || t.operation),
      node('td', '', devName),
      (() => { const td = document.createElement('td'); td.appendChild(statePill(t.status)); return td; })(),
      node('td', 'tabular', formatTime(t.createdAt)),
      (() => { const td = document.createElement('td'); td.appendChild(button('查看', 'text-button', () => openTask(t.id))); return td; })()
    );
    tbody.appendChild(tr);
  }
}

function renderAudit() {
  const query = byId('audit-search').value.trim().toLowerCase();
  const tbody = byId('audit');
  tbody.replaceChildren();
  const rows = auditRecords.filter(r => !query || r.event.toLowerCase().includes(query) || JSON.stringify(r.details).toLowerCase().includes(query));
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = node('td', 'subtle', '暂无审计记录。');
    td.colSpan = 3;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.append(
      node('td', 'tabular', formatTime(r.at)),
      node('td', '', r.event),
      node('td', '', JSON.stringify(r.details))
    );
    tbody.appendChild(tr);
  }
}

async function openTask(id) {
  currentTask = id;
  await updateTask(id);
  byId('task-dialog').showModal();
}

async function updateTask(id) {
  const t = await api('tasks/' + id);
  const statusEl = byId('task-detail-status');
  statusEl.replaceChildren(statePill(t.status));
  byId('task-meta').textContent = `${t.toolName || t.operation} · 更新于 ${formatTime(t.updatedAt)}`;
  byId('task-id').textContent = t.id;
  byId('task-approval').hidden = t.status !== 'awaiting_approval';
  byId('task-output').textContent = t.output || (t.result ? JSON.stringify(t.result, null, 2) : '（暂无输出）');
  byId('cancel-task').hidden = terminalStates.has(t.status);
}

// --- Confirm / Rename Dialog ---
async function confirmAction(title, description, initialName) {
  const dialog = byId('confirm-dialog');
  byId('confirm-title').textContent = title;
  byId('confirm-description').textContent = description;
  const renameMode = initialName !== undefined;
  byId('rename-label').hidden = !renameMode;
  const input = byId('rename-value');
  input.hidden = !renameMode;
  input.value = initialName || '';
  dialog.showModal();
  const result = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  if (result !== 'confirm') return false;
  return renameMode ? input.value.trim() : true;
}

// --- Device Code Verification ---
function openVerification(prefill = '') {
  verifiedCode = '';
  byId('verify-form').reset();
  byId('verify-code').value = prefill;
  byId('verify-details').hidden = true;
  byId('verify-actions').hidden = true;
  byId('verify-error').textContent = '';
  byId('verify-dialog').showModal();
  if (prefill) act(lookupDeviceCode);
}

async function lookupDeviceCode() {
  const code = byId('verify-code').value.trim();
  if (!code) return;
  byId('verify-error').textContent = '';
  try {
    const info = await api('device-preview', { user_code: code });
    verifiedCode = code;
    byId('verify-host').textContent = info.deviceName;
    byId('verify-expiry').textContent = '有效期至 ' + formatTime(info.expiresAt);
    byId('verify-name').value = info.deviceName;
    byId('verify-details').hidden = false;
    byId('verify-actions').hidden = false;
  } catch (err) {
    verifiedCode = '';
    byId('verify-details').hidden = true;
    byId('verify-actions').hidden = true;
    byId('verify-error').textContent = err.message;
  }
}

async function submitDeviceDecision(approve) {
  if (!verifiedCode) return;
  const data = new FormData(byId('verify-form'));
  const caps = data.getAll('capabilities');
  const name = (data.get('name') || '').toString().trim() || undefined;
  const res = await api('device-verify', { user_code: verifiedCode, name, capabilities: caps.length ? caps : ['read'], approve });
  byId('verify-dialog').close();
  notice(approve ? `已授权设备「${res.deviceName}」，等待设备完成上线。` : `已拒绝设备「${res.deviceName}」的配对请求。`);
  await refresh();
}

function renderOAuthClients() {
  const container = byId('oauth-clients');
  if (!container) return;
  container.replaceChildren();

  if (!oauthClients.length) {
    container.appendChild(node('div', 'empty-state', '当前没有活跃的已授权 OAuth 客户端。'));
    return;
  }

  for (const client of oauthClients) {
    const row = node('div', 'device-row');
    const main = node('div', 'device-main');
    const label = client.clientName || client.clientId;
    main.appendChild(node('span', 'client-icon', clientInitials(label)));

    const info = node('div', 'device-info');
    const title = node('div', 'device-name');
    title.appendChild(node('span', '', label));

    const origins = Array.isArray(client.redirectOrigins) ? client.redirectOrigins : [];
    for (const origin of origins.slice(0, 2)) {
      let hostLabel = origin;
      try { hostLabel = new URL(origin).host || origin; } catch { /* keep raw origin */ }
      title.appendChild(node('span', 'pill', hostLabel));
    }
    if (origins.length > 2) {
      title.appendChild(node('span', 'pill', `+${origins.length - 2}`));
    }
    title.appendChild(node('span', 'pill online', `${client.activeSessions || 1} 个活跃会话`));
    info.appendChild(title);

    const authLabel = client.authorizedAt ? formatTime(client.authorizedAt) : '未知';
    const activeLabel = relativeActivityTime(client.lastActiveAt);
    const meta = node('div', 'device-meta', `ID: ${client.clientId} · 首次授权 ${authLabel} · 最近活跃 ${activeLabel}`);
    if (client.lastActiveAt) {
      meta.title = '最近活跃时间：' + formatTime(client.lastActiveAt);
    }
    info.appendChild(meta);
    main.appendChild(info);

    const actions = node('div', 'device-actions');
    actions.appendChild(button('撤销', 'danger', async () => {
      if (!await confirmAction('撤销客户端授权', `确认撤销「${label}」的所有访问与刷新令牌？该客户端需要重新授权，不影响其他已连接客户端。`)) return;
      await api('oauth/clients/' + encodeURIComponent(client.clientId) + '/revoke', {});
      notice(`已撤销「${label}」的 OAuth 授权。`);
      await refreshOAuthClients();
    }));

    row.append(main, actions);
    container.appendChild(row);
  }
}

async function refreshOAuthClients() {
  const res = await api('oauth/clients');
  oauthClients = res.clients || [];
  renderOAuthClients();
}

function renderPromptLibrary() {
  const container = byId('prompt-library');
  if (!container) return;
  container.replaceChildren();

  const items = promptTemplates[activePromptCat] || [];
  for (const item of items) {
    const card = node('article', 'prompt-card');
    const head = node('div', 'prompt-card-head');
    head.append(
      node('strong', '', item.title),
      node('span', 'pill' + (item.readOnly ? ' online' : ''), item.safety)
    );
    const text = node('p', 'prompt-card-text', item.prompt);
    const foot = node('div', 'prompt-card-foot');
    foot.appendChild(button('复制', 'secondary', () => copyText(item.prompt, `已复制「${item.title}」Prompt。`)));
    card.append(head, text, foot);
    container.appendChild(card);
  }
}

// --- Main Refresh ---
async function refresh() {
  if (!csrf || refreshing) return;
  refreshing = true;
  try {
    const overview = await api('overview');
    devices = overview.devices;
    renderDevices();
    renderQuotaAndUsage(overview.totalCalls || 0);
    byId('last-refresh').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    if (activePanel === 'activity') {
      if (activeActivity === 'tasks') await refreshTasks();
      else {
        const res = await api('audit');
        auditRecords = res.records;
        renderAudit();
      }
    } else if (activePanel === 'settings') {
      await refreshOAuthClients();
    }
  } finally {
    refreshing = false;
  }
}

// --- Event Bindings ---
byId('login-form').addEventListener('submit', event => {
  event.preventDefault();
  byId('login-error').textContent = '';
  act(async () => {
    const data = new FormData(event.target);
    const res = await fetch('/manage/api/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: data.get('username'), password: data.get('password') })
    });
    const body = await res.json();
    if (!res.ok) {
      byId('login-error').textContent = body.error || '登录失败。';
      return;
    }
    await showApp(await api('session'));
  });
});

async function handleLogout() {
  await api('logout', {});
  showLogin();
}
byId('logout').addEventListener('click', () => act(handleLogout));
byId('settings-logout').addEventListener('click', () => act(handleLogout));
byId('profile-trigger').addEventListener('click', () => {
  switchPanel('settings');
  act(refresh);
});

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', () => {
    switchPanel(link.dataset.panel);
    act(refresh);
  });
});

document.querySelectorAll('.theme-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.themeChoice;
    localStorage.setItem(THEME_KEY, mode);
    applyTheme(mode);
  });
});

document.querySelectorAll('.client-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = byId(btn.dataset.target);
    if (!target) return;
    target.hidden = !target.hidden;
    btn.textContent = target.hidden ? '展开步骤' : '收起';
  });
});

document.querySelectorAll('.copy-prompt').forEach(btn => {
  btn.addEventListener('click', () => act(() => copyElement(
    btn.dataset.source,
    btn.dataset.source === 'chatgpt-custom-instructions' ? '已复制推荐自定义指令。' : '已复制 Prompt 示例。'
  )));
});

document.querySelectorAll('.prompt-cat').forEach(btn => {
  btn.addEventListener('click', () => {
    activePromptCat = btn.dataset.promptCat || 'inspect';
    document.querySelectorAll('.prompt-cat').forEach(tab => {
      const selected = tab === btn;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    renderPromptLibrary();
  });
});

document.querySelectorAll('.os-tab').forEach(btn => {
  btn.addEventListener('click', () => setDialogOS(btn.dataset.os));
});

document.querySelectorAll('[data-activity]').forEach(btn => {
  btn.addEventListener('click', () => {
    activeActivity = btn.dataset.activity;
    document.querySelectorAll('[data-activity]').forEach(b => b.classList.toggle('active', b === btn));
    byId('activity-tasks-view').hidden = activeActivity !== 'tasks';
    byId('activity-task-filters').hidden = activeActivity !== 'tasks';
    byId('activity-audit-view').hidden = activeActivity !== 'audit';
    byId('activity-audit-filters').hidden = activeActivity !== 'audit';
    act(refresh);
  });
});

byId('new-device').addEventListener('click', () => openDeviceDialog({ mode: 'add' }));
byId('start-device-dialog').addEventListener('close', stopOnlineWatch);
byId('verify-device').addEventListener('click', () => openVerification(''));
byId('start-enter-code').addEventListener('click', () => { byId('start-device-dialog').close(); openVerification(''); });
byId('copy-device-sh').addEventListener('click', () => act(async () => {
  await copyElement('device-start-sh', '已复制 macOS / Linux 安装启动命令。');
  setDialogStep(2);
}));
byId('copy-device-ps').addEventListener('click', () => act(async () => {
  await copyElement('device-start-ps', '已复制 Windows PowerShell 安装启动命令。');
  setDialogStep(2);
}));

byId('pair-with-invite').addEventListener('click', () => {
  byId('start-device-dialog').close();
  byId('pair-form').hidden = false;
  byId('pair-result').hidden = true;
  byId('pair-form').reset();
  byId('pair-token').textContent = '';
  byId('pair-dialog').showModal();
});

byId('pair-form').addEventListener('submit', event => {
  event.preventDefault();
  act(async () => {
    const data = new FormData(event.target);
    const reply = await api('invites', { name: data.get('name'), capabilities: data.getAll('capabilities') });
    byId('pair-token').textContent = reply.token;
    byId('pair-expiry').textContent = '有效期至 ' + formatTime(reply.expiresAt);
    byId('pair-form').hidden = true;
    byId('pair-result').hidden = false;
  });
});

byId('pair-done').addEventListener('click', () => { byId('pair-dialog').close(); act(refresh); });
byId('pair-dialog').addEventListener('close', () => { byId('pair-token').textContent = ''; });
byId('lookup-device').addEventListener('click', () => act(lookupDeviceCode));
byId('verify-form').addEventListener('submit', event => { event.preventDefault(); act(() => submitDeviceDecision(true)); });
byId('deny-device').addEventListener('click', () => act(() => submitDeviceDecision(false)));

byId('copy-token').addEventListener('click', () => act(() => copyElement('pair-token', '已复制一次性令牌。')));
byId('copy-mcp').addEventListener('click', () => act(() => copyElement('mcp-url', '已复制 MCP Server URL。')));
byId('copy-overview-mcp').addEventListener('click', () => act(() => copyElement('overview-mcp-url', '已复制 MCP Server URL。')));
byId('copy-task-id').addEventListener('click', () => act(() => copyElement('task-id', '已复制任务 ID。')));

byId('sidebar-upgrade-btn').addEventListener('click', () => switchPanel('plan'));
byId('banner-upgrade-btn').addEventListener('click', () => switchPanel('plan'));
byId('plan-upgrade-btn').addEventListener('click', () => notice('兑换码自助升级将在 Issue #23 中上线，当前可由管理员在后台开通 Pro。'));

byId('cancel-task').addEventListener('click', () => act(async () => {
  await api('tasks/' + currentTask + '/cancel', {});
  await updateTask(currentTask);
}));

byId('revoke-oauth').addEventListener('click', () => act(async () => {
  if (!await confirmAction('撤销全部 OAuth 授权', '所有已连接的 ChatGPT 与外部 MCP 会话都需要重新进行 OAuth 授权。')) return;
  await api('oauth/revoke', {});
  notice('已撤销全部外部客户端授权。');
  await refreshOAuthClients();
}));

byId('revoke-all-devices').addEventListener('click', () => act(async () => {
  if (!await confirmAction('撤销全部设备', '所有已配对设备都需要重新配对。未完成任务将标为中断，待处理配对码和邀请也会失效。')) return;
  const { revokedDevices, invalidatedPairings } = await api('devices/revoke-all', {});
  notice(`已撤销 ${revokedDevices} 台设备，已作废 ${invalidatedPairings} 项配对记录。`);
  await refresh();
}));

byId('task-device').addEventListener('change', () => act(refreshTasks));
byId('task-status').addEventListener('change', () => act(refreshTasks));
byId('device-search').addEventListener('input', renderDevices);
byId('device-status').addEventListener('change', renderDevices);
byId('audit-search').addEventListener('input', renderAudit);
byId('refresh-now').addEventListener('click', () => act(refresh));
document.querySelectorAll('[data-close]').forEach(close => close.addEventListener('click', () => close.closest('dialog').close()));

renderPromptLibrary();

act(async () => {
  try { await showApp(await api('session')); }
  catch { showLogin(); }
});

setInterval(() => { if (csrf && !document.hidden) act(refresh); }, 5000);
