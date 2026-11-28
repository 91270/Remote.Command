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
const permissionPresets = {
  full: { label: '完全访问', capabilities: ['read', 'write', 'exec'], approvalMode: 'client' },
  safe: { label: '安全模式', capabilities: ['read', 'write', 'exec'], approvalMode: 'exec-only' },
  readonly: { label: '仅读取', capabilities: ['read'], approvalMode: 'client' }
};
function resolveDevicePreset(device) {
  const caps = Array.isArray(device.capabilities) ? device.capabilities : [];
  if (!caps.some(c => c !== 'read')) return 'readonly';
  if (device.approvalMode === 'exec-only' || device.approvalMode === 'strict') return 'safe';
  return 'full';
}
const platformNames = { darwin: 'macOS', win32: 'Windows', linux: 'Linux', android: 'Android' };
const panels = {
  devices: ['设备', '通过 Remote MCP 让 AI 客户端安全访问你的电脑。'],
  usage: ['用量', '查看当月与近 30 天调用趋势、工具排行、设备分布与软配额状态。'],
  plan: ['套餐与计费', '管理 Free（10,000 次/月）与 Pro（Unlimited）套餐权益。'],
  activity: ['任务与审计', '跟踪远程工具调用、本机审批与安全审计记录。'],
  settings: ['设置', '管理账号资料、外观主题与外部 OAuth 授权。'],
  'admin-overview': ['全站概览', '查看全站用户、在线设备、月度调用与码券发放概况。'],
  'admin-users': ['用户与套餐', '管理多租户成员状态、会话安全与 Free/Pro 套餐配额。'],
  'admin-codes': ['邀请码与兑换码', '生成与作废注册邀请码及 Pro 兑换码，查看全站核销流水。'],
  'admin-fleet': ['全站设备与审计', '跨租户设备在线监控、紧急撤销与全站操作审计检索。'],
  'admin-policy': ['系统策略', '配置注册准入策略、默认月度配额与任务正文短时保留时长。']
};

let csrf = '';
let currentSession = null;
let currentPlanQuota = null;
let devices = [];
let auditRecords = [];
let oauthClients = [];
let usageData = null;
let usageRange = '30d';
let activePanel = 'devices';
const tierLabels = {
  monthly: 'Pro 月卡（30 天）',
  quarterly: 'Pro 季卡（90 天）',
  yearly: 'Pro 年卡（365 天）',
  lifetime: 'Pro 永久卡'
};
let activeActivity = 'tasks';
let activeAdminCodes = 'invites';
let activeAdminFleet = 'devices';
let adminPlanTargetUserId = '';
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
let noticeTimer = null;
let pendingOnlineDeviceName = '';
let pendingOnlineBaselineIds = new Set();

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

function clearNoticeTimer() {
  if (noticeTimer) {
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }
}

function notice(message, failed = false, options = {}) {
  const { persist = false, autoHideMs = 5000 } = options;
  clearNoticeTimer();
  if (!persist) {
    pendingOnlineDeviceName = '';
    pendingOnlineBaselineIds.clear();
  }
  const el = byId('notice');
  el.textContent = message;
  el.className = 'notice' + (failed ? ' error' : '');
  el.hidden = false;
  if (!failed && !persist && autoHideMs > 0) {
    noticeTimer = setTimeout(() => {
      el.hidden = true;
      noticeTimer = null;
    }, autoHideMs);
  }
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

function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatPercent(val) {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  return `${val}%`;
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
  clearNoticeTimer();
  pendingOnlineDeviceName = '';
  pendingOnlineBaselineIds.clear();
  csrf = '';
  currentSession = null;
  currentPlanQuota = null;
  usageData = null;
  adminPlanTargetUserId = '';
  const invCreated = byId('admin-invite-created');
  if (invCreated) invCreated.hidden = true;
  const redCreated = byId('admin-redeem-created');
  if (redCreated) redCreated.hidden = true;
  byId('notice').hidden = true;
  byId('login-error').textContent = '';
  const boot = byId('auth-boot');
  if (boot) boot.hidden = true;
  byId('app-view').hidden = true;
  byId('login-view').hidden = false;
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  const googleBtn = byId('google-login-btn');
  const loginHint = byId('login-hint');
  if (googleBtn) {
    const returnTo = location.pathname + (location.search || '');
    googleBtn.href = '/auth/google/start?return_to=' + encodeURIComponent(returnTo);
  }
  fetch('/manage/api/auth-config', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null))
    .then(cfg => {
      if (!cfg || !loginHint) return;
      if (!cfg.initialized) {
        loginHint.textContent = '使用 Google 账号安全登录（全新部署的首个 Google 用户将自动成为管理员）。';
      } else if (cfg.registrationMode === 'closed') {
        loginHint.textContent = '使用已授权的 Google 账号登录（当前已关闭新用户注册）。';
      } else if (cfg.registrationMode === 'invite_only') {
        loginHint.textContent = '使用 Google 账号安全登录（新用户需携带管理员邀请码激活）。';
      } else {
        loginHint.textContent = '使用 Google 账号安全登录或自动注册。';
      }
    })
    .catch(() => {});
}

