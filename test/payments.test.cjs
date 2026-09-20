const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('isolated payment and deposit regressions', async () => {
 const cwd = process.cwd();
 const dir = fs.mkdtempSync(path.join(os.tmpdir(),'veda-payment-test-'));
 process.chdir(dir); // Existing database.sqlite3 is never opened.
 const {sequelize,Profile,Contract,Job} = require('../src/model');
 sequelize.options.logging = false;
 const app = require('../src/app');
 let server;
 try {
  await sequelize.sync({force:true});
  await Profile.bulkCreate([
   {id:1,firstName:'Test',lastName:'Client',profession:'test',type:'client',balance:100},
   {id:2,firstName:'Test',lastName:'Contractor',profession:'test',type:'contractor',balance:0}
  ]);
  await Contract.create({id:1,terms:'fixture',status:'in_progress',ClientId:1,ContractorId:2});
  await Job.bulkCreate([{id:1,description:'fixture',price:80,paid:null,ContractId:1},{id:2,description:'fixture',price:40,ContractId:1}]);
  assert.equal((await Job.findByPk(2)).paid,false);
  server=await new Promise(resolve => {const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(route,body)=>fetch(base+route,{method:'POST',headers:{'profile_id':'1','content-type':'application/json'},body:JSON.stringify(body||{})});
  const unpaid=await fetch(base+'/jobs/unpaid',{headers:{profile_id:'1'}});
  assert.equal((await unpaid.json()).length,2);
  for(const amount of [-1,0,'10',null]) assert.equal((await request('/balances/deposit/1',{amount})).status,400);
  const responses=await Promise.all([request('/jobs/1/pay'),request('/jobs/1/pay')]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,400]);
  assert.equal(Number((await Profile.findByPk(1)).balance),20);
  assert.equal(Number((await Profile.findByPk(2)).balance),80);
  assert.equal((await request('/balances/deposit/1',{amount:11})).status,400);
  assert.equal((await request('/balances/deposit/1',{amount:10})).status,200);
  assert.equal(Number((await Profile.findByPk(1)).balance),30);
  assert.equal((await request('/balances/deposit/1foo',{amount:1})).status,403);
 } finally {
  if(server) await new Promise(resolve=>server.close(resolve));
  await sequelize.close();process.chdir(cwd);fs.rmSync(dir,{recursive:true,force:true});
 }
});
