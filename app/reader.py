"""ChatScope Windows WeChat 4 reader. Only reads same-user processes and source DBs.

SQLCipher raw-key discovery follows the publicly documented WCDB cache format.
Keys stay in this worker's RAM; snapshots are ciphertext; export is selected-chat only.
"""
import ctypes
from ctypes import wintypes as wt
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import struct
import sys
import time
import heapq
from concurrent.futures import ThreadPoolExecutor, as_completed
import xml.etree.ElementTree as ET
import psutil
import zstandard
from sqlcipher3 import dbapi2 as sqlite
from media_export import AttachmentExporter

PAGE = 4096
KEY_PATTERN = re.compile(rb"x'([0-9a-fA-F]{64,192})'")
KEY_OBJECT = re.compile(rb"(.{8})\x00{8}\x20\x00{7}\x2f\x00{7}", re.DOTALL)
STATE = {"keys": {}, "root": None, "names": {}, "sessions": [], "cache": None}


class BLOB(ctypes.Structure):
    _fields_ = [("cbData", wt.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def protected_bytes(data, decrypt=False):
    """Windows DPAPI, current-user protection. No plaintext keys on disk."""
    buf = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source, output = BLOB(len(data), buf), BLOB()
    dll = ctypes.WinDLL("crypt32", use_last_error=True)
    fn = dll.CryptUnprotectData if decrypt else dll.CryptProtectData
    fn.argtypes = [ctypes.POINTER(BLOB), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wt.DWORD, ctypes.POINTER(BLOB)]
    fn.restype = wt.BOOL
    if not fn(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise OSError("DPAPI failed")
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        k = ctypes.WinDLL("kernel32")
        k.LocalFree.argtypes = [ctypes.c_void_p]
        k.LocalFree(ctypes.cast(output.pbData, ctypes.c_void_p))


def emit(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def progress(message, **fields):
    emit({"event": "progress", "message": message, **fields})


def processes():
    owner = psutil.Process().username().casefold()
    result = []
    for p in psutil.process_iter(["pid", "name", "username", "memory_info"]):
        try:
            if p.info["name"].casefold() in ("weixin.exe", "wechat.exe") and p.info["username"].casefold() == owner:
                result.append(p)
        except (psutil.Error, AttributeError):
            pass
    return sorted(result, key=lambda p: p.info["memory_info"].rss, reverse=True)


def discover(override=None):
    roots = [Path.home() / "Documents" / "xwechat_files"]
    if os.name == "nt":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as k:
                docs = Path(os.path.expandvars(winreg.QueryValueEx(k, "Personal")[0]))
                roots.append(docs / "xwechat_files")
        except OSError:
            pass
        ini = Path(os.environ.get("APPDATA", "")) / "Tencent" / "xwechat" / "config" / (hashlib.md5(b"KEY_LAST_XWEACHAT_FILE_DIR").hexdigest() + ".ini")
        if ini.is_file():
            raw = ini.read_bytes()
            value = raw.decode("utf-16" if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8-sig", "ignore").strip("\x00\r\n \"")
            if value.lower() in ("mydocument:", "mydocument", "documents"):
                roots.append(Path.home() / "Documents" / "xwechat_files")
            elif value:
                roots.extend([Path(value), Path(value) / "xwechat_files"])
    if override:
        roots.insert(0, Path(override))
    active_roots = set()
    for p in processes():
        try:
            for f in p.open_files():
                parts = Path(f.path).parts
                if "db_storage" in parts:
                    active_roots.add(str(Path(*parts[:parts.index("db_storage") + 1]).resolve()))
        except psutil.Error:
            pass
    roots.extend(Path(r) for r in active_roots)
    accounts = {}
    for base in roots:
        candidates = [base] if base.name == "db_storage" else [base / "db_storage"] + list(base.glob("*/db_storage")) if base.is_dir() else []
        for root in candidates:
            if root.is_dir() and any(root.rglob("session.db")):
                ident = str(root.resolve())
                accounts[ident] = {"id": ident, "name": root.parent.name, "active": ident in active_roots}
    return {"running": bool(processes()), "accounts": list(accounts.values())}


def key_valid(key, page):
    if len(page) != PAGE or len(key) != 32:
        return False
    mac_key = hashlib.pbkdf2_hmac("sha512", key, bytes(x ^ 0x3A for x in page[:16]), 2, 32)
    return hmac.compare_digest(hmac.new(mac_key, page[16:4032] + struct.pack("<I", 1), hashlib.sha512).digest(), page[-64:])


def relevant_files(root):
    return sorted(p for p in root.rglob("*.db") if p.name in ("session.db", "contact.db") or re.fullmatch(r"(?:message|media)_\d+\.db", p.name) or p.name == "message_resource.db")


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_void_p), ("AllocationBase", ctypes.c_void_p), ("AllocationProtect", wt.DWORD), ("PartitionId", wt.WORD), ("RegionSize", ctypes.c_size_t), ("State", wt.DWORD), ("Protect", wt.DWORD), ("Type", wt.DWORD)]


def scan_keys(root, timeout=180):
    files = relevant_files(root)
    targets = {}
    for p in files:
        with p.open("rb") as f:
            page = f.read(PAGE)
        if page[:16] != b"SQLite format 3\x00" and len(page) == PAGE:
            targets.setdefault(page[:16].hex(), page)
    keys = STATE["keys"]
    remaining = {s for s, p in targets.items() if not key_valid(keys.get(s, b""), p)}
    if not remaining:
        return
    if os.name != "nt" or not processes():
        raise RuntimeError("请先打开并登录 Windows 微信 4.x，然后点击重新连接。")
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
    k.OpenProcess.restype = wt.HANDLE
    k.VirtualQueryEx.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.POINTER(MBI), ctypes.c_size_t]
    k.VirtualQueryEx.restype = ctypes.c_size_t
    k.ReadProcessMemory.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    k.ReadProcessMemory.restype = wt.BOOL
    k.CloseHandle.argtypes = [wt.HANDLE]
    deadline = time.monotonic() + timeout
    candidates = set()
    masks = {bytes(32)}
    found_any = False
    readable = False
    for proc in processes():
        handle = k.OpenProcess(0x410, False, proc.pid)
        if not handle:
            continue
        readable = True
        try:
            # Some 4.x versions wrap the in-memory passphrase with a constant in
            # the loaded official module. Only its code section is inspected.
            try:
                import pefile
                dlls = {m.path for m in proc.memory_maps() if Path(m.path).name.casefold() == "weixin.dll"}
                instructions = re.compile(rb"\x48\xBA(.{8}).{3,8}?\x48\xBA(.{8}).{3,8}?\x48\xBA(.{8}).{3,8}?\x48\xBA(.{8}).{3,8}?\x48\x85\xC0", re.DOTALL)
                for dll in dlls:
                    pe = pefile.PE(dll, fast_load=True)
                    for section in pe.sections:
                        if section.Characteristics & 0x20000000:
                            for match in instructions.finditer(section.get_data()):
                                masks.add(b"".join(match.groups()))
                    pe.close()
            except (OSError, psutil.Error, ImportError):
                pass
            addr = 0
            mbi = MBI()
            last_status = 0
            while addr < 0x7FFFFFFFFFFF and time.monotonic() < deadline:
                if not k.VirtualQueryEx(handle, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
                    break
                base, size = int(mbi.BaseAddress or 0), mbi.RegionSize
                nxt = base + size
                if nxt <= addr:
                    break
                addr = nxt
                if mbi.State != 0x1000 or mbi.Protect & (0x100 | 0x01) or not mbi.Protect & 0xEE:
                    continue
                tail = b""
                for offset in range(0, size, 8 * 1024 * 1024):
                    if time.monotonic() >= deadline:
                        break
                    n = min(size - offset, 8 * 1024 * 1024)
                    buf, got = ctypes.create_string_buffer(n), ctypes.c_size_t()
                    k.ReadProcessMemory(handle, ctypes.c_void_p(base + offset), buf, n, ctypes.byref(got))
                    data = tail + buf.raw[:got.value]
                    for match in KEY_OBJECT.finditer(data):
                        pointer = struct.unpack("<Q", match.group(1))[0]
                        if 0x10000 <= pointer < 0x7FFFFFFFFFFF:
                            candidate, read = ctypes.create_string_buffer(32), ctypes.c_size_t()
                            if k.ReadProcessMemory(handle, ctypes.c_void_p(pointer), candidate, 32, ctypes.byref(read)) and read.value == 32:
                                raw_candidate = candidate.raw
                                if len(set(raw_candidate)) >= 15 and sum(32 <= x <= 126 for x in raw_candidate) <= 24:
                                    candidates.add(raw_candidate)
                    for match in KEY_PATTERN.finditer(data):
                        value = match.group(1)
                        if len(value) % 2:
                            continue
                        raw = bytes.fromhex(value[:64].decode("ascii"))
                        salts = [value[-32:].decode().lower()] if len(value) >= 96 else list(remaining)
                        for salt in salts:
                            if salt in remaining and key_valid(raw, targets[salt]):
                                keys[salt] = raw
                                remaining.remove(salt)
                                found_any = True
                    tail = data[-195:]
                    if not remaining:
                        return
                if time.monotonic() - last_status > 2:
                    progress("正在连接微信，验证本地数据库…", verified=len(targets) - len(remaining), databases=len(targets))
                    last_status = time.monotonic()
        except (OSError, psutil.Error):
            pass
        finally:
            k.CloseHandle(handle)
    if remaining and candidates:
        # Validate every candidate cryptographically, never accept a pattern
        # match alone. A validated passphrase is derived separately per DB salt.
        progress("正在验证微信版本对应的读取材料…", candidates=len(candidates))
        preferred = next(iter(remaining))
        for p in files:
            if p.name == "session.db":
                with p.open("rb") as f:
                    salt = f.read(16).hex()
                if salt in remaining:
                    preferred = salt
                    break
        page = targets[preferred]
        trial_masks = list(masks)[:16]
        def check(candidate):
            for mask in trial_masks:
                if time.monotonic() >= deadline:
                    return None
                password = bytes(a ^ b for a, b in zip(candidate, mask))
                derived = hashlib.pbkdf2_hmac("sha512", password, page[:16], 256000, 32)
                if key_valid(derived, page):
                    return password
            return None
        pool = ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 2))
        tasks = [pool.submit(check, candidate) for candidate in candidates]
        completed = 0
        try:
            for task in as_completed(tasks):
                completed += 1
                password = task.result()
                if password:
                    for salt in list(remaining):
                        derived = hashlib.pbkdf2_hmac("sha512", password, targets[salt][:16], 256000, 32)
                        if key_valid(derived, targets[salt]):
                            keys[salt] = derived
                            remaining.remove(salt)
                    found_any = True
                    break
                if completed % 100 == 0:
                    progress("正在验证本地数据库…", completed=completed, candidates=len(candidates))
        finally:
            for task in tasks:
                task.cancel()
            pool.shutdown(wait=True, cancel_futures=True)
    if not readable:
        raise RuntimeError("当前微信进程拒绝读取。请让微信和本软件使用相同的 Windows 用户与权限，再重新连接。")
    if not found_any and remaining:
        raise RuntimeError("尚未取得当前微信版本的数据库读取材料。请在微信里点开一段聊天后重试；本程序支持 Windows 微信 4.x 的 WCDB 缓存格式。")


