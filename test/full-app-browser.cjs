"use strict";
process.env.JWT_SECRET="full-app-audit-secret-2026-long-enough";
const assert=require("node:assert/strict");
const bcrypt=require("bcryptjs");
const {chromium}=require("playwright");
const {database}=require("./database");
const {migrate,replaceStateSnapshot}=require("../db");
const {createApp}=require("../server");
const {emptyState}=require("../domain");

const PASSWORD="Full-App-Audit-Password-2026";
let db,server,browser,base;

async function seed(){
  db=await database();
  await migrate(db);
  const hash=await bcrypt.hash(PASSWORD,4);
  const users=[
    ["audit-admin@test.invalid","admin","Audit Admin","group",null,null],
    ["audit-employee@test.invalid","employee","Audit Employee","home","e1",null],
    ["audit-client@test.invalid","client","Audit Client","home",null,"c1"],
  ];
  for(const [email,role,name,company,employeeId,clientId] of users)
    await db.query("INSERT INTO users(email,password_hash,role,name,avatar,company,employee_id,client_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [email,hash,role,name,"",company,employeeId,clientId]);
  const d=emptyState();
  d.employees=[{id:"e1",name:"Audit Employee",job:"Technicien",email:"audit-employee@test.invalid",phone:"+41 76 111 22 33",company:"home",companies:["home"],vacation:20,activity:100,status:"Actif"}];
  d.clients=[{id:"c1",name:"Audit Client",email:"audit-client@test.invalid",phone:"+41 79 111 22 33",city:"Lausanne",company:"home"}];
  d.projects=[{id:"P-2026-001",title:"Chantier audit",clientId:"c1",company:"home",team:["e1"],status:"En cours",progress:35,budget:12000,cost:3500}];
  d.time=[{id:"t1",employeeId:"e1",project:"P-2026-001",date:"2026-09-26",start:"08:00",end:"16:00",hours:8,status:"Validée"}];
  d.planning=[{id:"pl1",employeeId:"e1",project:"P-2026-001",date:"2026-09-28",start:"08:00",end:"17:00",location:"Lausanne",company:"home"}];
  d.absences=[{id:"a1",employeeId:"e1",type:"Vacances",from:"2026-10-05",to:"2026-10-06",days:2,status:"En attente"}];
  d.quotes=[{id:"D-2026-001",clientId:"c1",company:"home",title:"Devis audit",amount:1081,valid:"2026-10-15",status:"Envoyé",lines:[{description:"Travaux",quantity:1,unitPrice:1000}]}];
  d.invoices=[{id:"F-2026-001",clientId:"c1",company:"home",title:"Facture audit",amount:1081,paid:200,due:"2026-10-20",status:"Émise",lines:[{description:"Travaux",quantity:1,unitPrice:1000}]}];
  d.payments=[{id:"pay1",invoice:"F-2026-001",amount:200,date:"2026-09-26",method:"Virement",company:"home"}];
  d.expenses=[{id:"ex1",supplier:"s1",project:"P-2026-001",amount:120,date:"2026-09-25",company:"home"}];
  d.inventory=[{id:"inv1",sku:"CABLE-1",name:"Câble",stock:30,min:10,unit:"m",buy:2,sell:4,company:"home"}];
  d.suppliers=[{id:"s1",name:"Fournisseur audit",contact:"Mme Test",email:"supplier@test.invalid",phone:"+41 21 111 11 11",company:"home"}];
  d.vehicles=[{id:"v1",plate:"VD 123456",employeeId:"e1",brand:"Ford",model:"Transit",km:45000,service:"2026-12-01",company:"home"}];
  d.tools=[{id:"tool1",name:"Perceuse",serial:"AUDIT-001",employeeId:"e1",status:"En service",company:"home"}];
  d.maintenance=[{id:"m1",title:"Maintenance audit",clientId:"c1",frequency:"Mensuelle",next:"2026-10-15",amount:1200,company:"home"}];
  d.documents=[];
  await replaceStateSnapshot(db,d,"test-full-app-fixture");
  server=createApp(db).listen(0,"127.0.0.1");
  await new Promise(r=>server.once("listening",r));
  base="http://127.0.0.1:"+server.address().port;
  browser=await chromium.launch({headless:true});
}
async function make(viewport){
  const context=await browser.newContext({viewport});
  const page=await context.newPage();
  const errors=[];
  page.on("pageerror",e=>errors.push("page:"+e.message));
  page.on("response",r=>{
    const p=new URL(r.url()).pathname;
    if(r.status()>=500) errors.push("http:"+r.status()+" "+p);
  });
  return {context,page,errors};
}
async function login(page,email){
  await page.goto(base,{waitUntil:"networkidle"});
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.locator('#loginForm button[type="submit"]').click();
  await page.locator("#app").waitFor({state:"visible"});
}
async function noOverflow(page,label){
  const x=await page.evaluate(()=>({w:innerWidth,doc:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
  assert.ok(x.doc<=x.w+2,label+" html overflow "+JSON.stringify(x));
  assert.ok(x.body<=x.w+2,label+" body overflow "+JSON.stringify(x));
}
async function visitAll(page, expectedPages, mobile=false){
  for(const key of expectedPages){
    if(mobile){
      const side=page.locator("#sidebar");
      const isOpen=await side.evaluate(el=>el.classList.contains("open")).catch(()=>false);
      if(!isOpen)
        await page.locator('[data-action="open-side"]').click();
    }
    const nav=page.locator('[data-page="'+key+'"]');
    await nav.waitFor({state:"visible",timeout:5000});
    await nav.click();
    await page.waitForTimeout(80);
    assert.ok((await page.locator("#content").innerText()).trim().length>0,key+" empty");
    if(key==="settings") await page.locator(".account-profile-card").waitFor({timeout:10000});
    if(key==="messages") await page.locator(".whatsapp-chat").waitFor({timeout:10000});
    await noOverflow(page,(mobile?"mobile ":"desktop ")+key);
  }
}
(async()=>{
  let admin,employee,client;
  try{
    await seed();
    admin=await make({width:1440,height:900});
    await login(admin.page,"audit-admin@test.invalid");
    const adminPages=["dashboard","companies","employees","time","planning","absences","projects","clients","quotes","invoices","payments","expenses","inventory","suppliers","vehicles","tools","maintenance","documents","messages","reports","pilotage","audit","settings"];
    await visitAll(admin.page,adminPages,false);
    await admin.page.locator('[data-page="projects"]').click();
    await admin.page.locator('[data-action="project"]').first().click();
    await admin.page.locator("#modalWrap:not(.hidden)").waitFor();
    assert.match(await admin.page.locator("#modalWrap").innerText(),/Chantier audit/);
    await admin.page.locator('[data-action="close-modal"]').click();

    await admin.page.locator('[data-page="pilotage"]').click();
    await admin.page.locator(".ops-center").waitFor({timeout:10000});
    for(const tab of ["overview","tasks","crm","stock","workorders","analytics","automations","integrations","notifications"]){
      await admin.page.locator('[data-ops-tab="'+tab+'"]').click();
      await admin.page.waitForTimeout(120);
      await noOverflow(admin.page,"pilotage "+tab);
    }

    employee=await make({width:390,height:844});
    await login(employee.page,"audit-employee@test.invalid");
    const employeePages=["dashboard","time","planning","absences","projects","inventory","tools","documents","messages","pilotage","settings"];
    await visitAll(employee.page,employeePages,true);
    if(!(await employee.page.locator("#sidebar").evaluate(el=>el.classList.contains("open"))))
      await employee.page.locator('[data-action="open-side"]').click();
    await employee.page.locator('[data-page="pilotage"]').click();
    await employee.page.locator(".ops-center").waitFor({timeout:10000});
    assert.equal(await employee.page.locator('[data-ops-tab="crm"]').count(),0);
    assert.equal(await employee.page.locator('[data-ops-tab="analytics"]').count(),0);
    await employee.page.locator('[data-ops-tab="tasks"]').click();
    await noOverflow(employee.page,"mobile pilotage tasks");
    assert.equal(await employee.page.locator('[data-page="clients"]').count(),0);
    assert.equal(await employee.page.locator('[data-page="invoices"]').count(),0);

    client=await make({width:390,height:844});
    await login(client.page,"audit-client@test.invalid");
    const clientPages=["dashboard","projects","quotes","invoices","maintenance","documents","messages","settings"];
    await visitAll(client.page,clientPages,true);
    assert.equal(await client.page.locator('[data-page="employees"]').count(),0);
    assert.equal(await client.page.locator('[data-page="payments"]').count(),0);

    assert.deepEqual(admin.errors,[]);
    assert.deepEqual(employee.errors,[]);
    assert.deepEqual(client.errors,[]);
    console.log("FULL APP BROWSER PASS: admin desktop + employee/client mobile navigation, permissions, project modal, account center, messages, finance and no global overflow");
  } finally {
    for(const x of [admin,employee,client]) if(x?.context) await x.context.close();
    if(browser) await browser.close();
    if(server) await new Promise(r=>server.close(r));
    if(db) await db.end();
  }
})().catch(e=>{console.error("FULL APP BROWSER FAILED",e);process.exitCode=1;});
