(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.chatScopeToolProtocol = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  let sequence = 0;
  const marker = /<\s*\/?\s*[|｜]+\s*DSML\s*[|｜]+/i;
  const tag = /<\s*(\/?)\s*[|｜]+\s*DSML\s*[|｜]+\s*(tool_calls|calls|invoke|parameter)\b([^>]*)>/gi;
  const hasToolMarkup = value => marker.test(String(value || ''));
  function decode(value) {
    return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
      const names = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
      if (names[entity.toLowerCase()] !== undefined) return names[entity.toLowerCase()];
      const hex = entity[2].toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    });
  }
  function attributes(value) {
    const result = Object.create(null);
    const rest = value.replace(/([a-z_]+)\s*=\s*(["'])([\s\S]*?)\2/gi, (_, name, quote, content) => {
      if (Object.hasOwn(result, name)) throw new Error('duplicate attribute');
      result[name] = decode(content); return '';
    });
    if (rest.trim()) throw new Error('invalid attributes');
    return result;
  }
  function parseDSML(content) {
    if (content.length > 250000) throw new Error('oversized tool response');
    const canonical = content.replace(tag, (_, slash, name, attrs) => `<${slash}${name.toLowerCase()}${attrs}>`);
    if (hasToolMarkup(canonical)) throw new Error('unknown DSML tag');
    const calls = [];
    let remaining = canonical.replace(/<invoke\b([^>]*)>([\s\S]*?)<\/invoke\s*>/gi, (_, attrs, body) => {
      const invocation = attributes(attrs);
      if (!/^[a-zA-Z_][\w]*$/.test(invocation.name || '')) throw new Error('invalid tool name');
      const args = Object.create(null);
      const rest = body.replace(/<parameter\b([^>]*)>([\s\S]*?)<\/parameter\s*>/gi, (_, fields, value) => {
        const parameter = attributes(fields);
        if (!/^[a-zA-Z_][\w]*$/.test(parameter.name || '') || Object.hasOwn(args, parameter.name)) throw new Error('invalid parameter');
        if (!['true', 'false'].includes(parameter.string)) throw new Error('missing parameter type');
        args[parameter.name] = parameter.string === 'true' ? decode(value) : JSON.parse(decode(value).trim());
        return '';
      });
      if (rest.trim()) throw new Error('incomplete parameter');
      calls.push({ id: 'chatscope_dsml_' + (++sequence), type: 'function', function: { name: invocation.name, arguments: JSON.stringify(args) } });
      return '';
    });
    // Wrappers are optional in some gateways, but when present must balance.
    const wrappers = [];
    remaining = remaining.replace(/<(\/?)(tool_calls|calls)\s*>/gi, (_, slash, name) => {
      if (!slash) wrappers.push(name.toLowerCase());
      else if (wrappers.pop() !== name.toLowerCase()) throw new Error('unbalanced tools wrapper');
      return '';
    });
    if (wrappers.length || /<\/?(?:invoke|parameter|tool_calls|calls)\b/i.test(remaining) || !calls.length || calls.length > 16) throw new Error('incomplete tool response');
    // A gateway may wrap its complete tool response in a Markdown fence.
    remaining = remaining.replace(/^\s*```(?:xml|dsml)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    return { content: remaining || null, tool_calls: calls };
  }
  function normalizeMessage(message) {
    const result = { ...message, content: typeof message.content === 'string' ? message.content : null };
    if (hasToolMarkup(result.content)) {
      try {
        const parsed = parseDSML(result.content);
        result.content = parsed.content;
        if (!Array.isArray(result.tool_calls) || !result.tool_calls.length) result.tool_calls = parsed.tool_calls;
      } catch {
        result.content = null;
        result.protocolError = true;
      }
    }
    if (Array.isArray(result.tool_calls) && result.tool_calls.length) {
      if (result.tool_calls.length > 16) return { content: null, protocolError: true };
      const ids = new Set();
      result.tool_calls = result.tool_calls.map(call => {
        let id = typeof call.id === 'string' && call.id ? call.id : 'chatscope_call_' + (++sequence);
        if (ids.has(id)) id = 'chatscope_call_' + (++sequence);
        ids.add(id);
        return { id, type: 'function', function: { name: String(call.function?.name || ''), arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments || {}) } };
      });
      // Valid structured calls can still be executed if accompanying text is broken.
      result.protocolError = false;
    }
    return result;
  }
  return { hasToolMarkup, normalizeMessage };
});
