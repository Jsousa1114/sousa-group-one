"use strict";
const assert=require("node:assert/strict");
const {chromium}=require("playwright");

const target="https://sousa-group-one.onrender.com/?id=a9f8e1b2-7254-4e54-b483-060860184d1f&companies=electricite&companies=tech&companies=29dfe6d2-a205-400a-8a81-16b079f981be";
const origin="https://sousa-group-one.onrender.com";

async function run(device,viewport,isMobile){
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport,isMobile,hasTouch:isMobile,deviceScaleFactor:isMobile?2:1});
  const page=await context.newPage();
  const pageErrors=[];
  const badResponses=[];
  page.on("pageerror",e=>pageErrors.push(e.message));
  page.on("response",r=>{
    if(r.url().startsWith(origin)&&r.status()>=400) badResponses.push({status:r.status(),url:r.url()});
  });
  try{
    const response=await page.goto(target,{waitUntil:"networkidle",timeout:120000});
    assert.equal(response.status(),200,device+" main response");
    assert.match(await page.title(),/Sousa Group One/i);
    await page.locator("#loginForm").waitFor({state:"visible"});
    await page.locator(".login-logo").waitFor({state:"visible"});
    assert.equal(await page.locator(".login-logo").evaluate(img=>img.complete&&img.naturalWidth>0),true,device+" logo");
    assert.equal(await page.locator("#app").isVisible(),false,device+" private app hidden");
    const current=new URL(page.url());
    assert.equal(current.searchParams.get("id"),"a9f8e1b2-7254-4e54-b483-060860184d1f");
    assert.deepEqual(current.searchParams.getAll("companies"),["electricite","tech","29dfe6d2-a205-400a-8a81-16b079f981be"]);
    const privateState=await page.request.get(origin+"/api/state");
    assert.equal(privateState.status(),401,device+" private API protected");
    const health=await page.request.get(origin+"/healthz");
    assert.equal(health.status(),200,device+" health");
    assert.equal((await health.json()).ok,true,device+" DB health");
    const widths=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));
    assert.ok(widths.scroll<=widths.client+2,device+" horizontal overflow "+JSON.stringify(widths));
    assert.deepEqual(pageErrors,[],device+" JS errors");
    assert.deepEqual(badResponses.filter(x=>!x.url.endsWith("/api/state")),[],device+" broken public responses");
    console.log(device+": PASS exact shared URL; login visible; query string preserved; assets OK; no JS errors; DB health OK; unauthorized API blocked; viewport="+widths.client);
  }finally{
    await context.close();await browser.close();
  }
}
(async()=>{
  await run("desktop",{width:1440,height:900},false);
  await run("mobile",{width:390,height:844},true);
})().catch(e=>{console.error("SHARED LINK TEST FAILED",e);process.exitCode=1;});
