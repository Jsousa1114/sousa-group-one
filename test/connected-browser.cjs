"use strict";
// Browser end-to-end tests against the REAL app code + isolated temporary PGlite.
// These synthetic accounts MUST NOT be used against the production site.
process.env.JWT_SECRET = "browser-test-only-secret-never-use-in-production-123456";
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { chromium } = require("playwright");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const { emptyState } = require("../domain");
const PASSWORD = "Isolated-E2E-Password-2026";
const ORIGIN = "http://127.0.0.1";
let db,server,browser,base;
function log(message){console.log("E2E: "+message);}
async function seed(){
 db=await database();
 await migrate(db);
 const hash=await bcrypt.hash(PASSWORD,4);
 const accounts=[
  ["admin@e2e.invalid","admin","group",null,null],
  ["employee@e2e.invalid","employee","home","e1",null],
  ["client@e2e.invalid","client","home",null,"c1"],
  ["disposable@e2e.invalid","client","home",null,"c1"],
 ];
 for(const [email,role,company,employeeId,clientId] of accounts){
  await db.query("INSERT INTO users(email,password_hash,role,name,avatar,company,employee_id,client_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
   [email,hash,role,role==="admin"?"Admin E2E":role==="employee"?"Salarié E2E":role==="client"?"Client E2E":"Compte à supprimer","",company,employeeId,clientId]);
 }
 const data=emptyState();
 data.clients=[{id:"c1",name:"Client E2E",company:"home",email:"client@e2e.invalid",city:"Nyon"}];
 data.employees=[{id:"e1",name:"Salarié E2E",email:"employee@e2e.invalid",company:"home",job:"Technicien",salary:5000,activity:100,vacation:20,entry:"2026-09-01"}];
 data.projects=[{id:"p1",title:"Chantier E2E",company:"home",clientId:"c1",team:["e1"],progress:0,status:"Planifié",description:"Chantier de test"}];
 await db.query("UPDATE app_state SET data=$1 WHERE id=1",[JSON.stringify(data)]);
 server=createApp(db).listen(0,"127.0.0.1");
 await new Promise((r)=>server.once("listening",r));
 base=ORIGIN+":"+server.address().port;
 browser=await chromium.launch({headless:true});
}
async function login(role,mobile=false){
 const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile});
 const page=await context.newPage();
 const errors=[];
 page.on("pageerror",(e)=>errors.push(e.message));
 const response=await page.goto(base,{waitUntil:"networkidle",timeout:30000});
 assert.equal(response.status(),200);
 await page.locator("#email").fill(role+"@e2e.invalid");
 await page.locator("#password").fill(PASSWORD);
 await page.locator('#loginForm button[type="submit"]').click();
 await page.locator("#app").waitFor({state:"visible",timeout:10000});
 assert.equal(await page.locator("#login").isVisible(),false);
 assert.match(await page.locator("#userName").innerText(),/E2E/);
 return {page,context,errors};
}
async function nav(page,target,mobile=false){
 if(mobile)await page.locator('[data-action="open-side"]').click();
 await page.locator('[data-page="'+target+'"]').click();
 await page.locator("#title").waitFor({state:"visible"});
}
async function employeeTest(mobile=false){
 const {page,context,errors}=await login("employee",mobile);
 try{
  assert.equal(await page.locator('[data-page="employees"]').count(),0,"Employee cannot access HR menu");
  await nav(page,"time",mobile);
  await page.locator("#clockProject").selectOption("p1");
  await page.locator('[data-action="clock.start"]').click();
  await page.locator('[data-action="clock.pause"]').waitFor({timeout:10000});
  await page.locator('[data-action="clock.pause"]').click();
  await page.locator('[data-action="clock.resume"]').waitFor();
  await page.locator('[data-action="clock.resume"]').click();
  await page.locator('[data-action="clock.stop"]').waitFor();
  await page.locator('[data-action="clock.stop"]').click();
  await page.locator('[data-action="clock.start"]').waitFor({timeout:10000});
  await page.locator("#content").getByText("Salarié E2E").first().waitFor();
  const token=await page.evaluate(()=>sessionStorage.getItem("sgo_session"));
  const state=await page.request.get(base+"/api/state",{headers:{Authorization:"Bearer "+token}});
  assert.equal(state.status(),200);
  assert.equal((await state.json()).data.time.filter(x=>x.employeeId==="e1").length,mobile?2:1);
  await nav(page,"planning",mobile);
  assert.ok((await page.locator("#content").innerText()).length>20);
  assert.deepEqual(errors,[]);
  log("SALARIE "+(mobile?"MOBILE":"DESKTOP")+" OK: connexion, pointage début/pause/reprise/fin, heures sauvegardées, planning, droits");
 } finally {await context.close();}
}
async function clientTest(mobile=false){
 const {page,context,errors}=await login("client",mobile);
 try{
  assert.equal(await page.locator('[data-page="employees"]').count(),0);
  assert.equal(await page.locator('[data-page="clients"]').count(),0);
  await nav(page,"projects",mobile);
  assert.match(await page.locator("#content").innerText(),/Chantier E2E/);
  await nav(page,"quotes",mobile);
  assert.equal(await page.locator('[data-action="new"]').count(),0);
  const token=await page.evaluate(()=>sessionStorage.getItem("sgo_session"));
  const r=await page.request.get(base+"/api/state",{headers:{Authorization:"Bearer "+token}});
  assert.equal(r.status(),200);
  const data=(await r.json()).data;
  assert.equal(data.employees.length,0,"client cannot read salaries");
  assert.ok(data.projects.every(p=>p.clientId==="c1"));
  assert.deepEqual(errors,[]);
  log("CLIENT "+(mobile?"MOBILE":"DESKTOP")+" OK: connexion, chantier, devis, données RH privées");
 } finally {await context.close();}
}
async function adminTest(){
 const {page,context,errors}=await login("admin");
 try{
  await nav(page,"quotes");
  await page.locator('[data-action="new"][data-id="quotes"]').click();
  await page.locator('#entityForm [name="company"]').selectOption("home");
  await page.locator('#entityForm [name="clientId"]').selectOption("c1");
  await page.locator('#entityForm [name="title"]').fill("Devis créé par navigateur E2E");
  await page.locator('#entityForm [name="lineDescription"]').fill("Prestation de test");
  await page.locator('#entityForm [name="linePrice"]').fill("100");
  await page.locator('#entityForm [name="lineVat"]').fill("8.1");
  await page.locator('#entityForm button[type="submit"]').click();
  await page.locator("#modalWrap").waitFor({state:"hidden",timeout:10000});
  const token=await page.evaluate(()=>sessionStorage.getItem("sgo_session"));
  const headers={Authorization:"Bearer "+token};
  const stateResponse=await page.request.get(base+"/api/state",{headers});
  assert.equal(stateResponse.status(),200);
  const state=(await stateResponse.json()).data;
  const quote=state.quotes.find(q=>q.title==="Devis créé par navigateur E2E");
  assert.ok(quote,"Browser-created quote persisted to isolated PGlite");
  assert.equal(quote.status,"Brouillon");
  assert.equal(quote.amount,108.1);
  await nav(page,"employees");
  await page.locator("#usersList").getByText("disposable@e2e.invalid").waitFor();
  const row=page.locator("#usersList tr").filter({hasText:"disposable@e2e.invalid"});
  await row.locator('[data-action="delete-user"]').click();
  await page.locator("#usersList").getByText("disposable@e2e.invalid").waitFor({state:"detached",timeout:10000});
  const gone=await db.query("SELECT deleted_at,disabled FROM users WHERE email=$1",["disposable@e2e.invalid"]);
  assert.ok(gone.rows.length===0 || gone.rows[0].deleted_at || gone.rows[0].disabled,"Account deleted or disabled");
  assert.deepEqual(errors,[]);
  log("ADMIN DESKTOP OK: connexion, devis créé via formulaire et sauvegardé, compte de test supprimé via bouton, droits");
 } finally {await context.close();}
}
(async()=>{
 try{
  await seed();
  await employeeTest(false);
  await employeeTest(true);
  await clientTest(false);
  await clientTest(true);
  await adminTest();
  log("TOUS LES PARCOURS CONNECTES REUSSIS SUR BASE ISOLEE, AUCUNE DONNEE DE PRODUCTION TOUCHEE");
 }finally{
  if(browser)await browser.close();
  if(server)await new Promise(r=>server.close(r));
  if(db)await db.end();
 }
})().catch(e=>{console.error("E2E FAILED:",e);process.exitCode=1;});
