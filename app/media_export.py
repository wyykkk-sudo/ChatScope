"""Local attachment export. No network requests, shell execution or source writes."""
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import xml.etree.ElementTree as ET

HASH = re.compile(r"(?<![a-zA-Z0-9])[a-fA-F0-9]{32}(?![a-zA-Z0-9])")
MEDIA_TYPES = {1: 'images', 2: 'voice', 3: 'videos', 4: 'files', 5: 'emoji'}
SIGNATURES = [(b'\xff\xd8\xff', '.jpg'), (b'\x89PNG\r\n\x1a\n', '.png'), (b'GIF87a', '.gif'), (b'GIF89a', '.gif'), (b'BM', '.bmp')]


def media_suffix(head):
    for signature, suffix in SIGNATURES:
        if head.startswith(signature):
            return suffix
    if head.startswith(b'RIFF') and head[8:12] == b'WEBP':
        return '.webp'
    if head.startswith(b'RIFF') and head[8:12] == b'WAVE':
        return '.wav'
    if head[4:8] == b'ftyp':
        return '.mp4'
    if b'#!SILK_V3' in head[:16]:
        return '.silk'
    if head.startswith(b'#!AMR'):
        return '.amr'
    return None


def extract_tokens(value):
    if isinstance(value, bytes):
        value = value.decode('utf-8', 'ignore')
    value = str(value or '')
    tokens = {match.group().lower() for match in HASH.finditer(value)}
    # Only media fields and hashes qualify; arbitrary message text cannot select files.
    start = value.find('<')
    try:
        xml = ET.fromstring(value[start:] if start >= 0 else value)
        for node in xml.iter():
            for name, candidate in [*node.attrib.items(), (node.tag, node.text or '')]:
                if name.lower() in {'filename', 'file_name', 'filepath', 'path', 'localpath', 'thumbpath', 'cdnthumburl', 'videomd5', 'md5', 'filemd5'}:
                    if not re.match(r'^[a-z]+://', candidate, re.I):
                        tokens.add(candidate.replace('\\', '/').rsplit('/', 1)[-1].lower())
    except (ET.ParseError, ValueError):
        pass
    return {token for token in tokens if token and token not in {'.', '..'}}