async function showApp(session) {
  csrf = session.csrf;
  currentSession = session;
  const boot = byId('auth-boot');
  if (boot) boot.hidden = true;
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

  updateDeviceStartCommands();
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
  if (name.startsWith('admin-') && currentSession?.role !== 'admin') return;
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
function syncSessionPlanBadges(planQuota) {
  if (!currentSession || !planQuota) return;
  currentSession.plan = planQuota.plan;
  currentSession.planExpiresAt = planQuota.planExpiresAt || null;
  byId('sidebar-role').textContent = (planQuota.plan === 'pro' ? 'Pro' : 'Free') + (currentSession.role === 'admin' ? ' · Admin' : '');
  const planDesc = planQuota.plan === 'pro'
    ? (planQuota.planExpiresAt ? `Pro（有效期至 ${formatTime(planQuota.planExpiresAt)}）` : 'Pro (Unlimited)')
    : `Free (${(planQuota.limit || FREE_QUOTA).toLocaleString()}/月)`;
  byId('settings-meta').textContent = `角色：${currentSession.role === 'admin' ? '管理员' : '普通用户'} · 当前套餐：${planDesc}`;
}

function renderQuotaAndUsage(monthlyCalls, softQuota = null, planQuota = currentPlanQuota) {
  if (planQuota) {
    currentPlanQuota = planQuota;
    syncSessionPlanBadges(planQuota);
  }
  const effectivePlan = planQuota ? planQuota.plan : currentSession?.plan;
  const isPro = effectivePlan === 'pro';
  const freeLimit = planQuota?.limit ?? FREE_QUOTA;
  const freeUsed = planQuota && !isPro ? planQuota.used : monthlyCalls;
  const { label: resetLabel, daysLeft } = nextMonthResetLabel();

  const useSoft = !!softQuota;
  const pct = useSoft
    ? softQuota.percent
    : isPro
      ? 0
      : (freeLimit > 0 ? Math.min(100, Math.round((freeUsed / freeLimit) * 100)) : 100);
  const barWidth = useSoft
    ? `${Math.min(100, softQuota.percent)}%`
    : isPro
      ? '100%'
      : `${pct}%`;
  const barClass = useSoft
    ? 'quota-fill' + (softQuota.status === 'exceeded' ? ' full' : softQuota.status === 'warning' ? ' warn' : '')
    : 'quota-fill' + (!isPro && (planQuota?.exceeded || pct >= 100) ? ' full' : !isPro && (planQuota?.warning || pct >= 80) ? ' warn' : '');

  // Sidebar quota card
  byId('sidebar-quota-pct').textContent = useSoft ? `${softQuota.percent}%` : (isPro ? 'Pro' : `${pct}%`);
  const sFill = byId('sidebar-quota-fill');
  sFill.style.width = barWidth;
  sFill.className = barClass;
  byId('sidebar-quota-text').textContent = useSoft
    ? `${softQuota.used.toLocaleString()} / ${softQuota.limit.toLocaleString()} 本月`
    : isPro
      ? `${monthlyCalls.toLocaleString()} 次 · Unlimited`
      : `${freeUsed.toLocaleString()} / ${freeLimit.toLocaleString()} 本月`;
  byId('sidebar-quota-reset').textContent = useSoft
    ? `软配额提醒（不阻断）· ${resetLabel} 重置`
    : isPro
      ? (planQuota?.planExpiresAt ? `有效期至 ${formatTime(planQuota.planExpiresAt)}` : '无限次工具调用已启用')
      : `将于 ${resetLabel} 00:00 UTC 重置`;
  byId('sidebar-upgrade-btn').hidden = isPro;

  // Global top banner
  const banner = byId('quota-banner');
  if (!isPro && (planQuota?.exceeded || (!useSoft && pct >= 100))) {
    banner.hidden = false;
    banner.className = 'quota-banner full';
    byId('quota-banner-text').textContent = `本月 Free 套餐 ${freeLimit.toLocaleString()} 次设备调用额度已用完（${freeUsed.toLocaleString()} / ${freeLimit.toLocaleString()}）。已配对设备仍保持在线，将于 ${resetLabel} 00:00 UTC 重置，或使用兑换码升级 Pro 立即恢复。`;
  } else if (useSoft && softQuota.warning) {
    banner.hidden = false;
    banner.className = 'quota-banner' + (softQuota.status === 'exceeded' ? ' full' : '');
    byId('quota-banner-text').textContent = softQuota.status === 'exceeded'
      ? `本月工具调用已达软配额 ${softQuota.percent}%（${softQuota.used.toLocaleString()} / ${softQuota.limit.toLocaleString()}，仅告警不阻断调用），将于 ${resetLabel} 重置。`
      : `本月工具调用已达软配额 80% 提醒线（${softQuota.used.toLocaleString()} / ${softQuota.limit.toLocaleString()}，${softQuota.percent}%，仅告警不阻断调用），将于 ${resetLabel} 重置。`;
  } else if (!isPro && (planQuota?.warning || pct >= 80)) {
    banner.hidden = false;
    banner.className = 'quota-banner';
    byId('quota-banner-text').textContent = `本月 Free 套餐调用额度已使用 ${pct}%（${freeUsed.toLocaleString()} / ${freeLimit.toLocaleString()}），将于 ${resetLabel} 00:00 UTC 重置。`;
  } else {
    banner.hidden = true;
  }

  // Usage primary KPI card
  byId('usage-month-value').textContent = useSoft
    ? `${softQuota.used.toLocaleString()} / ${softQuota.limit.toLocaleString()}`
    : isPro
      ? `${monthlyCalls.toLocaleString()} · Unlimited`
      : `${freeUsed.toLocaleString()} / ${freeLimit.toLocaleString()}`;
  const uFill = byId('usage-quota-fill');
  uFill.style.width = barWidth;
  uFill.className = barClass;
  byId('usage-month-sub').textContent = useSoft
    ? `软配额 ${softQuota.percent}%（不阻断调用）· ${resetLabel} 重置`
    : isPro
      ? '当前为 Pro 套餐，不限制月度调用次数'
      : `已使用 ${pct}% · ${resetLabel} 重置（剩余 ${daysLeft} 天）`;

  if (!usageData) {
    const dayOfMonth = Math.max(1, new Date().getUTCDate());
    byId('usage-daily-avg-sub').textContent = `本月日均 ${Math.round(monthlyCalls / dayOfMonth).toLocaleString()} 次/天`;
    renderUsageChart([]);
  }

  // Plan cards active state
  byId('plan-card-free').classList.toggle('active-plan', !isPro);
  byId('plan-card-pro').classList.toggle('active-plan', isPro);
  byId('badge-plan-free').hidden = isPro;
  byId('badge-plan-pro').hidden = !isPro;

  const freeUsageEl = byId('plan-free-usage');
  if (freeUsageEl) {
    freeUsageEl.textContent = !isPro
      ? `当月有效设备调用：${freeUsed.toLocaleString()} / ${freeLimit.toLocaleString()} 次（${pct}%）`
      : `包含每月 ${freeLimit.toLocaleString()} 次有效设备调用`;
  }
  const proExpiryEl = byId('plan-pro-expiry');
  if (proExpiryEl) {
    if (isPro) {
      proExpiryEl.hidden = false;
      proExpiryEl.textContent = planQuota?.planExpiresAt
        ? `当前有效期至 ${formatTime(planQuota.planExpiresAt)}`
        : '当前为永久 Pro，不限时长与调用次数';
    } else {
      proExpiryEl.hidden = true;
      proExpiryEl.textContent = '';
    }
  }
  const planBtn = byId('plan-upgrade-btn');
  if (planBtn) {
    planBtn.textContent = isPro ? '继续兑换延长 Pro 有效期' : '输入兑换码激活 Pro';
  }
}

function renderRedemptions(items) {
  const wrap = byId('redeem-history-wrap');
  const container = byId('redeem-history');
  if (!wrap || !container) return;
  container.replaceChildren();
  if (!items || !items.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  for (const item of items) {
    const row = node('div', 'device-row');
    const main = node('div', 'device-main');
    const info = node('div', 'device-info');
    const title = node('div', 'device-name');
    title.append(
      node('code', '', `${item.codePrefix}***`),
      node('span', 'pill online', tierLabels[item.tier] || item.tier)
    );
    info.appendChild(title);
    const expiryLabel = item.newExpiresAt ? `有效期至 ${formatTime(item.newExpiresAt)}` : '永久有效';
    info.appendChild(node('div', 'device-meta', `核销于 ${formatTime(item.redeemedAt)} · ${expiryLabel}`));
    main.appendChild(info);
    row.appendChild(main);
    container.appendChild(row);
  }
}

async function refreshPlan() {
  const res = await api('plan');
  if (res.planQuota) {
    renderQuotaAndUsage(res.planQuota.used ?? 0, null, res.planQuota);
  }
  renderRedemptions(res.redemptions || []);
}

function renderUsageChart(points) {
  const wrap = byId('usage-chart');
  if (!wrap) return;
  wrap.replaceChildren();

  let items = Array.isArray(points) ? points : [];
  if (!items.length) {
    const now = new Date();
    items = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      items.push({ label: `${d.getUTCMonth() + 1}月`, calls: 0, succeeded: 0, failed: 0 });
    }
  }

  const maxVal = Math.max(10, ...items.map(m => Number(m.calls ?? m.value ?? 0)));
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'usage-svg');
  svg.setAttribute('viewBox', '0 0 680 210');

  const padL = 44, padB = 28, padT = 16, padR = 16;
  const chartH = 210 - padT - padB;
  const chartW = 680 - padL - padR;

  for (let i = 0; i <= 2; i++) {
    const y = padT + (chartH / 2) * i;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(padL));
    line.setAttribute('x2', String(680 - padR));
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

  const slotW = chartW / items.length;
  const barW = Math.max(6, Math.min(46, slotW * 0.54));
  const showEvery = items.length > 14 ? 5 : 1;

  items.forEach((m, idx) => {
    const count = Number(m.calls ?? m.value ?? 0);
    const h = count > 0 ? Math.max(5, (count / maxVal) * chartH) : 2;
    const x = padL + idx * slotW + (slotW - barW) / 2;
    const y = padT + chartH - h;
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('class', 'bar' + (count === 0 ? ' zero' : ''));
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(barW));
    rect.setAttribute('height', String(h));

    const title = document.createElementNS(ns, 'title');
    const periodLabel = m.date || m.month || m.label;
    title.textContent = `${periodLabel}: ${count} 次调用（成功 ${m.succeeded ?? 0} / 失败 ${m.failed ?? 0}）`;
    rect.appendChild(title);
    svg.appendChild(rect);

    if (idx % showEvery === 0 || idx === items.length - 1) {
      const xText = document.createElementNS(ns, 'text');
      xText.setAttribute('x', String(x + barW / 2));
      xText.setAttribute('y', String(210 - 8));
      xText.setAttribute('text-anchor', 'middle');
      xText.textContent = m.label;
      svg.appendChild(xText);
    }
  });

  wrap.appendChild(svg);
}

