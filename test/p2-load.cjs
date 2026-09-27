"use strict";
process.env.JWT_SECRET="p2-load-secret-2026-long-enough";
const assert=require("node:assert/strict");
const {database}=require("./database");
const {migrate}=require("../db");
const {createApp}=require("../server");
let db,server;
async function burst(base,count){
  const started=Date.now();
  const responses=await Promise.all(Array.from({length:count},()=>fetch(base+"/healthz").then(async r=>({status:r.status,body:await r.json().catch(()=>({}))}))));
  const elapsed=Date.now()-started;
  assert.equal(responses.filter(x=>x.status===200&&x.body.ok).length,count,"health burst "+count+" failed");
  console.log("P2 LOAD "+count+": "+count+" successful responses in "+elapsed+"ms");
}
(async()=>{
  try{
    db=await database();
    await migrate(db);
    server=createApp(db).listen(0,"127.0.0.1");
    await new Promise(r=>server.once("listening",r));
    const base="http://127.0.0.1:"+server.address().port;
    for(const count of [50,100,500]) await burst(base,count);
    console.log("P2 LOAD PASS: 50/100/500 simultaneous health requests");
  }finally{
    if(server)await new Promise(r=>server.close(r));
    if(db)await db.end();
  }
})().catch(e=>{console.error("P2 LOAD FAILED",e);process.exitCode=1;});
