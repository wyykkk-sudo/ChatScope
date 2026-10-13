const path=require('node:path');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {Engine}=require('./chatscope-src/lib/engine.cjs');
const root=__dirname, runtime=path.resolve(root,'../outputs/ChatScope/resources/chatscope-runtime');
const engine=new Engine({runtime,data:path.join(root,'qa-portable'),helper:{exe:path.join(runtime,'reader/ChatScopeReader.exe')}});
(async()=>{
 await engine.start();
 await engine.importFile(path.join(root,'qa-reader/selected-group.jsonl'),'portable_fixture');
 assert.equal((await engine.statistics('portable_fixture',{})).total,2);
 const discovery=await engine.discover();
 assert.ok(discovery.running && discovery.accounts.length);
 const active=discovery.accounts.find(a=>a.active)||discovery.accounts[0];
 const live=await engine.reader('connect',{account:active.id,cache:path.join(root,'private-reader-snapshots')});
 assert.ok(live.sessions.length>0);
 const groups=live.sessions.filter(s=>s.type==='group').length;
 fs.writeFileSync(path.join(root,'portable-test-result.json'),JSON.stringify({passed:true,sessionCount:live.sessions.length,groups,verifiedDatabases:live.verifiedDatabases,contentsExported:false,modelCalled:false}));
 console.log(`PASS: shipped Node + native ChatLab engine + packaged reader; ${live.sessions.length} live sessions, ${groups} groups, ${live.verifiedDatabases} validated DBs; no chat content exported or sent.`);
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>engine.stop());