function renderUsageRankList(containerId, items, emptyText, renderRow) {
  const container = byId(containerId);
  if (!container) return;
  container.replaceChildren();
  if (!items || !items.length) {
    container.appendChild(node('div', 'empty-state', emptyText));
    return;
  }
  const maxCalls = Math.max(1, ...items.map(i => Number(i.calls || 0)));
  for (const item of items) {
    container.appendChild(renderRow(item, maxCalls));
  }
}

function renderUsagePanel(data) {
  if (!data || !data.summary) return;
  const s = data.summary;
  renderQuotaAndUsage(s.monthCalls ?? 0, data.softQuota ?? null);

  byId('usage-30d-value').textContent = Number(s.last30dCalls ?? 0).toLocaleString();
  byId('usage-daily-avg-sub').textContent = `本月日均 ${Number(s.dailyAverageMonth ?? 0).toLocaleString()} 次/天`;
  byId('usage-success-rate').textContent = formatPercent(s.successRate30d);
  byId('usage-success-sub').textContent = s.terminalCalls30d > 0
    ? `成功 ${s.succeededCalls30d.toLocaleString()} / 已结束 ${s.terminalCalls30d.toLocaleString()}`
    : '暂无已结束调用';
  byId('usage-avg-duration').textContent = formatDuration(s.avgDurationMs30d);
  byId('usage-duration-sub').textContent = s.activeTasks > 0
    ? `当前 ${s.activeTasks} 个进行中任务 · 仅统计元数据`
    : '仅统计脱敏元数据';

  const subtitle = byId('usage-trend-subtitle');
  if (usageRange === '6m') {
    if (subtitle) subtitle.textContent = '近 6 个月按月统计（不含敏感参数与结果正文）';
    renderUsageChart(data.monthlyTrend || []);
  } else {
    if (subtitle) subtitle.textContent = '近 30 天按日统计（不含敏感参数与结果正文）';
    renderUsageChart(data.dailyTrend || []);
  }

  renderUsageRankList('usage-top-tools', data.topTools || [], '近 30 天暂无工具调用记录。', (item, maxCalls) => {
    const row = node('div', 'usage-rank-item');
    const head = node('div', 'usage-rank-head');
    const nameWrap = node('div', 'usage-rank-name');
    nameWrap.appendChild(node('code', '', item.toolName));
    head.append(nameWrap, node('span', 'usage-rank-count tabular', `${item.calls.toLocaleString()} 次`));

    const bar = node('div', 'usage-rank-bar');
    const fill = node('div', 'usage-rank-fill');
    fill.style.width = `${Math.max(4, Math.round((item.calls / maxCalls) * 100))}%`;
    bar.appendChild(fill);

    const meta = node(
      'div',
      'usage-rank-meta',
      `成功率 ${formatPercent(item.successRate)} · 平均耗时 ${formatDuration(item.avgDurationMs)}`
    );
    row.append(head, bar, meta);
    return row;
  });

  renderUsageRankList('usage-devices', data.deviceDistribution || [], '近 30 天暂无设备调用记录。', (item, maxCalls) => {
    const row = node('div', 'usage-rank-item');
    const head = node('div', 'usage-rank-head');
    const nameWrap = node('div', 'usage-rank-name');
    const label = item.deviceName || `已移除设备 (${String(item.deviceId || '').slice(0, 8)})`;
    nameWrap.appendChild(node('strong', '', label));
    if (item.deleted) nameWrap.appendChild(node('span', 'pill', '已删除'));
    else if (item.revoked) nameWrap.appendChild(node('span', 'pill revoked', '已撤销'));
    head.append(nameWrap, node('span', 'usage-rank-count tabular', `${item.calls.toLocaleString()} 次 · ${item.sharePercent}%`));

    const bar = node('div', 'usage-rank-bar');
    const fill = node('div', 'usage-rank-fill');
    fill.style.width = `${Math.max(4, Math.round((item.calls / maxCalls) * 100))}%`;
    bar.appendChild(fill);

    const meta = node(
      'div',
      'usage-rank-meta',
      `成功率 ${formatPercent(item.successRate)} · 平均耗时 ${formatDuration(item.avgDurationMs)}`
    );
    row.append(head, bar, meta);
    return row;
  });
}

async function refreshUsage() {
  usageData = await api('usage');
  renderUsagePanel(usageData);
}

