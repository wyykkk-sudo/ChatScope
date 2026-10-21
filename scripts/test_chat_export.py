"""Synthetic native export tests. Uses encrypted SQLite/WAL, never live chats."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from sqlcipher3 import dbapi2 as sql

APP = Path(__file__).resolve().parents[1] / 'app'
WORK = Path(os.environ.get('CHATSCOPE_TEST_WORK', str(APP.parents[0] / 'work'))).resolve()
WORK.mkdir(exist_ok=True, parents=True)
sys.path.insert(0, str(APP))
spec = importlib.util.spec_from_file_location('native_reader', APP / 'reader.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
base = Path(tempfile.mkdtemp(prefix='export-fixture-', dir=WORK))
root = base / 'wxid_fixture_abcd' / 'db_storage'
root.mkdir(parents=True)
group, other = 'export_test@chatroom', 'other_test@chatroom'
connections, keys = [], {}

def database(folder, name, statements):
    p = root / folder / name
    p.parent.mkdir(parents=True, exist_ok=True)
    con = sql.connect(str(p))
    key = os.urandom(32)
    con.execute('PRAGMA key = "x\'' + key.hex() + '\'"')
    con.execute('PRAGMA cipher_compatibility=4')
    for statement, args in statements:
        con.execute(statement, args)
    con.commit()
    keys[p.read_bytes()[:16].hex()] = key
    con.execute('PRAGMA journal_mode=WAL')
    con.execute('PRAGMA wal_autocheckpoint=0')
    connections.append(con)
    return con

database('session', 'session.db', [('CREATE TABLE SessionTable(username TEXT,last_timestamp INTEGER)', ()), ('INSERT INTO SessionTable VALUES(?,?)', (group, 1800000012))])
database('contact', 'contact.db', [('CREATE TABLE contact(username TEXT,remark TEXT,nick_name TEXT)', ()), ('INSERT INTO contact VALUES(?,?,?)', (group, 'Export fixture', ''))])
table = 'Msg_' + hashlib.md5(group.encode()).hexdigest()
messages = database('message', 'message_0.db', [('CREATE TABLE Name2Id(user_name TEXT)', ()), ('INSERT INTO Name2Id VALUES(?)', ('wxid_friend',)), (f'CREATE TABLE {table}(local_id INTEGER,server_id INTEGER,local_type INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content TEXT)', ())])
voice = b'\x02#!SILK_V3' + b'SYNTHETIC_VOICE'
database('message', 'media_0.db', [('CREATE TABLE Name2Id(user_name TEXT)', ()), ('INSERT INTO Name2Id VALUES(?)', (other,)), ('INSERT INTO Name2Id VALUES(?)', (group,)), ('CREATE TABLE VoiceInfo(chat_name_id INTEGER,local_id INTEGER,create_time INTEGER,voice_data BLOB)', ()), ('INSERT INTO VoiceInfo VALUES(?,?,?,?)', (1, 4, 1800000004, b'WRONG_OTHER_CHAT')), ('INSERT INTO VoiceInfo VALUES(?,?,?,?)', (2, 4, 1800000004, voice))])
resource_hash = 'a' * 32
database('message', 'message_resource.db', [('CREATE TABLE ChatName2Id(user_name TEXT)', ()), ('INSERT INTO ChatName2Id VALUES(?)', (other,)), ('INSERT INTO ChatName2Id VALUES(?)', (group,)), ('CREATE TABLE MessageResourceInfo(chat_id INTEGER,message_local_id INTEGER,message_create_time INTEGER,packed_info BLOB)', ()), ('INSERT INTO MessageResourceInfo VALUES(?,?,?,?)', (2, 1, 1800000001, resource_hash.encode())), ('INSERT INTO MessageResourceInfo VALUES(?,?,?,?)', (1, 1, 1800000001, ('f' * 32).encode()))])
media = root.parent / 'msg' / 'attach' / hashlib.md5(group.encode()).hexdigest() / '2026-10'
media.mkdir(parents=True)
jpg = b'\xff\xd8\xff\xe0' + b'fixture-image'
(media / (resource_hash + '.dat')).write_bytes(bytes(v ^ 0x73 for v in jpg))
(media / ('b' * 32 + '.gif')).write_bytes(b'GIF89a' + b'fixture-emoji')
(media / ('c' * 32 + '.mp4')).write_bytes(b'\x00\x00\x00\x18ftyp' + b'fixture-video')
(media / ('d' * 32 + '.dat')).write_bytes(b'\x07\x08V2' + b'fixture-encrypted')
(media / ('e' * 32 + '.bin')).write_bytes(b'X' * 65)
(media / 'notes.txt').write_text('Synthetic document', encoding='utf-8')
(media / ('f' * 32 + '.jpg')).write_bytes(b'WRONG_OTHER_RESOURCE')
outsider = root.parent / 'msg' / 'attach' / 'another_chat'
outsider.mkdir()
(outsider / 'unscoped.txt').write_text('WRONG_OTHER_FILENAME')
raw = [(3, '<msg><img/></msg>'), (47, '<msg><emoji md5="' + 'b' * 32 + '"/></msg>'), (43, '<msg><videomsg md5="' + 'c' * 32 + '"/></msg>'), (34, '<msg><voicemsg/></msg>'), (3, '<msg><img md5="' + 'd' * 32 + '"/></msg>'), (49, '<msg><appmsg><type>6</type><title>notes.txt</title><filename>notes.txt</filename></appmsg></msg>'), (3, '<msg><img md5="' + 'e' * 32 + '"/></msg>'), (3, '<msg><img md5="' + '0' * 32 + '"/></msg>'), (3, '<msg><img md5="' + resource_hash + '"/></msg>'), (49, '<msg><appmsg><type>6</type><filename>unscoped.txt</filename></appmsg></msg>')]
for i, (kind, content) in enumerate(raw, 1):
    messages.execute(f'INSERT INTO {table} VALUES(?,?,?,?,?,?)', (i, 9223372036854775000 + i, kind, 1, 1800000000 + i, content))
messages.commit()
r.STATE['keys'] = keys
r.connect(str(root), str(base / 'snapshots'))
before = {p: hashlib.sha256(p.read_bytes()).digest() for p in root.parent.rglob('*') if p.is_file()}
out = base / 'export'
out.mkdir()
result = r.export_chat(group, str(out / 'chatlab.json'), str(out / 'attachments'), 64, 'json')
data = json.loads((out / 'chatlab.json').read_text(encoding='utf-8'))
assert result['messageCount'] == len(raw) == len(data['messages'])
assert data['chatlab']['version'] == '0.0.2' and data['meta']['groupId'] == group
assert data['messages'][0]['platformMessageId'] == '9223372036854775001'
a = [m['attachments'][0] for m in data['messages']]
assert a[0]['decoded'] == 'legacy_xor' and (out / a[0]['path']).read_bytes() == jpg
assert a[1]['path'].endswith('.gif') and a[2]['path'].endswith('.mp4')
assert (out / a[3]['path']).read_bytes() == voice and not a[3]['playable'] and a[3]['requiresCompatiblePlayer']
assert a[4]['status'] == 'encrypted_original' and not a[4]['playable']
assert a[5]['path'].endswith('.txt') and a[6]['status'] == 'skipped'
assert a[7]['status'] == 'missing' and a[8]['path'] == a[0]['path']
assert a[9]['status'] == 'missing'
assert not list(out.rglob('*.partial'))
assert all(p.stat().st_size <= 64 for p in (out / 'attachments').rglob('*') if p.is_file())
assert all(b'WRONG_OTHER' not in p.read_bytes() for p in (out / 'attachments').rglob('*') if p.is_file())
manifest = json.loads((out / 'export-manifest.json').read_text(encoding='utf-8'))
assert manifest['copied'] == 6 and manifest['encrypted_original'] == 1 and manifest['skipped'] == 1 and manifest['missing'] == 2
for cap in (0, 65):
    folder = base / f'cap-{cap}'
    folder.mkdir()
    r.export_chat(group, str(folder / 'chatlab.json'), str(folder / 'attachments'), cap, 'json')
    exported = json.loads((folder / 'chatlab.json').read_text(encoding='utf-8'))
    if cap == 0:
        assert not any(p.is_file() for p in (folder / 'attachments').rglob('*'))
    else:
        assert exported['messages'][6]['attachments'][0]['status'] == 'copied'
# Exercise the actual IPC dispatch contract, without touching process discovery.
oldin, oldout = sys.stdin, sys.stdout
class Stream(io.StringIO):
    def reconfigure(self, **kwargs): pass
ipc = base / 'ipc'
ipc.mkdir()
sys.stdin = Stream(json.dumps({'id': 17, 'action': 'export', 'session': group, 'output': str(ipc / 'chatlab.json'), 'format': 'json', 'attachmentRoot': str(ipc / 'attachments'), 'maxAttachmentBytes': 64}) + '\n')
sys.stdout = Stream()
try:
    r.serve()
    replies = [json.loads(line) for line in sys.stdout.getvalue().splitlines()]
    assert replies[-1]['id'] == 17 and replies[-1]['success']
    assert len(json.loads((ipc / 'chatlab.json').read_text(encoding='utf-8'))['messages']) == 10
finally:
    sys.stdin, sys.stdout = oldin, oldout
assert all(hashlib.sha256(p.read_bytes()).digest() == digest for p, digest in before.items())
for con in connections: con.close()
(WORK / 'chat-export-native-result.json').write_text(json.dumps({'passed': True, 'file': str(out / 'chatlab.json'), 'count': len(raw), 'encryptedWal': True, 'selectedChatIsolation': True, 'voiceDatabase': True, 'resourceDatabase': True, 'legacyDatDecoded': True, 'encryptedDatRetained': True, 'sizeBoundary': True, 'zeroLimit': True, 'ipcDispatch': True}), encoding='utf-8')
print('PASS: native ChatLab JSON, encrypted WAL, five attachment types, voice/resource scoping, size limits, deduplication, IPC and unchanged sources')