def snapshot(source):
    root, cache = STATE["root"], STATE["cache"]
    rel = source.relative_to(root)
    out = cache / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    wal = Path(str(source) + "-wal")
    for attempt in range(3):
        stamp = [(p.stat().st_size, p.stat().st_mtime_ns) if p.exists() else None for p in (source, wal)]
        shutil.copyfile(source, out)
        if wal.exists():
            shutil.copyfile(wal, str(out) + "-wal")
        else:
            Path(str(out) + "-wal").unlink(missing_ok=True)
        Path(str(out) + "-shm").unlink(missing_ok=True)
        after = [(p.stat().st_size, p.stat().st_mtime_ns) if p.exists() else None for p in (source, wal)]
        if stamp == after:
            break
        if attempt == 2:
            raise RuntimeError("微信正在同步大量消息，请稍候再试。")
    with out.open("rb") as f:
        page = f.read(PAGE)
    con = sqlite.connect(out.as_uri() + "?mode=ro", uri=True)
    try:
        if page[:16] != b"SQLite format 3\x00":
            salt = page[:16].hex()
            raw = STATE["keys"].get(salt)
            if raw is None or not key_valid(raw, page):
                raise RuntimeError("部分数据库尚未加载。请在微信里点开所选聊天，然后重新连接。")
            con.execute('PRAGMA key = "x\'' + raw.hex() + salt + '\'"')
            con.execute("PRAGMA cipher_compatibility = 4")
        con.execute("PRAGMA query_only=ON")
        con.execute("SELECT count(*) FROM sqlite_master").fetchone()
        con.row_factory = sqlite.Row
        return con
    except Exception:
        con.close()
        raise


