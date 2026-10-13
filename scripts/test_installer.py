from pathlib import Path
import os, subprocess, hashlib, json, time
root=Path(__file__).resolve().parent
installer=root.parent/'outputs/ChatScope-Setup-0.1.1-x64.exe'
destination=(root/'qa-installed-app').resolve()
workspace=root.resolve()
assert destination.is_relative_to(workspace) and destination != workspace
assert not destination.exists(), 'Do not overwrite an existing installation during QA.'
args=[str(installer),'/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/QAINSTALL=1','/NOICONS','/TASKS=',f'/DIR={destination}',f'/LOG={root / "qa-install.log"}']
r=subprocess.run(args,timeout=180,creationflags=subprocess.CREATE_NO_WINDOW)
assert r.returncode==0, 'Installer did not complete successfully'
payload=root/'installer-payload/ChatScope'
for rel in ['ChatScope.exe','resources/app.asar','resources/chatscope-runtime/node.exe','resources/chatscope-runtime/reader/ChatScopeReader.exe']:
    actual=destination/rel
    assert actual.is_file()
    assert hashlib.file_digest(actual.open('rb'),'sha256').digest()==hashlib.file_digest((payload/rel).open('rb'),'sha256').digest()
env={**os.environ,'CHATSCOPE_QA_EXE':str(destination/'ChatScope.exe'),'CHATSCOPE_QA_DATA':str(destination/'data')}
r=subprocess.run(['node',str(root/'qa_packaged.cjs')],env=env,timeout=90,capture_output=True,text=True)
assert r.returncode==0, r.stderr
data=destination/'data'
data.mkdir(exist_ok=True)
sentinel=data/'preserve-user-data.txt'; sentinel.write_text('Synthetic uninstall preservation fixture',encoding='utf-8')
time.sleep(1)
r=subprocess.run([str(destination/'unins000.exe'),'/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',f'/LOG={root / "qa-uninstall.log"}'],timeout=120,creationflags=subprocess.CREATE_NO_WINDOW)
assert r.returncode==0, 'Uninstall failed'
assert not (destination/'ChatScope.exe').exists()
assert sentinel.read_text(encoding='utf-8')=='Synthetic uninstall preservation fixture'
assert (data/'chatlab').is_dir()
report={'passed':True,'installerVersion':'0.1.1','installerCompiler':'Inno Setup 7.1.0 x64','payloadMatchesRelease':True,'installedAppLaunches':True,'chatlabImportAndStatistics':True,'markdownRenders':True,'uninstallRemovesProgram':True,'uninstallPreservesData':True,'testData':'fictional records and isolated install directory','bytes':installer.stat().st_size,'sha256':hashlib.file_digest(installer.open('rb'),'sha256').hexdigest()}
(root.parent/'outputs/安装包验证结果.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
