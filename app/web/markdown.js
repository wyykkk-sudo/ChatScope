/* Markdown is untrusted model output. Parse locally, sanitize, then add UI controls. */
(() => {
  const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const parser = new marked.Marked({ gfm: true, breaks: true, async: false, renderer: {
    html: token => escape(token.text),
    image: token => `<span>【图片：${escape(token.text || '图片')}】</span>`,
    checkbox: token => token.checked ? '☑ ' : '☐ ',
  } });
  function renderMarkdown(content, references, actions) {
    const root = document.createElement('div'); root.className = 'markdown-body';
    const html = parser.parse(String(content || '').replace(/^[\u200B\uFEFF]+/, ''));
    root.append(DOMPurify.sanitize(html, {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 's', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'span'],
      ALLOWED_ATTR: ['href', 'title', 'class', 'start', 'align'],
      ALLOW_DATA_ATTR: false,
    }));
    for (const link of root.querySelectorAll('a')) {
      let url;
      try { url = new URL(link.getAttribute('href')); } catch {}
      if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) { link.replaceWith(...link.childNodes); continue; }
      link.rel = 'noopener noreferrer'; link.title = url.href;
      link.addEventListener('click', event => { event.preventDefault(); actions.openExternal(url.href); });
    }
    const known = new Set(references.map(r => Number(r.id)));
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (node.parentElement.closest('pre, code, a')) continue;
      const matches = [...node.data.matchAll(/\[#(\d+)\]/g)].filter(m => known.has(Number(m[1])));
      if (!matches.length) continue;
      const fragment = document.createDocumentFragment(); let end = 0;
      for (const match of matches) {
        fragment.append(document.createTextNode(node.data.slice(end, match.index)));
        const cite = document.createElement('button'); cite.className = 'citation'; cite.type = 'button'; cite.textContent = '#' + match[1];
        cite.title = '查看聊天原文'; cite.onclick = () => actions.cite(Number(match[1])); fragment.append(cite);
        end = match.index + match[0].length;
      }
      fragment.append(document.createTextNode(node.data.slice(end))); node.replaceWith(fragment);
    }
    for (const table of root.querySelectorAll('table')) {
      const wrapper = document.createElement('div'); wrapper.className = 'markdown-table'; table.replaceWith(wrapper); wrapper.append(table);
    }
    for (const pre of root.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      const toolbar = document.createElement('div'); toolbar.className = 'code-toolbar';
      const language = document.createElement('span'); language.textContent = code?.className.match(/language-([\w+-]+)/)?.[1] || '文本';
      const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制'; copy.title = '复制代码';
      copy.onclick = () => actions.copy(code?.textContent || '').then(() => { copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制'; }, 1800); });
      toolbar.append(language, copy);
      const wrapper = document.createElement('div'); wrapper.className = 'markdown-code'; pre.replaceWith(wrapper); wrapper.append(toolbar, pre);
    }
    return root;
  }
  window.renderChatMarkdown = renderMarkdown;
})();