def text(value):
    if value is None:
        return ""
    if isinstance(value, bytes):
        try:
            if value[:4] == b"\x28\xb5\x2f\xfd":
                value = zstandard.ZstdDecompressor().decompress(value, max_output_size=16 * 1024 * 1024)
        except zstandard.ZstdError:
            return "[内容无法解码]"
        return value.decode("utf-8", "replace")
    return str(value)


def field(row, *names, default=None):
    for name in names:
        if name in row.keys() and row[name] is not None:
            return row[name]
    return default


def connect(account, cache):
    accounts = discover()
    root = Path(account)
    if not root.is_dir() or root.name != "db_storage":
        raise RuntimeError("找不到微信数据库目录，请在连接设置里选择 xwechat_files 文件夹。")
    STATE.update(root=root.resolve(), cache=Path(cache).resolve() / hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:16], names={}, sessions=[])
    STATE["cache"].mkdir(parents=True, exist_ok=True)
    key_file = STATE["cache"] / "protected-keys.bin"
    if os.name == "nt" and key_file.is_file():
        try:
            saved = json.loads(protected_bytes(key_file.read_bytes(), decrypt=True))
            STATE["keys"].update({s: bytes.fromhex(k) for s, k in saved.items()})
        except (OSError, ValueError):
            pass
    progress("正在定位并读取微信会话…")
    scan_keys(STATE["root"])
    if os.name == "nt" and STATE["keys"]:
        key_file.write_bytes(protected_bytes(json.dumps({s: k.hex() for s, k in STATE["keys"].items()}).encode()))
    contact = next(iter(root.rglob("contact.db")), None)
    if contact:
        try:
            con = snapshot(contact)
            try:
                for row in con.execute('SELECT * FROM "contact"'):
                    user = text(field(row, "username", "user_name"))
                    STATE["names"][user] = text(field(row, "remark", "remark_name")) or text(field(row, "nick_name", "nickname")) or user
            finally:
                con.close()
        except RuntimeError:
            progress("联系人名称尚未全部加载，将先显示会话标识。")
    session = next(iter(root.rglob("session.db")), None)
    if session is None:
        raise RuntimeError("没有找到会话数据库，请确认微信已登录且电脑上有聊天记录。")
    con = snapshot(session)
    try:
        tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        table = next((t for t in tables if t.casefold() == "sessiontable"), None)
        if not table:
            raise RuntimeError("当前微信会话表结构尚未适配。")
        sessions = []
        for row in con.execute('SELECT * FROM "' + table + '"'):
            user = text(field(row, "username", "user_name"))
            if not user:
                continue
            sessions.append({"id": user, "name": STATE["names"].get(user, user), "type": "group" if user.endswith("@chatroom") else "private", "lastTimestamp": int(field(row, "last_timestamp", "sort_timestamp", "last_time", default=0)), "source": "wechat"})
        sessions.sort(key=lambda s: s["lastTimestamp"], reverse=True)
        STATE["sessions"] = sessions
        return {"sessions": sessions, "account": root.parent.name, "verifiedDatabases": len(STATE["keys"])}
    finally:
        con.close()