// --- Devices Rendering ---
function renderDevices() {
  const container = byId('devices');
  container.replaceChildren();
  const activeCount = devices.filter(d => !d.revoked).length;
  const onlineCount = devices.filter(d => d.online).length;
  const revokedCount = devices.filter(d => d.revoked).length;
  const clearRevokedBtn = byId('clear-revoked-devices');
  if (clearRevokedBtn) clearRevokedBtn.hidden = revokedCount === 0;
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

    const presetKey = resolveDevicePreset(device);
    const seenText = device.online ? '当前在线' : `最后在线 ${relativeTime(device.lastSeen)}`;
    info.appendChild(node('div', 'device-meta', `${seenText} · 权限模式：${permissionPresets[presetKey].label}`));
    main.appendChild(info);

    const actions = node('div', 'device-actions');
    if (!device.revoked) {
      const modeSelect = document.createElement('select');
      modeSelect.className = 'approval-select';
      modeSelect.setAttribute('aria-label', `${device.name} 权限模式`);
      for (const [val, item] of Object.entries(permissionPresets)) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = item.label;
        modeSelect.appendChild(opt);
      }
      modeSelect.value = presetKey;
      modeSelect.addEventListener('change', async () => {
        const nextKey = modeSelect.value;
        const preset = permissionPresets[nextKey] || permissionPresets.full;
        try {
          await api(`devices/${device.id}/policy`, {
            capabilities: preset.capabilities,
            approvalMode: preset.approvalMode
          });
          notice(`已将「${device.name}」权限模式切换为「${preset.label}」（即时生效）。`);
          await refresh();
        } catch (err) {
          modeSelect.value = presetKey;
          notice(err.message, true);
        }
      });
      actions.appendChild(modeSelect);
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
    } else {
      actions.appendChild(button('删除记录', 'secondary', async () => {
        if (!await confirmAction('删除已撤销设备', `确认彻底移除「${device.name}」的已撤销设备记录？保留的历史任务与审计日志不受影响。`)) return;
        await api(`devices/${device.id}/delete`, {});
        notice(`已移除设备记录「${device.name}」。`);
        await refresh();
      }));
    }
    row.append(main, actions);
    container.appendChild(row);
  }
}

// --- 3-Step Add Device & 2-Step Reconnect Dialog (with Auto Online Detection) ---
function updateDeviceStartCommands() {
  const gateway = currentSession?.origin || location.origin;
  const installService = Boolean(byId('device-install-service')?.checked);
  const cmdDownload = byId('download-device-cmd');
  if (cmdDownload) {
    cmdDownload.setAttribute('href', gateway + '/install/remote-windows.cmd' + (installService ? '?service=1' : ''));
  }
  byId('device-start-ps').textContent = installService
    ? "irm '" + gateway + "/install.ps1?service=1' | iex"
    : 'irm ' + gateway + '/install.ps1 | iex';
  byId('device-start-sh').textContent = installService
    ? 'curl -fsSL ' + gateway + '/install.sh | bash -s -- --install-service'
    : 'curl -fsSL ' + gateway + '/install.sh | bash';
  const hint = byId('step-2-hint');
  if (hint) {
    hint.textContent = installService
      ? '已复制！请在目标电脑终端（或 PowerShell）粘贴回车并完成浏览器配对，随后将自动注册并启动后台常驻服务。'
      : '已复制！请打开目标电脑的终端（或 PowerShell），粘贴并按回车运行，保持窗口开启。';
  }
}

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
  updateDeviceStartCommands();
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
      node('td', 'task-tool', t.toolName || t.operation),
      node('td', 'task-device', devName),
      (() => { const td = node('td', 'task-status'); td.appendChild(statePill(t.status)); return td; })(),
      node('td', 'tabular task-time', formatTime(t.createdAt)),
      (() => { const td = node('td', 'task-action'); td.appendChild(button('查看', 'text-button', () => openTask(t.id))); return td; })()
    );
    tbody.appendChild(tr);
  }
}

