const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {spawnSync, spawn} = require('node:child_process')
const vm = require('node:vm')
const script = path.join(__dirname,'../bin/notification-center')
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'foamy-integration-'))
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
 const source=path.join(dir,'source'),store=path.join(dir,'store')
 fs.mkdirSync(path.join(source,'history'),{recursive:true})
 const env={...process.env,NC_SRC_DIR:source,NC_SRC_HISTORY:path.join(source,'history'),NC_STORE:store,NC_PREVIEWS:'0'}
 const run=(...args)=>{const r=spawnSync(script,args,{env,encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)}
 return {dir,source,store,env,run}
}
test('replacement updates retain identity and images; repeated ingestion is idempotent',t=>{
 const f=fixture(t),stamp=Date.now(),key=`${stamp}-42`,file=path.join(f.source,key+'.json')
 const image=path.join(f.dir,'image.png')
 fs.writeFileSync(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMioAAAAASUVORK5CYII=','base64'))
 const entry={timestamp:stamp,originalId:42,app:'Download',desktopEntry:'download',summary:'Transfer',body:'10 percent',image}
 fs.writeFileSync(file,JSON.stringify(entry));f.run('sync')
 const retained=path.join(f.store,'images',key+'-image'),before=fs.statSync(retained,{bigint:true})
 entry.body='Download complete';fs.writeFileSync(file,JSON.stringify(entry));f.run('sync')
 const rows=f.run('list');assert.equal(rows.length,1);assert.equal(rows[0].body,entry.body);assert.equal(rows[0].desktopEntry,'download')
 assert.equal(fs.statSync(retained,{bigint:true}).mtimeNs,before.mtimeNs)
 const archive=fs.readFileSync(path.join(f.store,'archive.jsonl'),'utf8');f.run('sync');assert.equal(fs.readFileSync(path.join(f.store,'archive.jsonl'),'utf8'),archive)
 fs.unlinkSync(image);entry.body='Source removed';fs.writeFileSync(file,JSON.stringify(entry));f.run('sync');assert.equal(f.run('list')[0].image,rows[0].image);assert.ok(fs.existsSync(retained))
 f.run('remove',key);f.run('sync');assert.equal(f.run('list').length,0)
})
test('watcher announces replacements, external clear and removal, and remains quiet while idle',async t=>{
 const f=fixture(t),events=[],watch=spawn(script,['watch'],{env:f.env})
 let pending='';watch.stdout.on('data',chunk=>{pending+=chunk;let n;while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);events.push(JSON.parse(line))}})
 t.after(()=>watch.kill())
 async function until(fn) { const end=Date.now()+5000;while(!fn()){assert.ok(Date.now()<end,JSON.stringify(events));await new Promise(r=>setTimeout(r,25))} }
 await until(()=>events.some(e=>e.event==='storeChanged'));events.length=0
 const stamp=Date.now(),key=`${stamp}-1`,file=path.join(f.source,key+'.json')
 const entry={timestamp:stamp,app:'Test',summary:'Before'}
 fs.writeFileSync(file,JSON.stringify(entry));await until(()=>events.some(e=>e.summary==='Before'))
 entry.summary='After';fs.writeFileSync(file,JSON.stringify(entry));await until(()=>events.some(e=>e.summary==='After'))
 await new Promise(r=>setTimeout(r,150));events.length=0;f.run('remove',key);await until(()=>events.some(e=>e.event==='storeChanged'))
 events.length=0;f.run('clear');await until(()=>events.some(e=>e.event==='storeChanged'))
 await new Promise(r=>setTimeout(r,150));events.length=0;await new Promise(r=>setTimeout(r,200));assert.equal(events.length,0)
})
test('queued archive refreshes and content comparisons do not drop updates',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../Service.qml'),'utf8')
 const state=vm.createContext({entries:[{key:'1-1',body:'old'}],listLoadCount:0,loadPending:false,archiveRevision:2,listRevision:1,listProc:{running:true},storeCommand:a=>a,pageSize:500})
 state.root=state
 for(const name of ['load','differsFrom']) {const start=source.indexOf(`  function ${name}(`);vm.runInContext(source.slice(start,source.indexOf('\n  }',start)+4),state)}
 assert.equal(state.differsFrom([{key:'1-1',body:'new'}]),true)
 state.load();assert.equal(state.loadPending,true);state.listProc.running=false;state.load();assert.equal(state.listRevision,2);assert.equal(state.loadPending,false)
})