def normalize(row, names, owner, session, shard, media=None):
    local_type = int(field(row, "local_type", "type", default=1)) & 0xFFFFFFFF
    raw_content = text(field(row, "message_content", "WCDB_CT_message_content", "content"))
    content = raw_content
    compressed = field(row, "compress_content", "WCDB_CT_compress_content")
    if compressed:
        content = text(compressed) or content
    raw_content = content
    sender = text(field(row, "sender_username")) or names.get(int(field(row, "real_sender_id", default=0)), "")
    prefix = re.match(r"^([^\s:]{1,128}):\n", content)
    if session.endswith("@chatroom") and prefix:
        sender = sender or prefix.group(1)
        content = content[prefix.end():]
    is_send = field(row, "is_send")
    if not sender:
        sender = owner if is_send == 1 else session if not session.endswith("@chatroom") else "unknown"
    msg_type = {1: 0, 3: 1, 34: 2, 43: 3, 47: 5, 48: 8, 50: 23, 10000: 80, 10002: 81}.get(local_type, 99)
    if local_type == 49:
        msg_type = 7
        try:
            xml = ET.fromstring(content)
            sub = int(xml.findtext(".//appmsg/type", "0"))
            msg_type = {6: 4, 57: 25, 2000: 21, 2001: 20, 19: 26}.get(sub, 7)
            content = xml.findtext(".//appmsg/title") or "[链接或分享]"
        except (ValueError, ET.ParseError):
            content = "[链接或分享]"
    elif local_type not in (1, 10000, 10002):
        content = {3: "[图片]", 34: "[语音]", 43: "[视频]", 47: "[表情]", 48: "[位置]", 50: "[通话]"}.get(local_type, "[其他消息]")
    ts = int(field(row, "create_time", "timestamp", default=0))
    server = field(row, "server_id", "msg_svr_id", default=0)
    local = int(field(row, "local_id", default=0))
    uid = str(server) if server and str(server) != "0" else f"{shard}:{local}:{ts}:{sender}"
    message = {"sender": sender, "accountName": STATE["names"].get(sender, "我" if sender == owner else sender), "timestamp": ts, "type": msg_type, "content": content, "platformMessageId": uid}
    if media:
        attachments = media.for_message(row, raw_content, message)
        if attachments:
            message["attachments"] = attachments
            links = ["[附件](" + item["path"] + ")" for item in attachments if item.get("path")]
            if links:
                message["content"] += "\n" + " ".join(links)
    return message