function formatAuditDetails(details) {
  if (details === null || details === undefined) return '—';
  if (typeof details !== 'object') return String(details);
  if (Array.isArray(details)) return JSON.stringify(details);
  const entries = Object.entries(details);
  if (!entries.length) return '{}';
  return entries
    .map(([key, val]) => `${key}: ${typeof val === 'string' ? val : JSON.stringify(val)}`)
    .join(' · ');
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
    const eventTd = node('td', 'audit-event');
    eventTd.appendChild(node('code', '', r.event));
    const detailsTd = node('td', 'audit-details-cell');
    detailsTd.appendChild(node('code', 'audit-details', formatAuditDetails(r.details)));
    tr.append(
      node('td', 'tabular audit-time', formatTime(r.at)),
      eventTd,
      detailsTd
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
  const purgedNotice = byId('task-purged-notice');
  if (purgedNotice) {
    purgedNotice.hidden = !t.payloadPurged;
    if (t.payloadPurged) {
      purgedNotice.textContent = t.payloadPurgedAt
        ? `该任务的正文（参数与输出）已按隐私短时保留策略于 ${formatTime(t.payloadPurgedAt)} 自动清理，当前仅保留脱敏元数据。`
        : '该任务的正文（参数与输出）已按隐私短时保留策略自动清理，当前仅保留脱敏元数据。';
    }
  }
  byId('task-output').textContent = t.payloadPurged
    ? '（正文已按隐私保留策略清理，仅保留任务元数据）'
    : (t.output || (t.result ? JSON.stringify(t.result, null, 2) : '（暂无输出）'));
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
function getCodeSlots() {
  return Array.from(document.querySelectorAll('#verify-code-slots .code-slot'));
}

function normalizeUserCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}

function syncCodeValue() {
  const raw = getCodeSlots().map(slot => normalizeUserCode(slot.value)).join('');
  const formatted = raw.length > 5 ? raw.slice(0, 5) + '-' + raw.slice(5) : raw;
  byId('verify-code').value = formatted;
  return { raw, formatted };
}

function fillCodeSlots(value) {
  const chars = normalizeUserCode(value).split('');
  const slots = getCodeSlots();
  slots.forEach((slot, idx) => {
    slot.value = chars[idx] || '';
    slot.classList.toggle('filled', !!slot.value);
  });
  return syncCodeValue();
}

function resetVerificationPreview() {
  verifiedCode = '';
  byId('verify-details').hidden = true;
  byId('verify-actions').hidden = true;
}

function openVerification(prefill = '') {
  resetVerificationPreview();
  byId('verify-form').reset();
  const { raw } = fillCodeSlots(prefill);
  byId('verify-error').textContent = '';
  byId('verify-dialog').showModal();
  if (raw.length === 10) {
    act(lookupDeviceCode);
  } else {
    const slots = getCodeSlots();
    if (slots[0]) slots[0].focus();
  }
}

async function lookupDeviceCode() {
  const { raw, formatted } = syncCodeValue();
  if (!raw) return;
  if (raw.length < 10) {
    resetVerificationPreview();
    byId('verify-error').textContent = '请输入完整的 10 位配对码。';
    return;
  }
  byId('verify-error').textContent = '';
  try {
    const info = await api('device-preview', { user_code: formatted });
    verifiedCode = formatted;
    byId('verify-host').textContent = info.deviceName;
    byId('verify-expiry').textContent = '有效期至 ' + formatTime(info.expiresAt);
    byId('verify-details').hidden = false;
    byId('verify-actions').hidden = false;
  } catch (err) {
    resetVerificationPreview();
    byId('verify-error').textContent = err.message;
  }
}

async function submitDeviceDecision(approve) {
  if (!verifiedCode) return;
  const data = new FormData(byId('verify-form'));
  const presetKey = (data.get('permissionPreset') || 'full').toString();
  const preset = permissionPresets[presetKey] || permissionPresets.full;
  const res = await api('device-verify', {
    user_code: verifiedCode,
    capabilities: preset.capabilities,
    approve,
    approvalMode: preset.approvalMode
  });
  byId('verify-dialog').close();
  if (approve) {
    pendingOnlineDeviceName = res.deviceName || '';
    pendingOnlineBaselineIds = new Set(devices.filter(d => !d.revoked && d.online).map(d => d.id));
    notice(`已授权设备「${res.deviceName}」，等待设备完成上线。`, false, { persist: true });
  } else {
    notice(`已拒绝设备「${res.deviceName}」的配对请求。`);
  }
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

// --- Admin Console Rendering & Actions ---
async function refreshAdminOverview() {
  const ov = await api('admin/overview');
  byId('admin-kpi-users').textContent = Number(ov.users.total || 0).toLocaleString();
  byId('admin-kpi-users-sub').textContent = `Pro ${ov.users.pro} · Free ${ov.users.free} · 禁用 ${ov.users.disabled}`;
  byId('admin-kpi-devices').textContent = Number(ov.devices.online || 0).toLocaleString();
  byId('admin-kpi-devices-sub').textContent = `已配对 ${ov.devices.total} 台（离线 ${ov.devices.offline} · 已撤销 ${ov.devices.revoked}）`;
  byId('admin-kpi-calls').textContent = Number(ov.usage.monthCalls || 0).toLocaleString();
  byId('admin-kpi-calls-sub').textContent = `有效计费 ${Number(ov.usage.monthBillableCalls || 0).toLocaleString()} · 进行中 ${ov.usage.activeTasks || 0}`;
  const totalActiveCodes = (ov.codes.activeInvites || 0) + (ov.codes.activeRedeemCodes || 0);
  byId('admin-kpi-codes').textContent = totalActiveCodes.toLocaleString();
  byId('admin-kpi-codes-sub').textContent = `邀请码 ${ov.codes.activeInvites} · 兑换码 ${ov.codes.activeRedeemCodes} · 已核销 ${ov.codes.totalRedemptions}`;
}

function openAdminPlanModal(user) {
  adminPlanTargetUserId = user.id;
  byId('admin-plan-user-label').textContent = `目标账号：${user.email || user.displayName || user.id}`;
  const planSel = byId('admin-plan-select');
  planSel.value = user.plan === 'pro' ? 'pro' : 'free';
  byId('admin-plan-duration').value = '30';
  byId('admin-plan-duration-wrap').hidden = planSel.value !== 'pro';
  byId('admin-plan-custom-quota').value = user.customMonthlyQuota ? String(user.customMonthlyQuota) : '';
  byId('admin-plan-dialog').showModal();
}

async function refreshAdminUsers() {
  const qs = new URLSearchParams();
  const q = byId('admin-user-search').value.trim();
  const plan = byId('admin-user-plan').value;
  const status = byId('admin-user-status').value;
  if (q) qs.set('q', q);
  if (plan) qs.set('plan', plan);
  if (status) qs.set('status', status);
  const { users } = await api('admin/users' + (qs.size ? '?' + qs.toString() : ''));
  const container = byId('admin-users-list');
  container.replaceChildren();
  if (!users.length) {
    container.appendChild(node('div', 'empty-state', '没有匹配的用户账号。'));
    return;
  }
  for (const u of users) {
    const row = node('div', 'device-row');
    const main = node('div', 'device-main');
    main.appendChild(node('span', 'status-dot' + (u.status === 'active' ? ' online' : '')));
    const info = node('div', 'device-info');
    const title = node('div', 'device-name');
    title.appendChild(node('span', '', u.email || u.displayName || u.id));
    title.appendChild(node('span', 'pill' + (u.role === 'admin' ? ' online' : ''), u.role === 'admin' ? '管理员' : '用户'));
    title.appendChild(node('span', 'pill' + (u.plan === 'pro' ? ' online' : ''), u.plan === 'pro' ? 'Pro' : 'Free'));
    if (u.status === 'disabled') title.appendChild(node('span', 'pill revoked', '已禁用'));
    info.appendChild(title);

    const quotaDesc = u.plan === 'pro'
      ? (u.planExpiresAt ? `到期 ${formatTime(u.planExpiresAt)}` : '永久 Pro')
      : `本月 ${u.billableMonthlyCalls.toLocaleString()} / ${(u.effectiveQuota || FREE_QUOTA).toLocaleString()}${u.customMonthlyQuota ? '（自定义配额）' : ''}`;
    info.appendChild(node('div', 'device-meta', `${quotaDesc} · 设备 ${u.onlineDeviceCount}/${u.deviceCount} · 最近登录 ${u.lastLoginAt ? relativeTime(u.lastLoginAt) : '从未'}`));
    main.appendChild(info);

    const actions = node('div', 'device-actions admin-actions');
    actions.appendChild(button('套餐/配额', 'secondary', () => openAdminPlanModal(u)));
    actions.appendChild(button('踢下线', 'secondary', async () => {
      if (!await confirmAction('强制踢下线', `确认吊销「${u.email || u.id}」的所有控制台与 OAuth 会话？`)) return;
      const res = await api(`admin/users/${u.id}/force-logout`, {});
      notice(`已吊销该用户 ${res.revokedSessions} 个活跃会话。`);
      await refreshAdminUsers();
    }));
    if (u.id !== currentSession?.userId) {
      const nextStatus = u.status === 'active' ? 'disabled' : 'active';
      actions.appendChild(button(u.status === 'active' ? '禁用' : '启用', u.status === 'active' ? 'danger' : 'primary', async () => {
        if (!await confirmAction(
          u.status === 'active' ? '禁用用户账号' : '启用用户账号',
          u.status === 'active'
            ? `禁用后「${u.email || u.id}」将无法登录且现有会话立即失效。`
            : `恢复「${u.email || u.id}」的正常登录权限。`
        )) return;
        await api(`admin/users/${u.id}/status`, { status: nextStatus });
        notice(`已${nextStatus === 'disabled' ? '禁用' : '启用'}账号「${u.email || u.id}」。`);
        await refreshAdminUsers();
      }));
    }
    row.append(main, actions);
    container.appendChild(row);
  }
}

async function refreshAdminCodes() {
  if (activeAdminCodes === 'invites') {
    const { invites } = await api('admin/invites');
    const list = byId('admin-invites-list');
    list.replaceChildren();
    if (!invites.length) {
      list.appendChild(node('div', 'empty-state', '暂无注册邀请码。'));
      return;
    }
    for (const inv of invites) {
      const row = node('div', 'device-row');
      const main = node('div', 'device-main');
      const info = node('div', 'device-info');
      const title = node('div', 'device-name');
      title.append(
        node('code', '', `${inv.prefix}***`),
        node('span', 'pill' + (inv.active ? ' online' : inv.revoked ? ' revoked' : ''), inv.revoked ? '已作废' : inv.active ? '有效' : '已用完/过期')
      );
      if (inv.note) title.appendChild(node('span', 'pill', inv.note));
      info.appendChild(title);
      info.appendChild(node('div', 'device-meta', `已用 ${inv.usedCount}/${inv.maxUses} · ${inv.expiresAt ? '到期 ' + formatTime(inv.expiresAt) : '永久有效'} · 创建人 ${inv.createdByEmail || '系统'}`));
      main.appendChild(info);
      const actions = node('div', 'device-actions');
      if (!inv.revoked) {
        actions.appendChild(button('作废', 'danger', async () => {
          await api(`admin/invites/${inv.codeHash}/revoke`, {});
          notice(`已作废邀请码 ${inv.prefix}***。`);
          await refreshAdminCodes();
        }));
      }
      row.append(main, actions);
      list.appendChild(row);
    }
    return;
  }

  const { codes, redemptions } = await api('admin/redeem-codes');
  const codeList = byId('admin-redeem-codes-list');
  codeList.replaceChildren();
  if (!codes.length) {
    codeList.appendChild(node('div', 'empty-state', '暂无 Pro 兑换码。'));
  } else {
    for (const c of codes) {
      const row = node('div', 'device-row');
      const main = node('div', 'device-main');
      const info = node('div', 'device-info');
      const title = node('div', 'device-name');
      title.append(
        node('code', '', `${c.prefix}***`),
        node('span', 'pill', tierLabels[c.tier] || c.tier),
        node('span', 'pill' + (c.active ? ' online' : c.revoked ? ' revoked' : ''), c.revoked ? '已作废' : c.active ? '有效' : '已用完/过期')
      );
      if (c.note) title.appendChild(node('span', 'pill', c.note));
      info.appendChild(title);
      info.appendChild(node('div', 'device-meta', `已用 ${c.usedCount}/${c.maxUses} · ${c.expiresAt ? '到期 ' + formatTime(c.expiresAt) : '码本身永久有效'} · 创建人 ${c.createdByEmail || '系统'}`));
      main.appendChild(info);
      const actions = node('div', 'device-actions');
      if (!c.revoked) {
        actions.appendChild(button('作废', 'danger', async () => {
          await api(`admin/redeem-codes/${c.codeHash}/revoke`, {});
          notice(`已作废兑换码 ${c.prefix}***。`);
          await refreshAdminCodes();
        }));
      }
      row.append(main, actions);
      codeList.appendChild(row);
    }
  }

  const redList = byId('admin-redemptions-list');
  redList.replaceChildren();
  if (!redemptions.length) {
    redList.appendChild(node('div', 'empty-state', '暂无核销记录。'));
  } else {
    for (const r of redemptions) {
      const row = node('div', 'device-row');
      const main = node('div', 'device-main');
      const info = node('div', 'device-info');
      const title = node('div', 'device-name');
      title.append(
        node('code', '', `${r.codePrefix}***`),
        node('span', 'pill online', tierLabels[r.tier] || r.tier),
        node('span', '', r.userEmail || r.userId)
      );
      info.appendChild(title);
      info.appendChild(node('div', 'device-meta', `核销于 ${formatTime(r.redeemedAt)} · ${r.newExpiresAt ? '新到期 ' + formatTime(r.newExpiresAt) : '永久 Pro'}`));
      main.appendChild(info);
      row.appendChild(main);
      redList.appendChild(row);
    }
  }
}

async function refreshAdminFleet() {
  if (activeAdminFleet === 'devices') {
    const qs = new URLSearchParams();
    const q = byId('admin-device-search').value.trim();
    const status = byId('admin-device-status').value;
    if (q) qs.set('q', q);
    if (status) qs.set('status', status);
    const { devices: fleet } = await api('admin/devices' + (qs.size ? '?' + qs.toString() : ''));
    const container = byId('admin-devices-list');
    container.replaceChildren();
    if (!fleet.length) {
      container.appendChild(node('div', 'empty-state', '没有匹配的设备。'));
      return;
    }
    for (const d of fleet) {
      const row = node('div', 'device-row');
      const main = node('div', 'device-main');
      main.appendChild(node('span', 'status-dot' + (d.online ? ' online' : '')));
      const info = node('div', 'device-info');
      const title = node('div', 'device-name');
      title.appendChild(node('span', '', d.name));
      if (d.platform) title.appendChild(node('span', 'pill', platformNames[d.platform] || d.platform));
      title.appendChild(node('span', 'pill ' + (d.revoked ? 'revoked' : d.online ? 'online' : ''), d.revoked ? '已撤销' : d.online ? 'Online' : 'Offline'));
      info.appendChild(title);
      info.appendChild(node('div', 'device-meta', `归属：${d.ownerEmail || d.userId || '未知'} · ID: ${d.id.slice(0, 8)} · ${d.online ? '当前在线' : '最后在线 ' + relativeTime(d.lastSeen)}`));
      main.appendChild(info);
      const actions = node('div', 'device-actions');
      if (!d.revoked) {
        actions.appendChild(button('紧急撤销', 'danger', async () => {
          if (!await confirmAction('紧急撤销设备', `确认跨租户紧急撤销「${d.ownerEmail || '未知用户'}」的设备「${d.name}」？`)) return;
          await api(`admin/devices/${d.id}/revoke`, {});
          notice(`已紧急撤销设备「${d.name}」。`);
          await refreshAdminFleet();
        }));
      }
      row.append(main, actions);
      container.appendChild(row);
    }
    return;
  }

  const q = byId('admin-audit-search').value.trim();
  const qs = q ? '?q=' + encodeURIComponent(q) : '';
  const { records } = await api('admin/audit' + qs);
  const tbody = byId('admin-audit-tbody');
  tbody.replaceChildren();
  if (!records.length) {
    const tr = document.createElement('tr');
    const td = node('td', 'subtle', '暂无审计记录。');
    td.colSpan = 3;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const r of records) {
    const tr = document.createElement('tr');
    const eventTd = node('td', 'audit-event');
    eventTd.appendChild(node('code', '', r.event));
    const detailsObj = r.userEmail ? { actor: r.userEmail, ...r.details } : r.details;
    const detailsTd = node('td', 'audit-details-cell');
    detailsTd.appendChild(node('code', 'audit-details', formatAuditDetails(detailsObj)));
    tr.append(node('td', 'tabular audit-time', formatTime(r.at)), eventTd, detailsTd);
    tbody.appendChild(tr);
  }
}

async function refreshAdminPolicy() {
  const s = await api('admin/settings');
  byId('policy-reg-mode').value = s.registrationMode;
  byId('policy-free-quota').value = String(s.freeMonthlyQuota);
  byId('policy-result-ttl').value = String(s.resultTtlMinutes);
}

// --- Main Refresh ---
async function refresh() {
  if (!csrf || refreshing) return;
  refreshing = true;
  try {
    const overview = await api('overview');
    devices = overview.devices;
    renderDevices();
    if (pendingOnlineDeviceName) {
      const onlineDevice = devices.find(
        d => !d.revoked && d.online && d.name === pendingOnlineDeviceName && !pendingOnlineBaselineIds.has(d.id)
      );
      if (onlineDevice) {
        const onlineName = onlineDevice.name;
        pendingOnlineDeviceName = '';
        pendingOnlineBaselineIds.clear();
        notice(`设备「${onlineName}」已成功上线！`, false, { autoHideMs: 4000 });
      }
    }
    renderQuotaAndUsage(overview.monthlyCalls ?? overview.totalCalls ?? 0, overview.softQuota ?? null, overview.planQuota ?? null);
    byId('last-refresh').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    if (activePanel === 'usage') {
      await refreshUsage();
    } else if (activePanel === 'plan') {
      await refreshPlan();
    } else if (activePanel === 'activity') {
      if (activeActivity === 'tasks') await refreshTasks();
      else {
        const res = await api('audit');
        auditRecords = res.records;
        renderAudit();
      }
    } else if (activePanel === 'settings') {
      await refreshOAuthClients();
    } else if (activePanel === 'admin-overview' && currentSession?.role === 'admin') {
      await refreshAdminOverview();
    } else if (activePanel === 'admin-users' && currentSession?.role === 'admin') {
      await refreshAdminUsers();
    } else if (activePanel === 'admin-codes' && currentSession?.role === 'admin') {
      await refreshAdminCodes();
    } else if (activePanel === 'admin-fleet' && currentSession?.role === 'admin') {
      await refreshAdminFleet();
    } else if (activePanel === 'admin-policy' && currentSession?.role === 'admin') {
      await refreshAdminPolicy();
    }
  } finally {
    refreshing = false;
  }
}

// --- Event Bindings ---
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

document.querySelectorAll('.usage-range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    usageRange = btn.dataset.usageRange === '6m' ? '6m' : '30d';
    document.querySelectorAll('.usage-range-btn').forEach(tab => {
      const selected = tab === btn;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    if (usageData) renderUsagePanel(usageData);
    else act(refreshUsage);
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
byId('device-install-service')?.addEventListener('change', updateDeviceStartCommands);
byId('download-device-cmd')?.addEventListener('click', () => {
  notice('已开始下载 remote-windows.cmd，双击运行即可自动安装并连接。');
  setDialogStep(2);
});
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
    const presetKey = (data.get('permissionPreset') || 'full').toString();
    const preset = permissionPresets[presetKey] || permissionPresets.full;
    const reply = await api('invites', {
      name: data.get('name'),
      capabilities: preset.capabilities,
      approvalMode: preset.approvalMode
    });
    byId('pair-token').textContent = reply.token;
    byId('pair-expiry').textContent = '有效期至 ' + formatTime(reply.expiresAt);
    byId('pair-form').hidden = true;
    byId('pair-result').hidden = false;
  });
});

byId('pair-done').addEventListener('click', () => { byId('pair-dialog').close(); act(refresh); });
byId('pair-dialog').addEventListener('close', () => { byId('pair-token').textContent = ''; });
byId('lookup-device').addEventListener('click', () => act(lookupDeviceCode));
getCodeSlots().forEach((slot, idx, slots) => {
  slot.addEventListener('focus', () => slot.select());
  slot.addEventListener('input', () => {
    const cleaned = normalizeUserCode(slot.value);
    if (cleaned.length > 1) {
      const merged = slots.map((s, i) => (i === idx ? cleaned : normalizeUserCode(s.value))).join('');
      const { raw } = fillCodeSlots(merged);
      const nextIdx = Math.min(idx + cleaned.length, slots.length - 1);
      slots[nextIdx].focus();
      if (raw.length === 10) act(lookupDeviceCode);
      else resetVerificationPreview();
      return;
    }
    slot.value = cleaned;
    slot.classList.toggle('filled', !!cleaned);
    byId('verify-error').textContent = '';
    const { raw } = syncCodeValue();
    if (cleaned && idx < slots.length - 1) {
      slots[idx + 1].focus();
    }
    if (raw.length === 10) act(lookupDeviceCode);
    else resetVerificationPreview();
  });
  slot.addEventListener('keydown', event => {
    if (event.key === 'Backspace' && !slot.value && idx > 0) {
      event.preventDefault();
      slots[idx - 1].value = '';
      slots[idx - 1].classList.remove('filled');
      slots[idx - 1].focus();
      syncCodeValue();
      resetVerificationPreview();
    } else if (event.key === 'ArrowLeft' && idx > 0) {
      event.preventDefault();
      slots[idx - 1].focus();
    } else if (event.key === 'ArrowRight' && idx < slots.length - 1) {
      event.preventDefault();
      slots[idx + 1].focus();
    }
  });
  slot.addEventListener('paste', event => {
    const pasted = (event.clipboardData || window.clipboardData)?.getData('text') || '';
    const cleaned = normalizeUserCode(pasted);
    if (!cleaned) return;
    event.preventDefault();
    const { raw } = fillCodeSlots(cleaned);
    const focusIdx = Math.min(raw.length, slots.length - 1);
    slots[focusIdx].focus();
    if (raw.length === 10) act(lookupDeviceCode);
    else resetVerificationPreview();
  });
});
byId('verify-form').addEventListener('submit', event => { event.preventDefault(); act(() => submitDeviceDecision(true)); });
byId('deny-device').addEventListener('click', () => act(() => submitDeviceDecision(false)));

byId('copy-token').addEventListener('click', () => act(() => copyElement('pair-token', '已复制一次性令牌。')));
byId('copy-mcp').addEventListener('click', () => act(() => copyElement('mcp-url', '已复制 MCP Server URL。')));
byId('copy-overview-mcp').addEventListener('click', () => act(() => copyElement('overview-mcp-url', '已复制 MCP Server URL。')));
byId('copy-task-id').addEventListener('click', () => act(() => copyElement('task-id', '已复制任务 ID。')));

byId('sidebar-upgrade-btn').addEventListener('click', () => { switchPanel('plan'); act(refresh); });
byId('banner-upgrade-btn').addEventListener('click', () => { switchPanel('plan'); act(refresh); });
byId('plan-upgrade-btn').addEventListener('click', () => {
  const input = byId('redeem-code-input');
  if (input) {
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.focus();
  }
});
byId('redeem-form').addEventListener('submit', event => {
  event.preventDefault();
  const feedback = byId('redeem-feedback');
  const input = byId('redeem-code-input');
  const submitBtn = byId('redeem-submit-btn');
  const code = (input?.value || '').trim();
  if (!code) return;
  act(async () => {
    submitBtn.disabled = true;
    feedback.className = 'subtle';
    feedback.textContent = '正在核销兑换码…';
    try {
      const res = await api('plan/redeem', { code });
      if (input) input.value = '';
      if (res.planQuota) renderQuotaAndUsage(res.planQuota.used ?? 0, null, res.planQuota);
      renderRedemptions(res.redemptions || []);
      const tierText = tierLabels[res.tier] || 'Pro';
      const msg = res.planQuota?.planExpiresAt
        ? `已成功激活 ${tierText}，当前有效期至 ${formatTime(res.planQuota.planExpiresAt)}。`
        : `已成功激活 ${tierText}，无限次调用已启用！`;
      feedback.className = 'subtle';
      feedback.textContent = msg;
      notice(msg);
      await refresh();
    } catch (err) {
      feedback.className = 'error';
      feedback.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
    }
  });
});

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

byId('clear-revoked-devices').addEventListener('click', () => act(async () => {
  if (!await confirmAction('清理已撤销设备', '确认清空当前列表中的所有已撤销设备记录？在线和离线活跃设备以及历史任务记录不会受影响。')) return;
  const { deletedDevices } = await api('devices/clear-revoked', {});
  notice(`已清理 ${deletedDevices} 条已撤销设备记录。`);
  await refresh();
}));

byId('task-device').addEventListener('change', () => act(refreshTasks));
byId('task-status').addEventListener('change', () => act(refreshTasks));
byId('device-search').addEventListener('input', renderDevices);
byId('device-status').addEventListener('change', renderDevices);
byId('audit-search').addEventListener('input', renderAudit);
byId('refresh-now').addEventListener('click', () => act(refresh));
document.querySelectorAll('[data-close]').forEach(close => close.addEventListener('click', () => close.closest('dialog').close()));

// --- Admin Console Event Bindings ---
document.querySelectorAll('.admin-jump').forEach(btn => {
  btn.addEventListener('click', () => {
    switchPanel(btn.dataset.jumpPanel);
    act(refresh);
  });
});

document.querySelectorAll('[data-admin-codes]').forEach(btn => {
  btn.addEventListener('click', () => {
    activeAdminCodes = btn.dataset.adminCodes === 'redeem' ? 'redeem' : 'invites';
    document.querySelectorAll('[data-admin-codes]').forEach(b => b.classList.toggle('active', b === btn));
    byId('admin-invites-view').hidden = activeAdminCodes !== 'invites';
    byId('admin-redeem-view').hidden = activeAdminCodes !== 'redeem';
    act(refreshAdminCodes);
  });
});

document.querySelectorAll('[data-admin-fleet]').forEach(btn => {
  btn.addEventListener('click', () => {
    activeAdminFleet = btn.dataset.adminFleet === 'audit' ? 'audit' : 'devices';
    document.querySelectorAll('[data-admin-fleet]').forEach(b => b.classList.toggle('active', b === btn));
    byId('admin-fleet-devices-view').hidden = activeAdminFleet !== 'devices';
    byId('admin-fleet-device-filters').hidden = activeAdminFleet !== 'devices';
    byId('admin-fleet-audit-view').hidden = activeAdminFleet !== 'audit';
    byId('admin-fleet-audit-filters').hidden = activeAdminFleet !== 'audit';
    act(refreshAdminFleet);
  });
});

byId('admin-user-search').addEventListener('input', () => act(refreshAdminUsers));
byId('admin-user-plan').addEventListener('change', () => act(refreshAdminUsers));
byId('admin-user-status').addEventListener('change', () => act(refreshAdminUsers));
byId('admin-device-search').addEventListener('input', () => act(refreshAdminFleet));
byId('admin-device-status').addEventListener('change', () => act(refreshAdminFleet));
byId('admin-audit-search').addEventListener('input', () => act(refreshAdminFleet));

byId('admin-plan-select').addEventListener('change', () => {
  byId('admin-plan-duration-wrap').hidden = byId('admin-plan-select').value !== 'pro';
});

byId('admin-plan-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!adminPlanTargetUserId) return;
  act(async () => {
    const plan = byId('admin-plan-select').value === 'pro' ? 'pro' : 'free';
    const durVal = byId('admin-plan-duration').value;
    const durationDays = plan === 'pro' ? (durVal === 'permanent' ? null : Number(durVal)) : null;
    const customRaw = byId('admin-plan-custom-quota').value.trim();
    const customMonthlyQuota = customRaw ? Number(customRaw) : null;
    await api(`admin/users/${adminPlanTargetUserId}/plan`, { plan, durationDays, customMonthlyQuota });
    byId('admin-plan-dialog').close();
    notice('已更新用户套餐与配额设置。');
    await refresh();
  });
});

