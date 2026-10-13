import hashlib, json, os, zipfile
from pathlib import Path
root=Path(__file__).resolve().parent
package=root/'runtime/node_modules/electron'
name='electron-v39.2.7-win32-x64.zip'
archive=next((Path(os.environ['LOCALAPPDATA'])/'electron/Cache').rglob(name))
expected=json.loads((package/'checksums.json').read_text())[name]
assert hashlib.sha256(archive.read_bytes()).hexdigest()==expected
with zipfile.ZipFile(archive) as z: z.extractall(package/'dist')
(package/'path.txt').write_text('electron.exe')
print('Verified official Electron checksum and extracted Windows runtime.')
