const $ = id => document.getElementById(id);
const api = window.scope;
let items = [], selected = null, category = 'all', currentStats, settings, busy = false, connecting = false, loading = false, generation = 0, oldest, lastMessages = [], directory, reconnectTimer;
const conversations = new Map();
const fmt = n => Number(n || 0).toLocaleString('zh-CN');
const date = ts => ts ? new Date(ts * 1000).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }) : '';
const fullDate = ts => new Date(ts * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
async function call(name, args) { const result = await api[name](args); if (!result.ok) throw new Error(result.error); return result.data; }
function toast(message) { $('toast').textContent = message; $('toast').classList.remove('hidden'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').classList.add('hidden'), 8000); }
function status(message) { $('status-text').textContent = message; if (connecting || loading) $('welcome-status').textContent = message; if (busy) $('ai-status').textContent = message; }
api.onProgress(value => status(value.message + (value.messages ? ` · ${fmt(value.messages)} 条` : value.completed ? ` · ${value.completed}/${value.candidates}` : value.verified ? ` · ${value.verified}/${value.databases}` : '')));
function filter() {
  const range = $('range').value;
  if (range === 'all') return {};
  if (range === 'custom') {
    const start = $('start').value, end = $('end').value;
    if (!start || !end || start > end) throw new Error('请选择有效的开始和结束日期。');
    return { start: new Date(start + 'T00:00:00+08:00').getTime() / 1000, end: new Date(end + 'T23:59:59+08:00').getTime() / 1000 };
  }
  return { start: Math.floor(Date.now() / 1000) - Number(range) * 86400, end: Math.floor(Date.now() / 1000) };
}
function conversationKey() { return selected.id + ':' + $('range').value + ':' + ($('range').value === 'custom' ? $('start').value + ':' + $('end').value : ''); }
function history() { const key = conversationKey(); if (!conversations.has(key)) {
  try { conversations.set(key, JSON.parse(localStorage.getItem('chat:' + key) || '[]')); } catch { conversations.set(key, []); }
} return conversations.get(key); }
function saveConversation() { try { localStorage.setItem('chat:' + conversationKey(), JSON.stringify(history().slice(-60))); } catch { toast('本地问答存储空间不足，当前对话仍可继续。'); } }
function displayAnswer(turn) {
  return turn.role === 'assistant' && window.chatScopeToolProtocol.hasToolMarkup(turn.content)
    ? '这条旧回复包含未完成的检索指令。软件已更新，请重新发送原问题。' : turn.content;
}
function modelBadge() { $('model-badge').textContent = settings?.hasKey || settings?.endpoint?.startsWith('http://') ? settings.model : '配置模型后即可提问'; }
function renderList() {
  const term = $('search').value.trim().toLowerCase();
  const visible = items.filter(s => (category === 'all' || s.type === category) && (s.name || s.id).toLowerCase().includes(term));
  $('sessions').replaceChildren();
  $('all-count').textContent = items.length; $('list-count').textContent = visible.length;
  for (const item of visible) {
    const button = el('button', 'session' + (selected?.id === item.id ? ' active' : ''));
    const avatar = el('span', 'avatar' + (item.type === 'group' ? ' group' : ''), item.type === 'group' ? '⋈' : (item.name || '聊').slice(0, 1));
    const text = el('span', 'session-text');
    text.append(el('span', 'session-name', item.name || item.id), el('span', 'session-meta', (item.type === 'group' ? '群聊' : '私聊') + (item.messageCount ? ` · ${fmt(item.messageCount)} 条` : '') + (item.name?.includes('示例') ? ' · 示例数据' : item.source === 'file' ? ' · 已导入' : '')));
    button.append(avatar, text, el('span', 'session-date', date(item.lastTimestamp)));
    button.title = item.name || item.id; button.onclick = () => select(item);
    $('sessions').append(button);
  }
  if (!visible.length) $('sessions').append(el('div', 'empty', items.length ? '没有匹配的会话' : '打开并登录微信后，\n聊天会话会出现在这里。'));
}
async function refreshList() { items = await call('sessions'); renderList(); }
async function connect(account) {
  connecting = true; $('source-title').textContent = '正在连接微信'; status('正在连接微信…'); $('refresh').disabled = true;
  try {
    const result = await call('connect', { account });
    await refreshList();
    $('source-dot').classList.add('ready'); $('source-title').textContent = '微信已连接'; $('source-sub').textContent = `已发现 ${fmt(result.sessions.length)} 个会话`;
    $('welcome-status').textContent = `已找到 ${fmt(result.sessions.length)} 个会话，选一个开始吧`;
    $('welcome-detail').textContent = '聊天列表已就绪。点击左侧好友或群聊，软件会自动准备该会话的分析与问答。';
    status('微信已连接 · 选择左侧会话即可开始');
  } catch (error) {
    $('source-title').textContent = '微信连接未完成'; $('source-sub').textContent = '点击 ↻ 重新连接'; $('source-dot').classList.remove('ready');
    $('welcome-status').textContent = '暂时无法读取微信记录'; $('welcome-detail').textContent = error.message; status(error.message); toast(error.message);
  } finally { connecting = false; $('refresh').disabled = false; }
}
async function discover() {
  if (connecting || busy) return;
  clearTimeout(reconnectTimer);
  status('正在寻找已登录的微信…');
  try {
    const result = await call('discover', { directory });
    await refreshList();
    if (!result.running) {
      $('source-title').textContent = '等待微信登录'; $('source-sub').textContent = '登录后点击 ↻ 重新连接';
      $('welcome-status').textContent = '打开并登录微信，即可开始'; $('welcome-detail').textContent = '软件会自动定位本机数据。已有 EchoTrace、WeFlow 或 ChatLab 导出记录也可以直接导入。'; status('请先打开并登录电脑微信'); reconnectTimer = setTimeout(discover, 10000); return;
    }
    if (!result.accounts.length) {
      $('welcome-status').textContent = '微信已运行，正在等待本地记录'; $('welcome-detail').textContent = '暂未找到微信 4.x 数据目录。可点击下方选择 xwechat_files 文件夹。'; $('source-title').textContent = '未找到数据目录'; status('未找到微信 4.x 数据目录'); return;
    }
    const active = result.accounts.filter(a => a.active);
    if (active.length === 1) await connect(active[0].id);
    else if (result.accounts.length === 1) await connect(result.accounts[0].id);
    else {
      $('accounts').replaceChildren();
      for (const account of result.accounts) {
        const button = el('button', 'account-button', account.name);
        button.append(el('small', '', account.active ? '微信正在使用此账号' : '本机已有此账号记录'));
        button.onclick = () => { $('accounts-dialog').close(); connect(account.id); }; $('accounts').append(button);
      }
      $('accounts-dialog').showModal(); status('请选择本次要分析的微信账号');
    }
  } catch (error) { status(error.message); toast(error.message); $('welcome-status').textContent = '启动遇到问题'; $('welcome-detail').textContent = error.message; }
}
async function select(item) {
  if (busy) { toast('请先等待当前回答或点击停止，再切换聊天。'); return; }
  selected = item; currentStats = null; $('header-name').textContent = item.name; $('session-name').textContent = item.name;
  $('session-type').textContent = item.type === 'group' ? 'GROUP CONVERSATION · 群聊分析' : 'PRIVATE CONVERSATION · 私聊分析';
  $('session-description').textContent = item.name?.includes('示例') ? '当前为虚构示例数据' : '本地记录 · ChatLab 分析 · 原文可追溯';
  $('workspace').classList.remove('hidden'); $('welcome').classList.add('hidden'); renderList(); renderConversation(); await loadAnalysis();
}
async function loadAnalysis() {
  if (!selected || busy) return;
  let dates; try { dates = filter(); } catch (error) { toast(error.message); return; }
  const request = ++generation, id = selected.id;
  loading = true; $('loading-analysis').classList.remove('hidden'); $('send').disabled = true; $('export-report').disabled = true;
  try {
    const result = await call('statistics', { session: id, filter: dates });
    if (generation !== request) return;
    currentStats = result; renderStats(result); await loadMessages(true, request); renderConversation();
    status(`已准备 ${fmt(result.total)} 条消息 · 可直接向模型提问`);
    $('export-report').disabled = false;
  } catch (error) { if (generation === request) { toast(error.message); status(error.message); $('messages').replaceChildren(el('div', 'empty', error.message)); $('metric-total').textContent = '—'; $('metric-members').textContent = '—'; $('metric-days').textContent = '—'; } }
  finally { if (generation === request) { loading = false; $('loading-analysis').classList.add('hidden'); $('send').disabled = !currentStats?.total; } }
}
function renderBars(container, data, max, label, min = 1) {
  container.replaceChildren();
  for (const entry of data) {
    const bar = el('div', 'bar'); bar.style.height = Math.max(min, (entry.count / Math.max(max, 1)) * 100) + '%'; bar.title = label(entry); container.append(bar);
  }
}
function renderStats(data) {
  $('metric-total').textContent = fmt(data.total); $('metric-members').textContent = fmt(data.members); $('metric-days').textContent = fmt(data.activeDays);
  const points = data.days || [];
  const buckets = [];
  const width = Math.max(1, Math.ceil(points.length / 64));
  for (let i = 0; i < points.length; i += width) { const group = points.slice(i, i + width); buckets.push({ day: group[0].day + (group.length > 1 ? ' 至 ' + group.at(-1).day : ''), count: group.reduce((sum, p) => sum + p.count, 0) }); }
  renderBars($('trend'), buckets, Math.max(0, ...buckets.map(p => p.count)), p => p.day + ' · ' + fmt(p.count) + ' 条');
  $('chart-sub').textContent = width > 1 ? `每柱聚合 ${width} 个活跃日` : '每天的消息数量';
  $('trend-start').textContent = points[0]?.day || '暂无数据'; $('trend-end').textContent = points.at(-1)?.day || '';
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: data.hours.find(e => Number(e.hour) === h)?.count || 0 }));
  renderBars($('hours'), hours, Math.max(0, ...hours.map(h => h.count)), h => `${h.hour}:00 · ${fmt(h.count)} 条`, 2);
  $('members').replaceChildren();
  for (const member of data.topMembers.slice(0, 5)) {
    const row = el('div', 'member'), label = el('div', 'member-label'); label.append(el('span', '', member.name), el('span', '', fmt(member.count)));
    const track = el('div', 'member-track'), bar = el('div'); bar.style.width = (member.count / Math.max(data.topMembers[0].count, 1) * 100) + '%'; track.append(bar); row.append(label, track); $('members').append(row);
  }
}
function renderMessage(row, highlight) {
  const node = el('div', 'message-row' + (row.id === highlight ? ' highlight' : ''));
  const meta = el('div', 'metadata'); meta.append(el('strong', '', row.name), el('span', '', fullDate(row.timestamp)), el('span', '', '#' + row.id));
  node.append(meta, el('p', '', row.content || `[消息类型 ${row.type}]`)); return node;
}
async function loadMessages(reset = false, request = generation) {
  if (!selected) return;
  try {
    const rows = await call('messages', { session: selected.id, filter: filter(), keyword: $('message-search').value, before: reset ? undefined : oldest });
    if (request !== generation) return;
    if (reset) { lastMessages = []; $('messages').replaceChildren(); }
    lastMessages.push(...rows); oldest = rows.at(-1)?.id;
    for (const row of rows) $('messages').append(renderMessage(row));
    if (!lastMessages.length) $('messages').append(el('div', 'empty', '这个范围内没有匹配的记录。'));
    $('more-messages').disabled = rows.length < 80;
  } catch (error) { toast(error.message); }
}
function renderConversation() {
  if (!selected) return;
  const turns = history(); $('ai-conversation').replaceChildren(); $('suggestions').classList.toggle('hidden', turns.length > 0);
  for (const turn of turns) {
    const node = el('div', 'turn ' + turn.role);
    if (turn.role === 'assistant') node.append(el('span', 'turn-label', '✦ ' + (turn.model || '聊天助手')));
    if (turn.role === 'assistant') {
      const session = selected.id, dates = filter();
      node.append(window.renderChatMarkdown(displayAnswer(turn), turn.references || [], {
        cite: id => showEvidence(session, id, dates),
        openExternal: url => call('openExternal', { url }).catch(error => toast(error.message)),
        copy: text => call('copyText', { text }).catch(error => toast(error.message)),
      }));
      if (turn.coverage !== undefined) node.append(el('div', 'coverage', `统计范围 ${fmt(turn.coverage)} 条 · 本次检索 ${fmt(turn.examined)} 条原文 · 点击引用核对`));
    } else node.append(document.createTextNode(turn.content));
    $('ai-conversation').append(node);
  }
  $('ai-conversation').scrollTop = $('ai-conversation').scrollHeight;
}
async function showEvidence(session, id, dates) {
  try { const rows = await call('context', { session, id, filter: dates }); $('evidence-content').replaceChildren(...rows.map(row => renderMessage(row, id))); $('evidence-dialog').showModal(); } catch (error) { toast(error.message); }
}
function setBusy(value) { busy = value; $('send').disabled = value || loading || !currentStats?.total; $('stop').classList.toggle('hidden', !value); $('ai-status').classList.toggle('hidden', !value); for (const id of ['range', 'start', 'end', 'apply-range', 'clear-chat']) $(id).disabled = value; }
async function ask(question) {
  if (!selected || busy || loading) return;
  const value = String(question || $('question').value).trim(); if (!value) return;
  const local = settings?.endpoint?.startsWith('http://');
  if ((!local && !settings?.hasKey) || (!local && !settings?.cloudAllowed)) { $('question').value = value; openSettings(); toast('先连接模型，保存后即可发送这个问题。'); return; }
  const turns = history(), before = turns.map(t => ({ role: t.role, content: t.content }));
  turns.push({ role: 'user', content: value }); $('question').value = ''; renderConversation(); setBusy(true); status('正在整理这段聊天的上下文…');
  try {
    const reply = await call('ask', { session: selected.id, question: value, filter: filter(), history: before });
    turns.push({ role: 'assistant', content: reply.answer, references: reply.references, coverage: reply.coverage, examined: reply.examined, model: reply.model }); saveConversation(); renderConversation(); status('回答已完成 · 可点击引用查看原文');
  } catch (error) { toast(error.message); turns.pop(); $('question').value = value; renderConversation(); status(error.message); }
  finally { setBusy(false); }
}
function openSettings() {
  $('endpoint').value = settings?.endpoint || 'https://api.deepseek.com/v1'; $('model').value = settings?.model || 'deepseek-chat'; $('key').value = '';
  $('key').placeholder = settings?.hasKey ? '密钥已加密保存；留空保留当前密钥' : '输入 API Key'; $('cloud-allowed').checked = settings?.cloudAllowed || false; $('redact').checked = settings?.redact !== false; $('settings-error').textContent = '';
  $('provider').value = $('endpoint').value.includes('deepseek') ? 'deepseek' : $('endpoint').value.includes('11434') ? 'ollama' : 'compatible'; $('settings-dialog').showModal();
}
async function saveSettings(test) {
  $('settings-error').textContent = ''; $('test-model').disabled = true; $('save-settings').disabled = true;
  try {
    settings = await call('saveSettings', { endpoint: $('endpoint').value.trim(), model: $('model').value.trim(), key: $('key').value.trim(), cloudAllowed: $('cloud-allowed').checked, redact: $('redact').checked }); modelBadge(); $('key').value = '';
    if (test) { $('settings-error').textContent = '正在测试连接…'; await call('testModel'); }
    $('settings-dialog').close(); toast(test ? '模型连接成功，可以开始提问。' : '模型配置已加密保存在本机。');
  } catch (error) { $('settings-error').textContent = error.message; }
  finally { $('test-model').disabled = false; $('save-settings').disabled = false; }
}
$('provider').onchange = () => { const p = $('provider').value; if (p === 'deepseek') { $('endpoint').value = 'https://api.deepseek.com/v1'; $('model').value = 'deepseek-chat'; } else if (p === 'ollama') { $('endpoint').value = 'http://127.0.0.1:11434/v1'; $('model').value = 'qwen3:8b'; $('cloud-allowed').checked = false; } };
$('save-settings').onclick = () => saveSettings(false); $('test-model').onclick = () => saveSettings(true); $('settings').onclick = openSettings;
document.querySelectorAll('.close-dialog').forEach(b => b.onclick = () => b.closest('dialog').close());
document.querySelectorAll('.filters button').forEach(button => button.onclick = () => { category = button.dataset.type; document.querySelectorAll('.filters button').forEach(b => b.classList.toggle('active', b === button)); renderList(); });
$('search').oninput = renderList; $('refresh').onclick = discover;
$('choose-dir').onclick = async () => { try { directory = await call('directory'); if (directory) await discover(); } catch (error) { toast(error.message); } };
$('import').onclick = async () => { try { $('import').disabled = true; const result = await call('import'); if (!result.canceled) { await refreshList(); status('记录已导入，点击左侧会话开始分析'); toast(`已导入 ${result.count} 个文件`); } } catch (error) { toast(error.message); } finally { $('import').disabled = false; } };
$('demo').onclick = async () => { try { await call('demo'); await refreshList(); const first = items.find(s => s.name?.includes('示例')); if (first) await select(first); } catch (error) { toast(error.message); } };
$('range').onchange = () => { $('custom-range').classList.toggle('hidden', $('range').value !== 'custom'); if ($('range').value !== 'custom') loadAnalysis(); };
$('apply-range').onclick = loadAnalysis; $('search-messages').onclick = () => loadMessages(true); $('message-search').onkeydown = e => { if (e.key === 'Enter') loadMessages(true); }; $('more-messages').onclick = () => loadMessages(false);
$('send').onclick = () => ask(); $('stop').onclick = () => api.cancel(); $('question').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); } };
document.querySelectorAll('[data-question]').forEach(button => button.onclick = () => ask(button.dataset.question));
$('clear-chat').onclick = () => { if (!selected || busy) return; conversations.set(conversationKey(), []); saveConversation(); renderConversation(); };
$('export-report').onclick = async () => {
  if (!selected || !currentStats) return;
  const content = `# ${selected.name} · 聊天分析\n\n生成时间：${new Date().toLocaleString('zh-CN')}\n\n范围：${$('range').selectedOptions[0].textContent}${$('range').value === 'custom' ? ' ' + $('start').value + ' 至 ' + $('end').value : ''}\n\n消息数：${fmt(currentStats.total)}\n发言人数：${fmt(currentStats.members)}\n活跃天数：${fmt(currentStats.activeDays)}\n\n## 发言排行\n\n${currentStats.topMembers.map(m => `- ${m.name}：${fmt(m.count)} 条`).join('\n')}\n\n## 模型问答\n\n${history().map(t => `### ${t.role === 'user' ? '问题' : '回答'}\n\n${displayAnswer(t)}\n${t.references?.length ? '\n引用原文：\n' + t.references.map(r => `\n[#${r.id}] ${fullDate(r.timestamp)} ${r.name}\n${r.content || ''}`).join('\n') : ''}`).join('\n\n')}\n\n统计覆盖所选范围的全部本地消息；模型使用有限检索片段，请核对原文。\n`;
  try { const result = await call('exportReport', { content }); if (result.saved) toast('报告已保存。'); } catch (error) { toast(error.message); }
};
(async () => { try { settings = await call('settings'); modelBadge(); await discover(); } catch (error) { status(error.message); toast(error.message); } })();
