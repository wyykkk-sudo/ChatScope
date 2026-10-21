"""Pack only explicit deliverable / source allowlists, never runtime user data."""
from pathlib import Path
import hashlib, json, zipfile, subprocess
root=Path(__file__).resolve().parent
outputs=root.parent/'outputs'
app=outputs/'ChatScope'
# The user may already be running the portable app. Preserve that data locally,
# and ship only the explicit application / runtime distribution entries.
allowed={p.name for p in (root/'runtime/node_modules/electron/dist').iterdir() if p.name!='electron.exe'}
allowed.update({'ChatScope.exe','licenses','README.md','THIRD-PARTY-NOTICES.md','LICENSE.electron.txt'})
assert (app/'ChatScope.exe').is_file() and (app/'resources/app.asar').is_file()
assert (app/'licenses/Node-LICENSE.txt').is_file()
subprocess.run(['git','-C',str(root/'chatlab-upstream'),'archive','--format=zip','--prefix=chatlab-upstream/','-o',str(root/'chatlab-release-source.zip'),'v0.37.5'],check=True)
source=outputs/'ChatScope-source.zip'
with zipfile.ZipFile(source,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    if (root/'publish-readme.md').is_file():
        z.write(root/'publish-readme.md','README.md')
        z.write(root/'readme-banner.svg','docs/assets/banner.svg')
        z.write(outputs/'ChatScope-preview.png','docs/assets/analysis.png')
        z.write(outputs/'ChatScope-question-preview.png','docs/assets/conversation.png')
        z.write(root/'chatscope-src/BUILD.md','docs/DEVELOPMENT.md')
        z.write(root/'chatscope-src/THIRD-PARTY-NOTICES.md','THIRD-PARTY-NOTICES.md')
        z.write(root/'chatscope-src/LICENSE','LICENSE')
    for p in (root/'chatscope-src').rglob('*'):
        if p.is_file() and '__pycache__' not in p.parts:
            z.write(p, 'app/'+str(p.relative_to(root/'chatscope-src')))
    scripts=['test_reader.py','test_engine.cjs','test_portable.cjs','qa_ui.cjs','qa_packaged.cjs','package.cjs','finalize_package.py','unpack_electron.py']
    for name in scripts: z.write(root/name, 'scripts/'+name)
    for folder in ['runtime','ship-runtime','markdown-runtime']:
        for name in ['package.json','package-lock.json']:
            if (root/folder/name).is_file(): z.write(root/folder/name,'locks/'+folder+'/'+name)
    with zipfile.ZipFile(root/'chatlab-release-source.zip') as upstream:
        for info in upstream.infolist():
            if not info.is_dir(): z.writestr(info.filename,upstream.read(info))
portable=outputs/'ChatScope-Windows-x64.zip'
with zipfile.ZipFile(portable,'w',zipfile.ZIP_DEFLATED,compresslevel=5) as z:
    for p in app.rglob('*'):
        rel=p.relative_to(app)
        if p.is_file() and rel.parts[0] in allowed:
            assert 'protected-keys.bin' not in rel.parts
            z.write(p,'ChatScope/'+str(rel))
with zipfile.ZipFile(portable) as z:
    assert not any(n.startswith('ChatScope/data/') for n in z.namelist())
report={'application':'ChatScope 0.2.0','platform':'Windows x64','chatlab':'0.37.5','electron':'39.2.7','node':'24.16.0','python':'3.12.10','markdown':{'marked':'18.1.1','dompurify':'3.4.17'},'tests':{}}
for name in ['engine-test-result.json','ui-test-result.json','portable-test-result.json','packaged-window-test-result.json']:
    report['tests'][name]=json.loads((root/name).read_text())
report['cloudModelTested']=False
report['privateDataBundled']=False
report['artifacts']={p.name:{'bytes':p.stat().st_size,'sha256':hashlib.file_digest(p.open('rb'),'sha256').hexdigest()} for p in [portable,source]}
(outputs/'验证结果.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({p.name:round(p.stat().st_size/1024/1024,1) for p in [portable,source]},ensure_ascii=False))
