const fs=require('node:fs');
const path=require('node:path');
const {createPackage}=require('./runtime/node_modules/@electron/asar/lib/asar.js');
const root=__dirname, src=path.join(root,'chatscope-src'), out=path.resolve(process.env.CHATSCOPE_PACKAGE_OUT || path.join(root,'../outputs/ChatScope'));
const cp=(a,b)=>fs.cpSync(a,b,{recursive:true});
(async()=>{
  if(fs.existsSync(path.join(out,'data'))) throw new Error('Choose a clean output directory; existing application data must be preserved.');
  fs.mkdirSync(out,{recursive:true});
  cp(path.join(root,'runtime/node_modules/electron/dist'),out);
  cp(path.join(root,'runtime/node_modules/electron/dist/LICENSE'),path.join(out,'LICENSE.electron.txt'));
  fs.renameSync(path.join(out,'electron.exe'),path.join(out,'ChatScope.exe'));
  const runtime=path.join(out,'resources/chatscope-runtime');
  cp(path.join(root,'ship-runtime'),runtime);
  cp(path.join(root,'runtime/node.exe'),path.join(runtime,'node.exe'));
  cp(process.env.CHATSCOPE_READER_BUILD || path.join(root,'reader-build/ChatScopeReader'),path.join(runtime,'reader'));
  for(const f of ['README.md','LICENSE','THIRD-PARTY-NOTICES.md']) cp(path.join(src,f),path.join(out,f));
  cp(path.join(root,'chatlab-upstream/LICENSE'),path.join(out,'licenses/ChatLab-AGPL-3.0.txt'));
  for(const name of fs.readdirSync(path.join(root,'python-libs'))){
    if(!name.endsWith('.dist-info'))continue;
    const dir=path.join(root,'python-libs',name);
    for(const f of fs.readdirSync(dir)) if(/licen[cs]e|copying|notice/i.test(f)) cp(path.join(dir,f),path.join(out,'licenses/python-components',name,f));
  }
  const stage=path.join(root,'app-stage');
  fs.cpSync(src,stage,{recursive:true,filter:p=>!p.split(path.sep).includes('__pycache__')});
  await createPackage(stage,path.join(out,'resources/app.asar'));
  fs.writeFileSync(path.resolve(root,'../outputs/使用说明.md'),fs.readFileSync(path.join(src,'README.md')));
  console.log('Portable folder prepared; no personal data or credentials included.');
})().catch(e=>{console.error(e);process.exitCode=1});
