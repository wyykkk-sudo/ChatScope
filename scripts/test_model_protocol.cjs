const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Engine } = require('../app/lib/engine.cjs');
const { normalizeMessage, hasToolMarkup } = require('../app/web/tool-protocol.js');
const root = process.env.CHATSCOPE_TEST_WORK || path.resolve(__dirname, '../work');
const engine = new Engine({ runtime: path.join(root, 'runtime'), data: path.join(root, 'qa-model-protocol-012'), helper: {} });
let server, scenario, requests;
const results = [];
const dsml = (dialect, calls) => {
  const marker = dialect === 'ascii' ? '|DSML|' : dialect === 'double' ? '｜｜ DSML ｜｜ ' : '｜DSML｜';
  const wrapper = dialect === 'double' ? 'calls' : 'tool_calls';
  return `<${marker}${wrapper}>\n` + calls.map(([name, args]) => `<${marker}invoke name="${name}">` + Object.entries(args).map(([key, value]) => `<${marker}parameter name="${key}" string="${typeof value === 'string'}">${typeof value === 'string' ? value : JSON.stringify(value)}</${marker}parameter>`).join('\n') + `</${marker}invoke>`).join('\n') + `</${marker}${wrapper}>`;
};
async function check(name, fn) { await fn(); results.push(name); console.log('PASS: ' + name); }
(async () => {
  await check('DSML dialects, numeric and escaped parameters', async () => {
    for (const dialect of ['ascii', 'double', 'fullwidth']) {
      const normalized = normalizeMessage({ content: dsml(dialect, [['message_context', { message_id: 42 }], ['search_messages', { keyword: 'A &amp; B' }]]) });
      assert.equal(normalized.tool_calls.length, 2);
      assert.equal(JSON.parse(normalized.tool_calls[0].function.arguments).message_id, 42);
      assert.equal(JSON.parse(normalized.tool_calls[1].function.arguments).keyword, 'A & B');
      assert.equal(normalized.content, null);
    }
    const surrounding = normalizeMessage({ content: '正在查找。\n' + dsml('ascii', [['activity_statistics', {}]]) });
    assert.equal(surrounding.content, '正在查找。');
    assert.equal(normalizeMessage({ content: '## 正常回答\n参数名称：message_id' }).protocolError, undefined);
  });
  await check('malformed, truncated and duplicate parameters never become answers', async () => {
    const valid = dsml('fullwidth', [['message_context', { message_id: 42 }]]);
    for (const raw of [valid.slice(0, -10), '<｜DSML｜invoke name="search_messages">', valid.replace('42', 'NaN'), valid.replace('</｜DSML｜invoke>', '<｜DSML｜parameter name="message_id" string="false">1</｜DSML｜parameter></｜DSML｜invoke>')]) {
      const normalized = normalizeMessage({ content: raw });
      assert.equal(normalized.protocolError, true); assert.equal(normalized.content, null);
    }
  });
  await engine.start();
  await engine.importFile(path.resolve(__dirname, '../app/demo/group.json'), 'protocol_fixture');
  const rows = await engine.messages('protocol_fixture', {}, '待办', 60);
  assert.ok(rows.length);
  server = http.createServer(async (req, res) => {
    try {
      let input = ''; for await (const chunk of req) input += chunk;
      const body = JSON.parse(input); requests.push(body);
      assert.ok(body.tools.every(t => t.function.parameters.required.length === Object.keys(t.function.parameters.properties).length));
      const message = scenario(body, requests.length);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message }] }));
    } catch (error) { res.writeHead(500); res.end('{}'); console.error(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  engine.saveSettings({ endpoint: `http://127.0.0.1:${server.address().port}/v1`, model: 'protocol-regression', cloudAllowed: false });
  const ask = (history = []) => engine.ask({ session: 'protocol_fixture', question: '查找待办，并给出原文证据。', filter: {}, history });
  for (const dialect of ['ascii', 'double', 'fullwidth', 'native']) await check(`${dialect}: real search + context + statistics -> cited Markdown answer`, async () => {
    requests = [];
    scenario = (body, index) => {
      if (index === 1) {
        if (dialect === 'native') return { role: 'assistant', reasoning_content: 'Test-only reasoning', content: null, tool_calls: [{ id: 'native_1', type: 'function', function: { name: 'search_messages', arguments: '{"keyword":"待办"}' } }] };
        return { role: 'assistant', content: dsml(dialect, [['search_messages', { keyword: '待办' }], ['message_context', { message_id: rows[0].id }], ['activity_statistics', {}]]) };
      }
      const toolResults = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
      assert.ok(toolResults[0].total > 0 && toolResults[0].messages.every(m => m.content.includes('待办')));
      assert.equal(body.messages.some(m => hasToolMarkup(m.content)), false);
      if (dialect === 'native') assert.equal(body.messages.find(m => m.tool_calls).reasoning_content, 'Test-only reasoning');
      else {
        assert.ok(toolResults[1].some(m => m.id === rows[0].id));
        assert.equal(toolResults[2].total, 912);
      }
      return { role: 'assistant', content: `## 待办\n\n已找到相关记录。[#${toolResults[0].messages[0].id}]` };
    };
    const result = await ask([{ role: 'assistant', content: dsml('ascii', [['search_messages', { keyword: '旧的错误指令' }]]) }]);
    assert.equal(requests.length, 2); assert.equal(result.coverage, 912);
    assert.ok(result.answer.startsWith('##')); assert.equal(result.references.length, 1);
    assert.equal(hasToolMarkup(result.answer), false);
  });
  await check('truncated gateway output retries once with tools disabled', async () => {
    requests = [];
    scenario = (body, index) => index === 1 ? { content: '<｜DSML｜invoke name="message_context">' } : (assert.equal(body.tool_choice, 'none'), { content: '当前证据不足，无法确认具体约定。' });
    assert.equal((await ask()).answer, '当前证据不足，无法确认具体约定。');
    assert.equal(requests.length, 2);
  });
  await check('unknown tool cannot execute and returns an error to the model', async () => {
    requests = [];
    scenario = (body, index) => index === 1 ? { content: dsml('ascii', [['read_other_chat', { session: 'other' }]]) } : (assert.equal(JSON.parse(body.messages.find(m => m.role === 'tool').content).error, '工具不可用'), { content: '仅能分析当前聊天。' });
    assert.equal((await ask()).answer, '仅能分析当前聊天。');
  });
  await check('repeated raw tool output terminates without displaying internal instructions', async () => {
    requests = []; scenario = () => ({ content: dsml('ascii', [['activity_statistics', {}]]) });
    await assert.rejects(ask(), /无法识别的检索指令/);
    assert.equal(requests.length, 6); assert.equal(engine.abort, null);
  });
  await check('repeated malformed output terminates after one retry', async () => {
    requests = []; scenario = () => ({ content: '<｜DSML｜invoke name="message_context">' });
    await assert.rejects(ask(), /无法识别的检索指令/); assert.equal(requests.length, 2);
  });
  fs.writeFileSync(path.join(root, 'model-protocol-test-result.json'), JSON.stringify({ passed: true, cases: results, backend: 'real ChatLab 0.37.5', model: 'local HTTP mock; no cloud API called', privateDataUsed: false }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { server?.close(); engine.stop(); });