class AttachmentExporter:
    def __init__(self, root, destination, limit, session, snapshot, progress):
        self.root = Path(root).resolve()
        self.account = self.root.parent if self.root.name == 'db_storage' else self.root
        self.destination = Path(destination)
        self.destination.mkdir(parents=True, exist_ok=True)
        self.limit = int(limit)
        if not 0 <= self.limit <= 2 * 1024 ** 3:
            raise ValueError('附件上限需要在 0–2048 MB 之间。')
        self.session = session
        self.snapshot = snapshot
        self.progress = progress
        self.index = {}
        self.files = []
        self.cache = {}
        self.connections = []
        self.voice = []
        self.resources = {}
        self.warnings = []
        self.scan()
        self.open_media_databases()

    def scan(self):
        self.progress('正在定位当前账号的本地附件…')
        count = 0
        candidates = [self.account / name for name in ('msg', 'FileStorage', 'file', 'image', 'video', 'voice', 'emoji', 'emoticon', 'attach', 'media', 'cache')]
        for base in candidates:
            if not base.is_dir() or base.is_symlink():
                continue
            for directory, dirs, filenames in os.walk(base, followlinks=False):
                dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
                for name in filenames:
                    source = Path(directory) / name
                    if source.is_symlink() or source.suffix.lower() in {'.db', '.db-wal', '.db-shm', '.log', '.exe', '.dll'}:
                        continue
                    try:
                        resolved = source.resolve()
                        if not resolved.is_relative_to(self.account.resolve()) or not source.is_file():
                            continue
                    except OSError:
                        continue
                    count += 1
                    if count > 500000:
                        self.warnings.append('附件索引超过 500000 个文件，部分未索引。')
                        return
                    keys = {name.lower(), source.stem.lower(), re.sub(r'_(?:t|h|w)$', '', source.stem.lower())}
                    for key in keys:
                        self.index.setdefault(key, []).append(source)

    def open_media_databases(self):
        for source in sorted(self.root.rglob('*.db')):
            if not (re.fullmatch(r'media_\d+\.db', source.name) or source.name == 'message_resource.db'):
                continue
            con = None
            try:
                con = self.snapshot(source)
                if source.name == 'message_resource.db':
                    rows = con.execute('SELECT r.* FROM MessageResourceInfo r JOIN ChatName2Id c ON r.chat_id=c.rowid WHERE c.user_name=?', (self.session,))
                    for row in rows:
                        keys = row.keys()
                        lid = row['message_local_id']
                        ts = row['message_create_time'] if 'message_create_time' in keys else None
                        tokens = extract_tokens(row['packed_info'])
                        self.resources.setdefault((lid, ts), set()).update(tokens)
                else:
                    chat = con.execute('SELECT rowid FROM Name2Id WHERE user_name=?', (self.session,)).fetchone()
                    if chat:
                        columns = {row[1] for row in con.execute('PRAGMA table_info(VoiceInfo)')}
                        if {'chat_name_id', 'local_id', 'create_time', 'voice_data'} <= columns:
                            self.voice.append((con, chat[0], columns))
                self.connections.append(con)
            except Exception:
                if con is not None:
                    con.close()
                self.warnings.append(f'{source.name} 暂不可读取；相关附件可能缺失。')

    def record(self, message_id, kind, status, **extra):
        result = {'messageId': str(message_id), 'kind': kind, 'status': status, **extra}
        self.files.append(result)
        return result

    def store(self, message_id, kind, identity, source=None, data=None, size=None):
        cache_key = (kind, str(identity))
        if cache_key in self.cache:
            original = self.cache[cache_key]
            return self.record(message_id, kind, original['status'], **{key: value for key, value in original.items() if key not in {'messageId', 'kind', 'status'}})
        if size is None:
            size = len(data) if data is not None else source.stat().st_size
        if self.limit == 0 or size > self.limit:
            result = self.record(message_id, kind, 'skipped', size=size, reason='over_limit')
            self.cache[cache_key] = result
            return result
        folder = self.destination / kind
        folder.mkdir(exist_ok=True)
        if source:
            with source.open('rb') as f:
                head = f.read(32)
        else:
            head = data[:32]
        suffix = media_suffix(head) or (source.suffix.lower() if source else '.silk') or '.bin'
        xor_key = None
        encrypted = False
        if source and source.suffix.lower() == '.dat' and not media_suffix(head):
            # Old DAT is one-byte XOR. Validate several header bytes before decoding.
            for signature, extension in SIGNATURES:
                key = head[0] ^ signature[0] if head else 0
                decoded_head = bytes(byte ^ key for byte in head)
                if extension == '.bmp' and not (len(decoded_head) >= 18 and decoded_head[6:10] == bytes(4) and int.from_bytes(decoded_head[14:18], 'little') in (12, 40, 52, 56, 108, 124)):
                    continue
                if len(head) >= len(signature) and decoded_head.startswith(signature):
                    xor_key, suffix = key, extension
                    break
            if xor_key is None:
                encrypted, suffix = True, '.dat'
        filename = hashlib.sha256(str(identity).encode()).hexdigest()[:24] + suffix
        target = folder / filename
        temporary = target.with_suffix(target.suffix + '.partial')
        try:
            total = 0
            with temporary.open('xb') as output:
                if data is not None:
                    output.write(data)
                    total = len(data)
                else:
                    with source.open('rb') as input_file:
                        while chunk := input_file.read(1024 * 1024):
                            total += len(chunk)
                            if total > self.limit:
                                raise OverflowError()
                            if xor_key is not None:
                                chunk = chunk.translate(bytes.maketrans(bytes(range(256)), bytes(i ^ xor_key for i in range(256))))
                            output.write(chunk)
            temporary.replace(target)
            result = self.record(message_id, kind, 'encrypted_original' if encrypted else 'copied', path='attachments/' + kind + '/' + filename, size=total, mime=mimetypes.guess_type(filename)[0] or 'application/octet-stream', playable=not encrypted and suffix != '.silk', **({'requiresCompatiblePlayer': True} if suffix == '.silk' else {}), **({'decoded': 'legacy_xor'} if xor_key is not None else {}))
        except (OSError, OverflowError) as error:
            temporary.unlink(missing_ok=True)
            result = self.record(message_id, kind, 'skipped', size=size, reason='over_limit' if isinstance(error, OverflowError) else 'copy_failed')
        self.cache[cache_key] = result
        return result

    def for_message(self, row, raw, message):
        kind = MEDIA_TYPES.get(message['type'])
        if not kind:
            return []
        mid = message['platformMessageId']
        lid = row['local_id'] if 'local_id' in row.keys() else 0
        ts = message['timestamp']
        tokens = extract_tokens(raw) | self.resources.get((lid, ts), set()) | self.resources.get((lid, None), set())
        for field in ('packed_info_data', 'packed_info', 'bytes_extra', 'WCDB_CT_packed_info_data'):
            if field in row.keys():
                tokens |= extract_tokens(row[field])
        if kind == 'voice':
            for con, chat_id, columns in self.voice:
                match = con.execute('SELECT rowid,length(voice_data) FROM VoiceInfo WHERE chat_name_id=? AND local_id=? AND create_time=?', (chat_id, lid, ts)).fetchone()
                if not match:
                    continue
                size = match[1] or 0
                if size > self.limit or not self.limit:
                    return [self.record(mid, kind, 'skipped', size=size, reason='over_limit')]
                blob = con.execute('SELECT voice_data FROM VoiceInfo WHERE rowid=?', (match[0],)).fetchone()[0]
                if blob:
                    return [self.store(mid, kind, 'voice:' + mid + ':' + str(ts), data=bytes(blob))]
        candidates = set()
        strong_tokens = {token for token in tokens if HASH.fullmatch(Path(token).stem)}
        for token in strong_tokens or tokens:
            candidates.update(self.index.get(token.lower(), []))
            candidates.update(self.index.get(Path(token).stem.lower(), []))
        if not candidates:
            return [self.record(mid, kind, 'missing', reason='not_on_device_or_unresolved')]
        # A simple filename is not unique across chats. Only resolve it within
        # this chat's attachment directory; content hashes can match account-wide.
        if not strong_tokens:
            chat_hash = hashlib.md5(self.session.encode()).hexdigest()
            candidates = {p for p in candidates if chat_hash in p.parts or self.session in p.parts}
            if len(candidates) != 1:
                return [self.record(mid, kind, 'missing', reason='ambiguous_or_unscoped_filename')]
        # The same attachment has thumbnail/HD variants. Pick an original, then HD.
        ranked = sorted(candidates, key=lambda p: (bool(re.search(r'_t$', p.stem, re.I)), not bool(re.search(r'_h$', p.stem, re.I)), p.name))
        selected = ranked[0]
        try:
            return [self.store(mid, kind, str(selected.resolve()), source=selected)]
        except OSError:
            return [self.record(mid, kind, 'missing', reason='source_unavailable')]

    def finish(self):
        report = {'version': 1, 'maxAttachmentBytes': self.limit, 'files': self.files, 'warnings': self.warnings}
        for status in ('copied', 'encrypted_original', 'skipped', 'missing'):
            report[status] = sum(item['status'] == status for item in self.files)
        (self.destination.parent / 'export-manifest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        return {key: report[key] for key in ('copied', 'encrypted_original', 'skipped', 'missing')}

    def close(self):
        for con in self.connections:
            con.close()