def export_chat(session_id, output, attachment_root=None, max_attachment_bytes=50 * 1024 * 1024, format="jsonl"):
    if format not in ("json", "jsonl"):
        raise ValueError("仅支持 JSON 或 JSONL 导出。")
    if STATE["root"] is None or not any(s["id"] == session_id for s in STATE["sessions"]):
        raise RuntimeError("请先连接微信并选择一个会话。")
    root = STATE["root"]
    owner = re.sub(r"_[0-9a-fA-F]{4}$", "", root.parent.name)
    entry = next(s for s in STATE["sessions"] if s["id"] == session_id)
    table = "Msg_" + hashlib.md5(session_id.encode()).hexdigest()
    files = [p for p in relevant_files(root) if re.fullmatch(r"message_\d+\.db", p.name)]
    missing = []
    media = AttachmentExporter(root, attachment_root, max_attachment_bytes, session_id, snapshot, progress) if attachment_root else None
    conns, iterators, members = [], [], {}
    progress("正在准备所选聊天，自动导入分析引擎…")
    try:
        for source in files:
            with source.open("rb") as f:
                page = f.read(PAGE)
            if page[:16] != b"SQLite format 3\x00" and page[:16].hex() not in STATE["keys"]:
                missing.append(source.name)
                continue
            con = snapshot(source)
            conns.append(con)
            found = con.execute("SELECT name FROM sqlite_master WHERE lower(name)=lower(?)", (table,)).fetchone()
            if not found:
                continue
            mapping = {int(r[0]): str(r[1]) for r in con.execute("SELECT rowid, user_name FROM Name2Id")}
            rows = con.execute('SELECT * FROM "' + found[0] + '" ORDER BY create_time, local_id')
            def messages(cursor=rows, names=mapping, shard=source.stem):
                for row in cursor:
                    yield normalize(row, names, owner, session_id, shard, media)
            iterators.append(messages())
        if missing:
            raise RuntimeError(f"有 {len(missing)} 个消息分库尚未加载，暂不能确认完整记录。请在微信里点开所选聊天，然后点击重新连接。")
        if not iterators:
            raise RuntimeError("所选会话暂无可读取的本地消息。请确认记录已同步到电脑。")
        path = Path(output).with_suffix(".jsonl.partial") if format == "json" else Path(output)
        path.parent.mkdir(parents=True, exist_ok=True)
        meta = {"name": entry["name"], "platform": "wechat", "type": entry["type"], "ownerId": owner}
        if entry["type"] == "group":
            meta["groupId"] = session_id
        count = 0
        with path.open("w", encoding="utf-8") as f:
            f.write(json.dumps({"_type": "header", "chatlab": {"version": "0.0.2", "exportedAt": int(time.time()), "generator": "ChatScope Windows Reader"}, "meta": meta}, ensure_ascii=False) + "\n")
            for msg in heapq.merge(*iterators, key=lambda m: m["timestamp"]):
                if msg["sender"] not in members:
                    members[msg["sender"]] = True
                    f.write(json.dumps({"_type": "member", "platformId": msg["sender"], "accountName": msg["accountName"]}, ensure_ascii=False) + "\n")
                f.write(json.dumps({"_type": "message", **msg}, ensure_ascii=False) + "\n")
                count += 1
                if count % 10000 == 0:
                    progress("正在读取所选聊天…", messages=count)
        if count == 0:
            path.unlink(missing_ok=True)
            raise RuntimeError("这个会话没有本地消息。")
        if format == "json":
            jsonl_to_json(path, Path(output))
            path.unlink()
            path = Path(output)
        media_counts = media.finish() if media else {}
        return {"file": str(path), "messageCount": count, "name": entry["name"], "attachments": media_counts}
    finally:
        if media:
            media.close()
        for con in conns:
            con.close()