byId('admin-invite-form').addEventListener('submit', event => {
  event.preventDefault();
  act(async () => {
    const note = byId('admin-invite-note').value.trim();
    const maxUses = Number(byId('admin-invite-uses').value || 1);
    const daysRaw = byId('admin-invite-days').value.trim();
    const expiresInDays = daysRaw ? Number(daysRaw) : null;
    const { invite } = await api('admin/invites', { ...(note ? { note } : {}), maxUses, expiresInDays });
    byId('admin-invite-code-value').textContent = invite.code;
    byId('admin-invite-created').hidden = false;
    byId('admin-invite-form').reset();
    byId('admin-invite-uses').value = '1';
    notice('已生成新的注册邀请码。');
    await refreshAdminCodes();
  });
});
byId('copy-admin-invite').addEventListener('click', () => act(() => copyElement('admin-invite-code-value', '已复制注册邀请码。')));

byId('admin-redeem-form').addEventListener('submit', event => {
  event.preventDefault();
  act(async () => {
    const tier = byId('admin-redeem-tier').value;
    const count = Number(byId('admin-redeem-count').value || 1);
    const maxUses = Number(byId('admin-redeem-uses').value || 1);
    const daysRaw = byId('admin-redeem-days').value.trim();
    const expiresInDays = daysRaw ? Number(daysRaw) : null;
    const note = byId('admin-redeem-note').value.trim();
    const { codes } = await api('admin/redeem-codes', {
      tier,
      count,
      maxUses,
      expiresInDays,
      ...(note ? { note } : {})
    });
    byId('admin-redeem-codes-output').textContent = codes.map(c => c.code).join('\n');
    byId('admin-redeem-created').hidden = false;
    byId('admin-redeem-form').reset();
    byId('admin-redeem-count').value = '1';
    byId('admin-redeem-uses').value = '1';
    notice(`已成功生成 ${codes.length} 枚 Pro 兑换码。`);
    await refreshAdminCodes();
  });
});
byId('copy-admin-redeem-codes').addEventListener('click', () => act(() => copyElement('admin-redeem-codes-output', '已复制全部 Pro 兑换码。')));

byId('admin-policy-form').addEventListener('submit', event => {
  event.preventDefault();
  const feedback = byId('admin-policy-feedback');
  act(async () => {
    const registrationMode = byId('policy-reg-mode').value;
    const freeMonthlyQuota = Number(byId('policy-free-quota').value);
    const resultTtlMinutes = Number(byId('policy-result-ttl').value);
    await api('admin/settings', { registrationMode, freeMonthlyQuota, resultTtlMinutes });
    feedback.textContent = '系统策略已保存并立即生效。';
    notice('系统策略已更新。');
    await refresh();
  });
});

renderPromptLibrary();

act(async () => {
  try {
    const res = await fetch('/manage/api/session', { credentials: 'same-origin' });
    if (!res.ok) { showLogin(); return; }
    await showApp(await res.json());
  } catch {
    showLogin();
  }
});

setInterval(() => { if (csrf && !document.hidden) act(refresh); }, 5000);
