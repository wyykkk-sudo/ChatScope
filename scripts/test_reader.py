"""Reader contract tests with generated encrypted databases; no personal messages."""
import hashlib, importlib.util, json, os
from pathlib import Path
import zstandard
from sqlcipher3 import dbapi2 as sql

base = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('reader', base / 'chatscope-src' / 'reader.py')
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
root = base / 'qa-reader' / ('fixture_' + os.urandom(4).hex()) / 'wxid_fixture_abcd' / 'db_storage'
root.mkdir(parents=True)
connections = []
keys = {}
def database(folder, name, statements):
    p = root / folder / name; p.parent.mkdir(parents=True, exist_ok=True)
    key = os.urandom(32)
    con = sql.connect(str(p))
    con.execute('PRAGMA key = "x\'' + key.hex() + '\'"')
    con.execute('PRAGMA cipher_compatibility=4')
    for statement, args in statements:
        con.execute(statement, args)
    con.commit()
    page = p.read_bytes()[:4096]
    assert r.key_valid(key, page) and not r.key_valid(bytes(32), page)
    keys[page[:16].hex()] = key
    con.execute('PRAGMA journal_mode=WAL'); con.execute('PRAGMA wal_autocheckpoint=0')
    connections.append(con)
    return con

group, private = 'fixture_group@chatroom', 'wxid_friend'
database('session', 'session.db', [('CREATE TABLE SessionTable(username TEXT,last_timestamp INTEGER)', ()), ('INSERT INTO SessionTable VALUES(?,?)', (group, 1800000001)), ('INSERT INTO SessionTable VALUES(?,?)', (private, 1800000000))])
database('contact', 'contact.db', [('CREATE TABLE contact(username TEXT,remark TEXT,nick_name TEXT)', ()), ('INSERT INTO contact VALUES(?,?,?)', (group, '测试群（虚构）', '')), ('INSERT INTO contact VALUES(?,?,?)', (private, '', '测试好友')), ('INSERT INTO contact VALUES(?,?,?)', ('wxid_fixture', '', '我'))])
gtable = 'Msg_' + hashlib.md5(group.encode()).hexdigest()
ptable = 'Msg_' + hashlib.md5(private.encode()).hexdigest()
def shard(number):
    return database('message', f'message_{number}.db', [('CREATE TABLE Name2Id(user_name TEXT)', ()), ('INSERT INTO Name2Id VALUES(?)', ('wxid_fixture',)), ('INSERT INTO Name2Id VALUES(?)', (private,)), (f'CREATE TABLE {gtable}(local_id INTEGER,server_id INTEGER,local_type INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content,compress_content)', ()), (f'CREATE TABLE {ptable}(local_id INTEGER,server_id INTEGER,local_type INTEGER,real_sender_id INTEGER,create_time INTEGER,message_content,compress_content)', ())])
c0, c1 = shard(0), shard(1)
# Committed but still in encrypted WAL: reader must include it.
c0.execute(f'INSERT INTO {gtable} VALUES(?,?,?,?,?,?,?)', (1, 9223372036854775001, 1, 2, 1800000000, zstandard.ZstdCompressor().compress('wxid_friend:\n周五核对待办'.encode()), None))
c0.execute(f'INSERT INTO {ptable} VALUES(?,?,?,?,?,?,?)', (1, 9223372036854775002, 1, 1, 1800000000, '我的消息', None)); c0.commit()
c1.execute(f'INSERT INTO {gtable} VALUES(?,?,?,?,?,?,?)', (1, 9223372036854775003, 49, 1, 1800000001, '<msg><appmsg><type>57</type><title>回复收到</title></appmsg></msg>', None)); c1.commit()
before = {str(p): hashlib.sha256(p.read_bytes()).digest() for p in root.rglob('*') if p.is_file() and (p.suffix == '.db' or p.name.endswith('-wal'))}
r.STATE['keys'] = keys
data = r.connect(str(root), str(base / 'qa-reader-cache'))
assert len(data['sessions']) == 2 and data['sessions'][0]['name'] == '测试群（虚构）'
out = base / 'qa-reader' / 'selected-group.jsonl'
result = r.export_chat(group, str(out))
records = [json.loads(line) for line in out.read_text(encoding='utf-8').splitlines()]
messages = [v for v in records if v['_type'] == 'message']
assert result['messageCount'] == 2
assert messages[0]['content'] == '周五核对待办' and messages[0]['sender'] == private
assert messages[0]['platformMessageId'] == '9223372036854775001'
assert messages[1]['type'] == 25 and messages[1]['content'] == '回复收到'
assert '我的消息' not in out.read_text(encoding='utf-8')
assert all(hashlib.sha256(Path(p).read_bytes()).digest() == digest for p, digest in before.items())
secret = b'fixture key material'; assert r.protected_bytes(r.protected_bytes(secret), decrypt=True) == secret
print('PASS: encrypted SQLCipher4 and WAL, per-database keys, Zstandard, group sender, selected-only export, 64-bit IDs, source files unchanged, Windows DPAPI')
for con in connections: con.close()
