const fs=require('node:fs'), path=require('node:path'), assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const net=require('node:net');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});
 const child=spawn(process.env.CHATSCOPE_QA_EXE || path.resolve(__dirname,'../outputs/ChatScope/ChatScope.exe'),[`--remote-debugging-port=${port}`],{windowsHide:true,stdio:'ignore',env:{...process.env,CHATSCOPE_QA:'1',CHATSCOPE_QA_FILE:path.join(__dirname,'chatscope-src/demo/group.json'),CHATSCOPE_DATA:process.env.CHATSCOPE_QA_DATA || path.join(__dirname,'qa-packed-window')}});
 let socket;
 try{
  let target;
  for(let i=0;i<150;i++){try{target=(await(await fetch(`http://127.0.0.1:${port}/json`)).json()).find(x=>x.type==='page'&&x.url.includes('app.asar'));if(target)break}catch{}await wait(150)}
  assert.ok(target,'actual app.asar window opens');
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>socket.addEventListener('open',r,{once:true}));
  let seq=0;const pending=new Map();
  socket.addEventListener('message',e=>{const item=JSON.parse(e.data);if(item.id){const job=pending.get(item.id);if(job){pending.delete(item.id);item.error?job.reject(new Error(item.error.message)):job.resolve(item.result)}}});
  const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});
  const run=async expression=>(await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
  let ready=false;for(let i=0;i<150;i++){if(await run("document.querySelectorAll('.session').length>0")){ready=true;break}await wait(150)}assert.ok(ready,'demo imported using shipped runtime');
  await run("document.querySelector('.session').click()");
  let stats=false;for(let i=0;i<150;i++){if(await run("document.getElementById('metric-total').textContent==='912'")){stats=true;break}await wait(150)}assert.ok(stats);
  assert.equal(await run("document.getElementById('metric-members').textContent"),'4');
  const markdown=await run("(() => {const n=renderChatMarkdown('## Title\\n\\n**Bold**\\n\\n| A | B |\\n|---|---|\\n| 1 | 2 |\\n\\n[x](javascript:alert(1))',[],{cite(){},copy:async()=>{},openExternal(){}});return !!n.querySelector('h2')&&!!n.querySelector('strong')&&!!n.querySelector('table')&&!n.querySelector('a');})()");
  assert.equal(markdown,true);
  fs.writeFileSync(path.join(__dirname,'packaged-window-test-result.json'),JSON.stringify({passed:true,archiveLoaded:true,count:912,members:4,markdownBundled:true}));
  console.log('PASS: actual portable ChatScope.exe loads archived application, imports with bundled engine and renders correct statistics.');
  await command('Page.close');
 }finally{socket?.close();await wait(400);if(child.exitCode===null)child.kill()}
})().catch(e=>{console.error(e);process.exitCode=1});
