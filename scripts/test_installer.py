from pathlib import Path
import os, subprocess, hashlib, json, time
root=Path(__file__).resolve().parent
installer=root.parent/'outputs/ChatScope-Setup-0.2.0-x64.exe'
destination=(root/('qa-installed-app-020-' + os.urandom(4).hex())).resolve()
workspace=root.resolve()
assert destination.is_relative_to(workspace) and destination != workspace
assert not destination.exists(), 'Do not overwrite an existing installation during QA.'
args=[str(installer),'/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/QAINSTALL=1','/NOICONS','/TASKS=',f'/DIR={destination}',f'/LOG={root / "qa-install.log"}']
previous=root.parent/'outputs/ChatScope-Setup-0.1.2-x64.exe'
upgrade_test=previous.is_file()
if upgrade_test:
    r=subprocess.run([str(previous),*args[1:]],timeout=180,creationflags=subprocess.CREATE_NO_WINDOW)
    assert r.returncode==0
    # All fixtures are synthetic. Simulate an existing user's configuration and data.
    old_data=destination/'data';old_data.mkdir(exist_ok=True)
    sentinel=old_data/'upgrade-preserve.txt';sentinel.write_text('Synthetic existing data',encoding='utf-8')
    settings=old_data/'settings.json';settings.write_text(json.dumps({'endpoint':'http://127.0.0.1:11434/v1','model':'synthetic-upgrade-model','redact':True,'cloudAllowed':False}),encoding='utf-8')
    before=settings.read_bytes()
r=subprocess.run(args,timeout=180,creationflags=subprocess.CREATE_NO_WINDOW)
assert r.returncode==0, 'Installer did not complete successfully'
if upgrade_test:
    assert sentinel.read_text(encoding='utf-8')=='Synthetic existing data'
    assert settings.read_bytes()==before, 'Upgrade must preserve existing model configuration'
payload=root/'portable-020'
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
report={'passed':True,'installerVersion':'0.2.0','installerCompiler':'Inno Setup 7.1.0 x64','payloadMatchesRelease':True,'installedAppLaunches':True,'chatlabImportAndStatistics':True,'markdownRenders':True,'uninstallRemovesProgram':True,'uninstallPreservesData':True,'testData':'fictional records and isolated install directory','bytes':installer.stat().st_size,'sha256':hashlib.file_digest(installer.open('rb'),'sha256').hexdigest()}
report['upgradeFrom012PreservesDataAndSettings']=upgrade_test
report['dsmlUIRegression']=json.loads((root/'packaged-window-test-result.json').read_text())
(root.parent/'outputs/安装包验证结果.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
