"use strict";
process.env.JWT_SECRET="p2-browser-secret-2026-long-enough";
const fs=require("node:fs");
const assert=require("node:assert/strict");
const bcrypt=require("bcryptjs");
const {chromium,firefox,webkit,devices}=require("playwright");
const {database}=require("./database");
const {migrate}=require("../db");
const {createApp}=require("../server");
const {emptyState}=require("../domain");

const PASSWORD="P2-Audit-Password-2026";
const engine=String(process.env.P2_BROWSER||"chromium").toLowerCase();
const browserType={chromium,firefox,webkit}[engine];
if(!browserType) throw new Error("Unsupported P2_BROWSER "+engine);
let db,server,browser,base;

async function seed(){
  db=await database();
  await migrate(db);
  const hash=await bcrypt.hash(PASSWORD,4);
  for(const [email,role,name,company,employeeId,clientId] of [
    ["p2-admin@test.invalid","admin","P2 Admin","group",null,null],
    ["p2-client@test.invalid","client","P2 Client","home",null,"c1"],
  ]) await db.query(
    "INSERT INTO users(email,password_hash,role,name,avatar,company,employee_id,client_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [email,hash,role,name,"",company,employeeId,clientId]
  );
  const d=emptyState();
  d.companies=[
    {id:"group",name:"Sousa Group",type:"Groupe"},
    {id:"home",name:"Sousa Home Service",type:"Services"},
  ];
  d.clients=[{id:"c1",name:"P2 Client",email:"p2-client@test.invalid",phone:"+41790000000",city:"Lausanne",company:"home"}];
  d.employees=[{id:"e1",name:"Technicien P2",company:"home",salary:8000,status:"Actif"}];
  d.projects=[{id:"p1",title:"Chantier P2",clientId:"c1",company:"home",team:["e1"],status:"En cours",progress:40,budget:10000,cost:3000}];
  d.planning=[{id:"pl1",employeeId:"e1",project:"p1",date:"2026-09-28",start:"08:00",end:"17:00",location:"Lausanne",company:"home"}];
  d.quotes=[{id:"D-P2-1",clientId:"c1",company:"home",title:"Devis P2",amount:2500,status:"Envoyé",date:"2026-09-10"}];
  d.invoices=[{id:"F-P2-1",clientId:"c1",company:"home",project:"p1",title:"Facture P2",amount:3000,paid:1000,due:"2026-10-15",status:"Émise"}];
  d.expenses=[{id:"E-P2-1",project:"p1",company:"home",amount:350,date:"2026-10-01"}];
  await db.query("UPDATE app_state SET data=$1 WHERE id=1",[JSON.stringify(d)]);
  server=createApp(db).listen(0,"127.0.0.1");
  await new Promise(r=>server.once("listening",r));
  base="http://127.0.0.1:"+server.address().port;
  browser=await browserType.launch({headless:true});
}
async function contextFor(kind){
  const preset=kind==="client"
    ? (engine==="webkit"
        ? devices["iPhone 15"]
        : engine==="chromium"
          ? devices["Pixel 7"]
          : {viewport:{width:390,height:844},userAgent:"Mozilla/5.0 Mobile Firefox P2"})
    : {viewport:{width:1440,height:900}};
  return browser.newContext({...preset});
}
async function login(page,email){
  await page.goto(base,{waitUntil:"networkidle"});
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.locator('#loginForm button[type="submit"]').click();
  await page.locator("#app").waitFor({state:"visible"});
}
async function openAdvanced(page,mobile=false){
  if(mobile) await page.locator('[data-action="open-side"]').click();
  const nav=page.locator('[data-page="advanced"]');
  await nav.waitFor({state:"visible"});
  await nav.click();
  await page.locator(".p2-center").waitFor({timeout:10000});
}
async function noOverflow(page,label){
  const size=await page.evaluate(()=>({w:innerWidth,doc:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
  assert.ok(size.doc<=size.w+2,label+" html overflow "+JSON.stringify(size));
  assert.ok(size.body<=size.w+2,label+" body overflow "+JSON.stringify(size));
}
(async()=>{
  let adminCtx,clientCtx;
  try{
    fs.mkdirSync("p2-browser-results",{recursive:true});
    await seed();
    adminCtx=await contextFor("admin");
    const admin=await adminCtx.newPage(), errors=[];
    admin.on("pageerror",e=>errors.push(e.message));
    await login(admin,"p2-admin@test.invalid");
    await openAdvanced(admin,false);
    assert.match(await admin.locator(".p2-center").innerText(),/Socle P2 interne|Mobilité/);
    await admin.locator('[data-p2-tab="finance"]').click();
    await admin.locator(".p2-chart").waitFor();
    assert.match(await admin.locator("#p2Body").innerText(),/Prévision de trésorerie/);
    await admin.locator('[data-p2-tab="approvals"]').click();
    await admin.getByText("Workflow d’approbation",{exact:true}).waitFor({timeout:10000});
    assert.match(await admin.locator("#p2Body").innerText(),/Workflow d’approbation/);
    await noOverflow(admin,engine+" admin P2");
    await admin.screenshot({path:"p2-browser-results/"+engine+"-admin.png",fullPage:true});
    assert.deepEqual(errors,[]);

    clientCtx=await contextFor("client");
    const client=await clientCtx.newPage(), clientErrors=[];
    client.on("pageerror",e=>clientErrors.push(e.message));
    await login(client,"p2-client@test.invalid");
    await openAdvanced(client,true);
    assert.match(await client.locator(".p2-center").innerText(),/Portail client avancé/);
    await client.locator('[data-p2-action="appointment-new"]').click();
    await client.locator('#p2Form input[name="title"]').fill("Visite P2");
    await client.locator('#p2Form input[name="startsAt"]').fill("2026-10-02T10:00");
    await client.locator('#p2Form input[name="endsAt"]').fill("2026-10-02T11:00");
    await client.locator('#p2Form button[type="submit"]').click();
    await client.locator("#modalWrap").waitFor({state:"hidden"});
    await client.getByText("Visite P2",{exact:true}).waitFor({timeout:10000});
    assert.match(await client.locator(".p2-center").innerText(),/Visite P2/);
    await noOverflow(client,engine+" client P2");
    await client.screenshot({path:"p2-browser-results/"+engine+"-client.png",fullPage:true});
    assert.deepEqual(clientErrors,[]);
    console.log("P2 BROWSER PASS",engine);
  }finally{
    if(adminCtx)await adminCtx.close();
    if(clientCtx)await clientCtx.close();
    if(browser)await browser.close();
    if(server)await new Promise(r=>server.close(r));
    if(db)await db.end();
  }
})().catch(e=>{console.error("P2 BROWSER FAILED",engine,e);process.exitCode=1;});
