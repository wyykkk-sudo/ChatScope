const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MEDIA = { 1: 'images', 2: 'voice', 3: 'videos', 4: 'files', 5: 'emoji' };

async function exportImported(engine, session, directory, cap) {
  const metaRows = await engine.sql(session.id, 'SELECT * FROM meta LIMIT 1');
  const stored = metaRows[0] || {};
  const meta = { name: stored.name || session.name || session.id, platform: stored.platform || 'wechat', type: stored.type || session.type || 'private', sourceSessionId: session.id };
  for (const [from, to] of [['owner_id', 'ownerId'], ['group_id', 'groupId'], ['group_avatar', 'groupAvatar']]) if (stored[from]) meta[to] = stored[from];
  const allMembers = [];
  let cursor = 0;
  while (true) {
    const rows = await engine.sql(session.id, `SELECT * FROM member WHERE id>${cursor} ORDER BY id LIMIT 500`);
    if (!rows.length) break;
    for (const row of rows) {
      allMembers.push({ platformId: row.platform_id, accountName: row.account_name || row.platform_id, ...(row.group_nickname ? { groupNickname: row.group_nickname } : {}), ...(row.avatar ? { avatar: row.avatar } : {}) });
      cursor = row.id;
    }
  }
  const origin = engine.syncState[session.id]?.importDirectory;
  const manifest = { version: 1, maxAttachmentBytes: cap, files: [], copied: 0, encrypted_original: 0, skipped: 0, missing: 0, warnings: [] };
  const file = path.join(directory, 'chatlab.json');
  const handle = await fs.promises.open(file + '.partial', 'wx');
  let count = 0;
  const copies = new Map();
  try {
    await handle.write('{"chatlab":' + JSON.stringify({ version: '0.0.2', exportedAt: Math.floor(Date.now() / 1000), generator: 'ChatScope 0.2.0' }) + ',"meta":' + JSON.stringify(meta) + ',"members":' + JSON.stringify(allMembers) + ',"messages":[');
    cursor = 0;
    while (true) {
      const rows = await engine.sql(session.id, `SELECT m.*,mb.platform_id,mb.account_name,mb.group_nickname FROM message m JOIN member mb ON m.sender_id=mb.id WHERE m.id>${cursor} ORDER BY m.id LIMIT 500`);
      if (!rows.length) break;
      for (const row of rows) {
        cursor = row.id;
        const msg = { sender: row.platform_id, accountName: row.sender_account_name || row.account_name || row.platform_id, timestamp: row.ts, type: row.type, content: row.content, ...(row.sender_group_nickname || row.group_nickname ? { groupNickname: row.sender_group_nickname || row.group_nickname } : {}), ...(row.platform_message_id ? { platformMessageId: row.platform_message_id } : {}), ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}) };
        if (MEDIA[row.type]) {
          const links = [...String(row.content || '').matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]);
          const attachments = [];
          for (const link of links) {
            let relative;
            try { relative = decodeURIComponent(link.replace(/^<|>$/g, '')); } catch { continue; }
            if (/^[a-z]+:|^[/\\]/i.test(relative)) continue;
            const source = origin && path.resolve(origin, relative);
            if (!source || !source.startsWith(path.resolve(origin) + path.sep)) continue;
            let record;
            try {
              const real = await fs.promises.realpath(source);
              const realOrigin = await fs.promises.realpath(origin);
              if (!real.startsWith(realOrigin + path.sep)) throw new Error('outside import directory');
              const stat = await fs.promises.stat(real);
              if (!stat.isFile()) continue;
              if (cap === 0 || stat.size > cap) record = { status: 'skipped', reason: 'over_limit', size: stat.size };
              else {
                const rel = 'attachments/' + MEDIA[row.type] + '/' + crypto.createHash('sha256').update(real).digest('hex').slice(0, 24) + path.extname(real).replace(/[^.a-zA-Z0-9]/g, '');
                const target = path.join(directory, rel);
                if (!copies.has(real)) {
                  await fs.promises.mkdir(path.dirname(target), { recursive: true });
                  await fs.promises.copyFile(real, target, fs.constants.COPYFILE_EXCL);
                  // Never leave a file exceeding the user's limit if it grew while copied.
                  if ((await fs.promises.stat(target)).size > cap) { await fs.promises.unlink(target); throw new Error('source changed'); }
                  copies.set(real, rel);
                }
                record = { status: path.extname(real).toLowerCase() === '.dat' ? 'encrypted_original' : 'copied', path: copies.get(real), size: stat.size };
                msg.content = String(msg.content || '').split(link).join(record.path);
              }
            } catch { record = { status: 'missing', reason: 'source_unavailable' }; }
            attachments.push(record);
          }
          if (!attachments.length) attachments.push({ status: cap === 0 ? 'skipped' : 'missing', reason: cap === 0 ? 'over_limit' : 'original_attachment_not_available' });
          for (const record of attachments) { manifest.files.push({ messageId: msg.platformMessageId || String(row.id), kind: MEDIA[row.type], ...record }); manifest[record.status]++; }
          msg.attachments = attachments;
        }
        await handle.write((count ? ',' : '') + JSON.stringify(msg));
        count++;
      }
      engine.notify('正在导出聊天 JSON…', { messages: count });
    }
    await handle.write(']}');
  } finally { await handle.close(); }
  await fs.promises.rename(file + '.partial', file);
  await fs.promises.writeFile(path.join(directory, 'export-manifest.json'), JSON.stringify(manifest, null, 2));
  return { file, messageCount: count, attachments: { copied: manifest.copied, encrypted_original: manifest.encrypted_original, skipped: manifest.skipped, missing: manifest.missing } };
}

module.exports = { exportImported };
