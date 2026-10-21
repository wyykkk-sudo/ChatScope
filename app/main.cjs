const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Engine } = require('./lib/engine.cjs');

app.setName('ChatScope');
const portableData = process.env.CHATSCOPE_DATA || path.join(path.dirname(process.execPath), 'data');
fs.mkdirSync(path.join(portableData, 'window-profile'), { recursive: true });
app.setPath('userData', path.join(portableData, 'window-profile'));
if (!app.requestSingleInstanceLock()) app.quit();
let window;
let engine;
let ready;
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.whenReady().then(() => {
  const runtime = process.env.CHATSCOPE_RUNTIME || path.join(process.resourcesPath, 'chatscope-runtime');
  const data = process.env.CHATSCOPE_DATA || path.join(path.dirname(process.execPath), 'data');
  engine = new Engine({ runtime, data, helper: { exe: path.join(runtime, 'reader', 'ChatScopeReader.exe') }, protect: key => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法安全保存密钥，请检查 Windows 账户环境。');
    return safeStorage.encryptString(key).toString('base64');
  }, reveal: key => safeStorage.decryptString(Buffer.from(key, 'base64')) });
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 980, minHeight: 700, backgroundColor: '#f4f6f8', autoHideMenuBar: true, title: 'ChatScope · 微信聊天分析', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  engine.on('progress', event => { if (!window.isDestroyed()) window.webContents.send('progress', event); });
  ready = engine.start();
  ready.catch(() => {});
  const handle = (name, fn) => ipcMain.handle('scope:' + name, async (event, args) => {
    if (event.sender !== window.webContents) return { ok: false, error: '无法访问' };
    try { await ready; return { ok: true, data: await fn(args || {}) }; }
    catch (error) { return { ok: false, error: error.name === 'AbortError' ? '已停止回答。' : error.message }; }
  });
  handle('settings', () => engine.publicSettings());
  handle('saveSettings', args => engine.saveSettings(args));
  handle('testModel', () => engine.testModel());
  handle('openExternal', async args => {
    const url = new URL(String(args.url));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('无法打开此链接。');
    await shell.openExternal(url.href); return { success: true };
  });
  handle('copyText', args => { clipboard.writeText(String(args.text || '').slice(0, 1000000)); return { success: true }; });
  handle('discover', args => process.env.CHATSCOPE_QA ? { running: false, accounts: [] } : engine.discover(args.directory));
  handle('connect', args => engine.connect(args.account));
  handle('sessions', () => engine.sessions());
  handle('statistics', args => engine.statistics(args.session, args.filter));
  handle('messages', args => engine.messages(args.session, args.filter, args.keyword, 80, args.before));
  handle('context', args => engine.context(args.session, Number(args.id), args.filter));
  handle('refreshChat', args => engine.prepare(args.session, true));
  handle('ask', args => engine.ask(args));
  handle('import', async () => {
    const result = await dialog.showOpenDialog(window, { title: '导入聊天记录', properties: ['openFile', 'multiSelections'], filters: [{ name: '聊天记录', extensions: ['json', 'jsonl'] }] });
    if (result.canceled) return { canceled: true };
    for (const file of result.filePaths) await engine.importFile(file);
    return { count: result.filePaths.length };
  });
  handle('demo', async () => {
    for (const file of ['group.json', 'private.json']) await engine.importFile(path.join(__dirname, 'demo', file));
    return { success: true };
  });
  handle('directory', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择微信 xwechat_files 数据目录', properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('exportReport', async args => {
    const result = await dialog.showSaveDialog(window, { title: '保存分析报告', defaultPath: '聊天分析.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (result.canceled) return { canceled: true };
    fs.writeFileSync(result.filePath, String(args.content || '').slice(0, 2_000_000), 'utf8');
    return { saved: true };
  });
  handle('exportChat', async args => {
    if (!args?.session) throw new Error('请先选择一个聊天。');
    const result = process.env.CHATSCOPE_QA && process.env.CHATSCOPE_QA_EXPORT ? { canceled: false, filePaths: [process.env.CHATSCOPE_QA_EXPORT] } : await dialog.showOpenDialog(window, { title: '选择 ChatLab 导出文件夹', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return { canceled: true };
    const exported = await engine.exportChat(args.session, result.filePaths[0], args.maxAttachmentBytes);
    if (!process.env.CHATSCOPE_QA) await shell.openPath(exported.directory);
    return exported;
  });
  ipcMain.handle('scope:cancel', () => { engine.cancel(); return { ok: true }; });
  window.loadFile(path.join(__dirname, 'web', 'index.html'));
  if (process.env.CHATSCOPE_QA) {
    window.webContents.once('did-finish-load', () => {
      ready.then(async () => {
        if (process.env.CHATSCOPE_QA_FILE) await engine.importFile(process.env.CHATSCOPE_QA_FILE);
        await window.webContents.executeJavaScript("document.getElementById('refresh').click()");
      }).catch(() => {});
    });
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => engine?.stop());
