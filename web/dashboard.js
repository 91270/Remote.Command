'use strict';
const byId = id => document.getElementById(id);
const terminalStates = new Set(['succeeded', 'failed', 'denied', 'cancelled', 'timed_out', 'interrupted']);
const labels = { queued: '排队中', dispatched: '已派发', awaiting_approval: '待本机确认', running: '运行中', succeeded: '已完成', failed: '失败', denied: '已拒绝', cancelled: '已取消', timed_out: '已超时', interrupted: '已中断' };
const capabilityNames = { read: '读取', write: '写入', exec: '命令' };
const platformNames = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const platformMarks = { darwin: 'MAC', win32: 'WIN', linux: 'LNX' };
const panels = {
  devices: ['设备', '连接和管理可供 ChatGPT 使用的工作设备。'],
  tasks: ['任务', '跟踪远程调用和设备端确认。'],
  audit: ['审计', '核查 Gateway 记录的操作。'],
  connect: ['接入 ChatGPT', '配置 MCP Server 并授权访问设备。']
};
let csrf = '', devices = [], auditRecords = [], activePanel = 'devices', currentTask = '', refreshing = false;
let verifiedCode = '';
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(label, className, action) {
  const element = node('button', className, label);
  element.type = 'button';
  element.addEventListener('click', () => act(action));
  return element;
}
function notice(message, failed = false) {
  const element = byId('notice');
  element.textContent = message;
  element.className = 'notice' + (failed ? ' error' : '');
  element.hidden = false;
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
function showLogin() {
  csrf = '';
  byId('notice').hidden = true;
  byId('owner-key').value = '';
  byId('app-view').hidden = true;
  byId('login-view').hidden = false;
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
}
async function showApp(session) {
  csrf = session.csrf;
  byId('login-view').hidden = true;
  byId('app-view').hidden = false;
  const gateway = session.origin || location.origin;
  byId('gateway-host').textContent = new URL(gateway).host;
  byId('device-gateway-url').textContent = gateway;
  const mcpUrl = session.mcpUrl || location.origin + '/mcp';
  byId('mcp-url').textContent = mcpUrl;
  byId('overview-mcp-url').textContent = mcpUrl;
  await refresh();
  const query = new URLSearchParams(location.search);
  const code = query.get('user_code');
  if (code && /^[A-Za-z0-9-]{4,32}$/.test(code)) {
    openVerification(code);
    query.delete('user_code');
    history.replaceState(null, '', location.pathname + (query.size ? '?' + query.toString() : ''));
  }
}
function time(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未连接';
}
function stateTag(state) {
  return node('span', 'status ' + state, labels[state] || state);
}
async function confirmAction(title, description, name) {
  const dialog = byId('confirm-dialog');
  byId('confirm-title').textContent = title;
  byId('confirm-description').textContent = description;
  byId('rename-value').hidden = name === undefined;
  byId('rename-label').hidden = name === undefined;
  byId('rename-value').value = name || '';
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm' ? { name: byId('rename-value').value.trim() } : null), { once: true }));
}
function renderDevices() {
  const grid = byId('devices');
  const query = byId('device-search').value.trim().toLocaleLowerCase();
  const filter = byId('device-status').value;
  const filtered = devices.filter(device => {
    const state = device.revoked ? 'revoked' : device.online ? 'online' : 'offline';
    return (!filter || state === filter) && (device.name.toLocaleLowerCase().includes(query) || device.id.includes(query));
  });
  byId('device-filters').hidden = devices.length === 0;
  byId('device-count').textContent = devices.length ? '显示 ' + filtered.length + ' 台，共 ' + devices.length + ' 台' : '';
  grid.replaceChildren();
  if (!filtered.length) {
    const empty = node('div', 'empty');
    if (devices.length) empty.append(node('h3', '', '没有符合条件的设备'));
    else empty.append(node('h3', '', '连接第一台设备'), node('p', '', '在工作设备终端启动客户端，使用浏览器完成配对。'),
      button('查看启动方式', 'secondary', () => byId('start-device-dialog').showModal()));
    grid.append(empty);
    return;
  }
  for (const device of filtered) {
    const card = node('article', 'device');
    const top = node('div', 'device-top');
    const status = device.revoked ? '已撤销' : device.online ? '在线' : '离线';
    const identity = node('div', 'device-identity');
    const deviceName = node('div');
    deviceName.append(node('h3', '', device.name), node('p', 'device-platform', platformNames[device.platform] || '等待首次连接'));
    identity.append(node('span', 'device-icon', platformMarks[device.platform] || 'DEV'), deviceName);
    top.append(identity, node('span', 'status ' + (device.revoked ? 'revoked' : device.online ? 'online' : 'offline'), status));
    card.append(top);
    const permissions = node('div', 'device-capabilities');
    for (const capability of device.capabilities) permissions.append(node('span', 'capability', capabilityNames[capability] || capability));
    card.append(permissions, node('code', 'device-id', device.id), node('p', 'subtle', '最近连接 ' + time(device.lastSeen)));
    const actions = node('div', 'device-actions');
    actions.append(button('查看任务', 'secondary', async () => {
      byId('task-device').value = device.id;
      byId('task-status').value = '';
      switchPanel('tasks');
      await refreshTasks();
    }));
    actions.append(button('复制 ID', 'text-button', () => copyText(device.id)));
    if (!device.revoked) {
      actions.append(button('重命名', 'text-button', async () => {
        const answer = await confirmAction('重命名设备', '修改控制台和对话中显示的设备名称。', device.name);
        if (!answer) return;
        await api('devices/' + device.id + '/rename', answer);
        await refresh();
      }));
      actions.append(button('撤销', 'text-button danger', async () => {
        if (!await confirmAction('撤销设备授权', '设备再次连接时停止接收任务。已经在离线设备上运行的进程需要在本机检查。')) return;
        await api('devices/' + device.id + '/revoke', {});
        notice('设备授权已撤销。');
        await refresh();
      }));
    }
    card.append(actions);
    grid.append(card);
  }
}
async function refreshTasks() {
  const selected = byId('task-device').value;
  const status = byId('task-status').value;
  const { tasks } = await api('tasks' + (selected ? '?device=' + encodeURIComponent(selected) : ''));
  if (selected !== byId('task-device').value || status !== byId('task-status').value) return;
  const visible = tasks.filter(task => !status || (status === 'active' ? !terminalStates.has(task.status) : task.status === status));
  const body = byId('tasks');
  body.replaceChildren();
  if (!visible.length) {
    const row = node('tr'), cell = node('td', 'muted', selected || status ? '没有符合条件的任务。' : '暂无任务。通过 ChatGPT 调用设备工具后，任务会显示在这里。');
    cell.colSpan = 5;
    row.append(cell);
    body.append(row);
  }
  for (const task of visible) {
    const row = node('tr');
    const operation = node('td');
    operation.append(node('code', '', task.toolName || task.operation));
    row.append(operation, node('td', 'muted', devices.find(device => device.id === task.device)?.name || task.device));
    const state = node('td');
    state.append(stateTag(task.status));
    const action = node('td');
    action.append(button('查看 →', 'text-button', () => openTask(task.id)));
    row.append(state, node('td', 'subtle', time(task.createdAt)), action);
    body.append(row);
  }
}
async function refreshRecentTasks() {
  const { tasks } = await api('tasks');
  const list = byId('recent-tasks');
  if (list.contains(document.activeElement)) return;
  list.replaceChildren();
  if (!tasks.length) list.append(node('p', 'muted', '开始调用设备工具后，这里会显示最近的结果。'));
  for (const task of tasks.slice(0, 3)) {
    const entry = node('div', 'recent-task');
    const data = node('div');
    data.append(node('code', 'recent-task-name', task.toolName || task.operation), stateTag(task.status));
    entry.append(data, button('查看', 'text-button', () => openTask(task.id)));
    list.append(entry);
  }
}
async function refreshAudit() {
  const { records } = await api('audit');
  auditRecords = records;
  renderAudit();
}
function renderAudit() {
  const body = byId('audit');
  body.replaceChildren();
  const query = byId('audit-search').value.trim().toLowerCase();
  const records = auditRecords.filter(record => !query || (record.event + ' ' + JSON.stringify(record.details)).toLowerCase().includes(query));
  if (!records.length) {
    const row = node('tr'), cell = node('td', 'muted', query ? '没有符合条件的日志。' : '暂无审计记录。');
    cell.colSpan = 3;
    row.append(cell);
    body.append(row);
  }
  for (const record of records) {
    const row = node('tr');
    row.append(node('td', 'subtle', time(record.at)), node('td', '', record.event), node('td', 'details', JSON.stringify(record.details)));
    body.append(row);
  }
}
async function refresh() {
  if (refreshing || !csrf) return;
  refreshing = true;
  try {
    const overview = await api('overview');
    devices = overview.devices;
    byId('stat-online').textContent = devices.filter(device => device.online).length;
    byId('stat-paired').textContent = devices.filter(device => !device.revoked).length + ' 台设备已配对';
    byId('stat-active').textContent = overview.activeTasks + ' 项任务进行中';
    byId('stat-approval').textContent = overview.taskCounts?.awaiting_approval ?? 0;
    byId('stat-calls').textContent = overview.totalCalls.toLocaleString('zh-CN');
    byId('last-refresh').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const selection = byId('task-device'), selected = selection.value;
    selection.replaceChildren(node('option', '', '所有设备'));
    selection.firstChild.value = '';
    for (const device of devices) {
      const option = node('option', '', device.name);
      option.value = device.id;
      selection.append(option);
    }
    selection.value = selected;
    if (!byId('devices').contains(document.activeElement)) renderDevices();
    if (activePanel === 'devices') await refreshRecentTasks();
    if (activePanel === 'tasks') await refreshTasks();
    if (activePanel === 'audit') await refreshAudit();
    if (byId('task-dialog').open && currentTask) await updateTask(currentTask);
  } finally { refreshing = false; }
}
function switchPanel(panel) {
  activePanel = panel;
  const [title, description] = panels[panel];
  byId('page-title').textContent = title;
  byId('page-description').textContent = description;
  for (const name of Object.keys(panels)) byId('panel-' + name).hidden = name !== panel;
  document.querySelectorAll('.nav-link').forEach(link => {
    const active = link.dataset.panel === panel;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}
async function updateTask(id) {
  const task = await api('tasks/' + id);
  if (id !== currentTask) return;
  byId('task-title').textContent = task.toolName || task.operation;
  byId('task-detail-status').replaceChildren(stateTag(task.status));
  byId('task-meta').textContent = (devices.find(device => device.id === task.device)?.name || task.device) + ' · ' + time(task.createdAt);
  byId('task-id').textContent = id;
  byId('task-approval').hidden = task.status !== 'awaiting_approval';
  const content = task.result?.content;
  const resultText = Array.isArray(content) ? content.map(entry => entry.type === 'text' ? entry.text : '[' + entry.type + ']').join('\n') : '';
  const output = resultText || task.output || (task.result?.structuredContent ? JSON.stringify(task.result.structuredContent, null, 2) : '')
    || (terminalStates.has(task.status) ? '设备没有返回文本输出。' : '等待设备返回输出。');
  if (byId('task-output').textContent !== output) byId('task-output').textContent = output;
  byId('cancel-task').hidden = terminalStates.has(task.status);
  byId('cancel-task').disabled = task.cancelRequested;
  byId('cancel-task').textContent = task.cancelRequested ? '已请求取消' : '请求取消任务';
}
async function openTask(id) {
  currentTask = id;
  await updateTask(id);
  if (currentTask === id && !byId('task-dialog').open) byId('task-dialog').showModal();
}
async function copyText(text) {
  await navigator.clipboard.writeText(text);
  notice('已复制。');
}
const copy = id => copyText(byId(id).textContent);
byId('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  byId('login-error').textContent = '';
  try {
    const session = await api('login', { ownerKey: byId('owner-key').value.trim() });
    byId('owner-key').value = '';
    await showApp(session);
  } catch (error) { byId('login-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
byId('logout').addEventListener('click', () => act(async () => { await api('logout', {}); showLogin(); }));
function resetVerification() {
  verifiedCode = '';
  byId('verify-details').hidden = true;
  byId('verify-actions').hidden = true;
  byId('verify-error').textContent = '';
}
function openVerification(code = '') {
  byId('verify-form').reset();
  byId('verify-code').value = code;
  resetVerification();
  byId('verify-dialog').showModal();
  if (code) void lookupDevice();
}
async function lookupDevice() {
  const field = byId('verify-code'), submit = byId('lookup-device');
  if (!field.reportValidity()) return;
  const code = field.value.trim();
  resetVerification();
  submit.disabled = true;
  try {
    const pairing = await api('device-preview', { user_code: code });
    if (field.value.trim() !== code || !byId('verify-dialog').open) return;
    verifiedCode = code;
    byId('verify-host').textContent = pairing.deviceName;
    byId('verify-expiry').textContent = '有效期至 ' + time(pairing.expiresAt);
    byId('verify-details').hidden = false;
    byId('verify-actions').hidden = false;
  } catch (error) { byId('verify-error').textContent = error.message; }
  finally { submit.disabled = false; }
}
async function verifyDevice(approve) {
  const form = byId('verify-form');
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const code = String(data.get('user_code')).trim();
  if (!verifiedCode || verifiedCode !== code) { await lookupDevice(); return; }
  const name = String(data.get('name') || '').trim();
  const selected = data.getAll('capabilities');
  if (approve && !selected.length) {
    byId('verify-error').textContent = '请选择至少一项设备权限。';
    return;
  }
  try {
    const result = await api('device-verify', { user_code: code,
      ...(name && { name }), capabilities: selected.length ? selected : ['read'], approve });
    byId('verify-dialog').close();
    notice(approve ? '已授权设备 ' + result.deviceName + '，等待客户端连接。' : '已拒绝此次设备配对。');
    await refresh();
  } catch (error) { byId('verify-error').textContent = error.message; }
}
byId('verify-device').addEventListener('click', () => openVerification());
byId('verify-code').addEventListener('input', resetVerification);
byId('lookup-device').addEventListener('click', () => act(lookupDevice));
byId('verify-form').addEventListener('submit', event => { event.preventDefault(); act(() => verifyDevice(true)); });
byId('deny-device').addEventListener('click', () => act(() => verifyDevice(false)));
byId('new-device').addEventListener('click', () => byId('start-device-dialog').showModal());
byId('copy-device-start').addEventListener('click', () => act(() => copy('device-start-command')));
byId('copy-gateway').addEventListener('click', () => act(() => copy('device-gateway-url')));
byId('start-enter-code').addEventListener('click', () => {
  byId('start-device-dialog').close();
  openVerification();
});
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
    byId('pair-expiry').textContent = '有效期至 ' + time(reply.expiresAt);
    byId('pair-form').hidden = true;
    byId('pair-result').hidden = false;
  });
});
byId('pair-done').addEventListener('click', () => { byId('pair-dialog').close(); act(refresh); });
byId('pair-dialog').addEventListener('close', () => { byId('pair-token').textContent = ''; });
byId('copy-token').addEventListener('click', () => act(() => copy('pair-token')));
byId('copy-mcp').addEventListener('click', () => act(() => copy('mcp-url')));
byId('copy-overview-mcp').addEventListener('click', () => act(() => copy('overview-mcp-url')));
byId('view-all-tasks').addEventListener('click', () => {
  byId('task-device').value = '';
  byId('task-status').value = '';
  switchPanel('tasks');
  act(refreshTasks);
});
byId('view-connect').addEventListener('click', () => switchPanel('connect'));
byId('copy-task-id').addEventListener('click', () => act(() => copy('task-id')));
byId('cancel-task').addEventListener('click', () => act(async () => { await api('tasks/' + currentTask + '/cancel', {}); await updateTask(currentTask); }));
byId('revoke-oauth').addEventListener('click', () => act(async () => {
  if (!await confirmAction('撤销全部 ChatGPT 授权', '所有已连接的 ChatGPT 会话都需要重新进行 OAuth 授权。')) return;
  await api('oauth/revoke', {});
  notice('已撤销全部 ChatGPT 授权。');
}));
byId('revoke-all-devices').addEventListener('click', () => act(async () => {
  if (!await confirmAction('撤销全部设备', '所有已配对设备都需要重新配对。未完成任务将标为中断，配对码和邀请也会失效。已启动的命令请到对应设备检查。')) return;
  const { revokedDevices, invalidatedPairings } = await api('devices/revoke-all', {});
  notice('已撤销 ' + revokedDevices + ' 台设备，已作废 ' + invalidatedPairings + ' 项配对记录。');
  await refresh();
}));
byId('task-device').addEventListener('change', () => act(refreshTasks));
byId('task-status').addEventListener('change', () => act(refreshTasks));
byId('device-search').addEventListener('input', renderDevices);
byId('device-status').addEventListener('change', renderDevices);
byId('audit-search').addEventListener('input', renderAudit);
byId('refresh-now').addEventListener('click', () => act(refresh));
document.querySelectorAll('[data-close]').forEach(close => close.addEventListener('click', () => close.closest('dialog').close()));
document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => { switchPanel(link.dataset.panel); act(refresh); }));
act(async () => {
  try { await showApp(await api('session')); }
  catch { showLogin(); }
});
setInterval(() => { if (csrf && !document.hidden) act(refresh); }, 5000);