def jsonl_to_json(source, destination):
    """Write standard ChatLab JSON without retaining all messages in memory."""
    members = {}
    with source.open(encoding="utf-8") as lines:
        header = json.loads(next(lines))
        for line in lines:
            item = json.loads(line)
            if item.get("_type") == "member":
                item.pop("_type", None)
                members[item["platformId"]] = item
    temporary = destination.with_suffix(destination.suffix + '.partial')
    with temporary.open("x", encoding="utf-8") as output, source.open(encoding="utf-8") as lines:
        output.write('{"chatlab":' + json.dumps(header["chatlab"], ensure_ascii=False) + ',"meta":' + json.dumps(header["meta"], ensure_ascii=False))
        output.write(',"members":' + json.dumps(list(members.values()), ensure_ascii=False) + ',"messages":[')
        first = True
        for line in lines:
            item = json.loads(line)
            if item.get("_type") != "message":
                continue
            item.pop("_type", None)
            if not first:
                output.write(',')
            output.write(json.dumps(item, ensure_ascii=False))
            first = False
        output.write(']}')
    temporary.replace(destination)


def serve():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stdin.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        req = {}
        try:
            req = json.loads(line)
            action = req["action"]
            if action == "discover":
                result = discover(req.get("directory"))
            elif action == "connect":
                result = connect(req["account"], req["cache"])
            elif action == "export":
                result = export_chat(req["session"], req["output"], req.get("attachmentRoot"), req.get("maxAttachmentBytes", 50 * 1024 * 1024), req.get("format", "jsonl"))
            else:
                raise ValueError("未知操作")
            emit({"id": req.get("id"), "success": True, "data": result})
        except Exception as exc:
            # Do not print paths, keys, memory, message content, or library SQL.
            msg = str(exc) if isinstance(exc, (RuntimeError, ValueError)) else f"读取失败（{type(exc).__name__}），请重新连接或反馈当前微信版本。"
            emit({"id": req.get("id"), "success": False, "error": msg})


if __name__ == "__main__":
    serve()
