// Actual ChatLab backend, generated messages/assets and local model servers only.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Engine } = require('../app/lib/engine.cjs');
const work = path.resolve(process.env.CHATSCOPE_TEST_WORK || path.join(__dirname, '../work'));
const qa = fs.mkdtempSync(path.join(work, 'qa-export-models-'));
const engine = new Engine({ runtime: path.join(work, 'runtime'), data: path.join(qa, 'data'), helper: {}, protect: value => 'protected:' + value, reveal: value => value.slice(10) });
const results = [];
let server, mode = 'openai', received = [], statusCode = 200;
const check = async (name, fn) => { await fn(); results.push(name); console.log('PASS: ' + name); };
(async () => {
  await engine.start();
  await check('native JSON imports into actual ChatLab with all media message types', async () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(work, 'chat-export-native-result.json'), 'utf8'));
    await engine.importFile(fixture.file, 'native_export_test');
    const stats = await engine.statistics('native_export_test', {});
    assert.equal(stats.total, fixture.count);
    for (const type of [1, 2, 3, 4, 5]) assert.ok(stats.types.some(row => row.type === type));
    assert.ok((await engine.messages('native_export_test', {}, '', 30)).some(row => row.content.includes('[附件](attachments/')));
  });
  await check('imported export streams multiple pages, copies assets, blocks traversal and reimports', async () => {
    const origin = path.join(qa, 'origin'); fs.mkdirSync(path.join(origin, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(origin, 'attachments', 'small.gif'), 'GIF89a synthetic');
    fs.writeFileSync(path.join(origin, 'attachments', 'large.bin'), Buffer.alloc(65, 1));
    fs.writeFileSync(path.join(qa, 'outside.txt'), 'DO_NOT_COPY');
    const records = Array.from({ length: 1101 }, (_, i) => ({ sender: 'a', accountName: 'Test sender', timestamp: 1800000000 + i, type: 0, content: 'Synthetic task ' + i, platformMessageId: String(i + 1) }));
    records.push({ sender: 'a', accountName: 'Test sender', timestamp: 1800001200, type: 5, content: '[表情](attachments/small.gif)', platformMessageId: 'asset1' });
    records.push({ sender: 'a', accountName: 'Test sender', timestamp: 1800001201, type: 4, content: '[文件](attachments/large.bin)', platformMessageId: 'asset2' });
    records.push({ sender: 'a', accountName: 'Test sender', timestamp: 1800001202, type: 4, content: '[文件](../outside.txt)', platformMessageId: 'asset3' });
    const fixture = path.join(origin, 'messages.json');
    fs.writeFileSync(fixture, JSON.stringify({ chatlab: { version: '0.0.2', exportedAt: 1800000000 }, meta: { name: 'Export fixture', platform: 'wechat', type: 'group', groupId: 'test_export' }, members: [{ platformId: 'a', accountName: 'Test sender' }], messages: records }));
    const before = new Set((await engine.sessions()).map(s => s.id));
    await engine.importFile(fixture);
    const session = (await engine.sessions()).find(s => !before.has(s.id));
    assert.ok(session);
    assert.equal(engine.syncState.native_export_test?.importDirectory, undefined, 'unrelated sessions must not acquire the latest import directory');
    const exported = await engine.exportChat(session.id, qa, 64);
    const json = JSON.parse(fs.readFileSync(exported.file, 'utf8'));
    assert.equal(json.messages.length, 1104);
    assert.equal(exported.attachments.copied, 1); assert.equal(exported.attachments.skipped, 1); assert.equal(exported.attachments.missing, 1);
    assert.ok(fs.existsSync(path.join(exported.directory, json.messages.find(m => m.platformMessageId === 'asset1').attachments[0].path)));
    assert.ok(!JSON.stringify(json).includes('DO_NOT_COPY'));
    await engine.importFile(exported.file, 'roundtrip_export');
    assert.equal((await engine.statistics('roundtrip_export', {})).total, 1104);
    const count = fs.readdirSync(qa).length;
    await assert.rejects(engine.exportChat(session.id, qa, -1));
    assert.equal(fs.readdirSync(qa).length, count, 'invalid export must not create an output folder');
    const noAssets = await engine.exportChat(session.id, qa, 0);
    assert.equal(noAssets.attachments.copied, 0);
  });
  await engine.importFile(path.resolve(__dirname, '../app/demo/group.json'), 'model_fixture');
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); received.push({ url: req.url, headers: req.headers, body });
    if (statusCode !== 200) { res.writeHead(statusCode); res.end('{}'); return; }
    let result;
    if (mode === 'claude') {
      const tools = body.messages.flatMap(m => m.content).filter(b => b.type === 'tool_result');
      result = { content: tools.length ? [{ type: 'text', text: '## 分析结果\n\n已找到待办。[#' + JSON.parse(tools[0].content).messages[0].id + ']' }] : [{ type: 'tool_use', id: 'native_search', name: 'search_messages', input: { keyword: '待办' } }, { type: 'tool_use', id: 'native_stats', name: 'activity_statistics', input: {} }] };
    } else if (mode === 'empty') result = { choices: [{ message: { role: 'assistant', content: null } }] };
    else {
      const tools = body.messages.filter(m => m.role === 'tool');
      const message = tools.length ? { role: 'assistant', content: '**找到待办**。[#' + JSON.parse(tools[0].content).messages[0].id + ']' } : body.tools ? { role: 'assistant', content: null, tool_calls: [{ id: 'openai_search', type: 'function', function: { name: 'search_messages', arguments: '{"keyword":"待办"}' } }] } : { role: 'assistant', content: 'OK' };
      result = { choices: [{ message }] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await check('OpenAI custom base URLs, credentials, reasoning limits and real search roundtrip', async () => {
    for (const [suffix, expected] of [['', '/v1/chat/completions'], ['/v1', '/v1/chat/completions'], ['/gateway/v1/chat/completions', '/gateway/v1/chat/completions']]) {
      received = []; mode = 'openai';
      engine.saveSettings({ provider: 'openai', endpoint: base + suffix, model: 'gpt-4.1-mini', key: 'synthetic-key', cloudAllowed: false });
      const answer = await engine.ask({ session: 'model_fixture', question: '查找待办', filter: {} });
      assert.equal(received.length, 2); assert.equal(received[0].url, expected);
      assert.equal(received[0].headers.authorization, 'Bearer synthetic-key');
      assert.equal(received[0].body.max_completion_tokens, 2400); assert.equal(received[0].body.max_tokens, undefined);
      assert.ok(answer.references.length); assert.equal(answer.coverage, 912);
    }
    engine.saveSettings({ provider: 'openai', endpoint: base, model: 'gpt-5-mini' });
    await engine.testModel();
    assert.equal(received.at(-1).body.temperature, undefined); assert.equal(received.at(-1).body.max_completion_tokens, 8000);
  });
  await check('Claude native Messages URLs, headers, merged tool results and citations', async () => {
    for (const [suffix, expected] of [['', '/v1/messages'], ['/v1', '/v1/messages'], ['/gateway/v1/messages', '/gateway/v1/messages']]) {
      received = []; mode = 'claude';
      engine.saveSettings({ provider: 'claude', endpoint: base + suffix, model: 'claude-fixture', key: 'synthetic-claude', cloudAllowed: false });
      const answer = await engine.ask({ session: 'model_fixture', question: '查找待办', filter: {} });
      assert.equal(received.length, 2); assert.equal(received[0].url, expected);
      assert.equal(received[0].headers['x-api-key'], 'synthetic-claude'); assert.equal(received[0].headers['anthropic-version'], '2023-06-01'); assert.equal(received[0].headers.authorization, undefined);
      assert.ok(received[0].body.system.includes('当前会话')); assert.ok(received[0].body.tools[0].input_schema);
      const last = received[1].body.messages.at(-1);
      assert.equal(last.role, 'user'); assert.equal(last.content.filter(b => b.type === 'tool_result').length, 2);
      assert.ok(answer.references.length); assert.ok(answer.answer.includes('## 分析结果'));
    }
  });
  await check('Claude tools remain declared when final synthesis disables calls', async () => {
    mode = 'claude'; received = [];
    const schema = [{ function: { name: 'search_messages', description: 'search', parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] } } }];
    await engine.completion([{ role: 'user', content: 'Find tasks' }, { role: 'assistant', content: null, tool_calls: [{ id: 'native_search', function: { name: 'search_messages', arguments: '{"keyword":"task"}' } }] }, { role: 'tool', tool_call_id: 'native_search', content: '{"messages":[{"id":1}]}' }], schema, new AbortController().signal, 'none');
    assert.equal(received[0].body.tool_choice.type, 'none'); assert.equal(received[0].body.tools[0].name, 'search_messages');
  });
  await check('key scope and legacy migration; invalid/empty/error responses', async () => {
    const oldFile = JSON.stringify({ endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat', key: 'protected:old-fixture', cloudAllowed: true });
    fs.writeFileSync(engine.settingsFile, oldFile); engine.settings = JSON.parse(oldFile);
    assert.equal(engine.saveSettings({ provider: 'deepseek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }).hasKey, true);
    assert.equal(engine.saveSettings({ provider: 'openai', endpoint: 'https://api.openai.com/v1', model: 'test' }).hasKey, false);
    engine.saveSettings({ provider: 'openai', endpoint: base, model: 'test', key: 'synthetic' });
    assert.equal(engine.saveSettings({ provider: 'openai', endpoint: base + '/gateway/v1', model: 'test' }).hasKey, true);
    assert.equal(engine.saveSettings({ provider: 'openai', endpoint: 'https://another.example/v1', model: 'test' }).hasKey, false);
    assert.throws(() => engine.saveSettings({ provider: 'openai', endpoint: 'http://example.com', model: 'x' }));
    engine.saveSettings({ provider: 'openai', endpoint: base, model: 'test' });
    mode = 'empty'; await assert.rejects(engine.testModel());
    statusCode = 401; await assert.rejects(engine.testModel(), /认证失败/);
    statusCode = 429; await assert.rejects(engine.testModel(), /限流/);
  });
  fs.writeFileSync(path.join(work, 'export-provider-test-result.json'), JSON.stringify({ passed: true, tests: results, cloudApiTested: false, data: 'synthetic fixtures and local protocol servers' }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { server?.close(); engine.stop(); });
