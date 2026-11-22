import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

process.env.NODE_ENV='test';
process.env.JWT_SECRET='test-only-secret-at-least-32-characters-long';
process.env.FRONTEND_URL='http://localhost:5173';
process.env.STORE_NAME='Karthik Jewellers';
process.env.STORE_ADDRESS='Test address';
const {app}=await import('../src/server.js');
const {Admin,Product,Customer,StoreSettings}=await import('../src/models.js');

test('public API, admin auth, product CRUD and customer consent (mocked database)', async () => {
 const previous={store:StoreSettings.findOne,updateStore:StoreSettings.findOneAndUpdate,
  admin:Admin.findOne,
  products:Product.find,
  createProduct:Product.create,
  updateProduct:Product.findByIdAndUpdate,
  deleteProduct:Product.findByIdAndDelete,
  countProduct:Product.countDocuments,
  customerCreate:Customer.create,
  customerFind:Customer.find,
  customerCount:Customer.countDocuments,
  customerUpdate:Customer.findOneAndUpdate
 };
 StoreSettings.findOne=()=>({lean:async()=>null});
 StoreSettings.findOneAndUpdate=async(filter,update)=>({...update.$set});
 let items=[{_id:'p1',name:'Test Ring',category:'Rings',price:1000,active:true,featured:false}];
 const visitorId='0123456789abcdef01234567';
 const accountId='0123456789abcdef01234568';
 const visitor={_id:visitorId,name:'Linked shopper',savingsAccount:accountId,marketingConsent:true,whatsappConsent:true};
 const visitors=[visitor];
 const passwordHash=await bcrypt.hash('test-strong-password',4);
 Admin.findOne=async({username})=>username==='test-admin'?{id:'admin1',username,passwordHash}:null;
 Product.find=filter=>({sort:()=>({lean:async()=>filter?.active===true?items.filter(p=>p.active):items})});
 Product.create=async fields=>{const p={_id:'p2',...fields};items.push(p);return p};
 Product.findByIdAndUpdate=async(id,fields)=>{const p=items.find(p=>p._id===id);if(!p)return null;Object.assign(p,fields);return p};
 Product.findByIdAndDelete=async id=>{const i=items.findIndex(p=>p._id===id);return i===-1?null:items.splice(i,1)[0]};
 Product.countDocuments=async()=>items.length;
 Customer.create=async fields=>{const v={_id:'v1',...fields};visitors.push(v);return v};
 const matching = filter => visitors.filter(customer =>
  (filter.removedAt !== null || !customer.removedAt) &&
  (!filter.whatsappConsent || customer.whatsappConsent));
 Customer.find=filter=>({
  select:()=>({sort:()=>({limit:()=>({lean:async()=>matching(filter)})}),
   limit:()=>({lean:async()=>matching(filter)})})
 });
 Customer.countDocuments=async filter=>matching(filter).length;
 Customer.findOneAndUpdate=async (filter, update)=>{
  assert.equal(filter.removedAt,null);
  const customer=matching(filter).find(row=>row._id===filter._id);
  return customer ? Object.assign(customer,update.$set) : null;
 };
 const server=app.listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 const url='http://127.0.0.1:'+server.address().port;
 const req=async(path,options={})=>{
  const res=await fetch(url+path,options);
  const data=await res.json().catch(()=>null);
  return {status:res.status,data};
 };
 const json=(method,body,token)=>({method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
 try {
  let r=await req('/api/health');assert.equal(r.status,200);assert.equal(r.data.status,'ok');
  r=await req('/api/store');assert.equal(r.data.name,'Karthik Jewellers');assert.match(r.data.mapsUrl,/maps/);
  r=await req('/api/products');assert.equal(r.status,200);assert.equal(r.data.length,1);
  r=await req('/api/admin/products');assert.equal(r.status,401);
  r=await req('/api/admin/login',json('POST',{username:'test-admin',password:'wrong'}));assert.equal(r.status,401);
  r=await req('/api/admin/login',json('POST',{username:'test-admin',password:'test-strong-password'}));
  assert.equal(r.status,200);assert.ok(r.data.token);
  const token=r.data.token;
  r=await req('/api/admin/products',{headers:{Authorization:'Bearer '+token}});assert.equal(r.status,200);
  r=await req('/api/admin/products',json('POST',{name:'',category:'Rings',price:10},token));assert.equal(r.status,400);
  r=await req('/api/admin/products',json('POST',{name:'New Gold Ring',category:'Rings',price:2999,purity:'22K',weight:18.2,images:['https://images.example.com/ring-side.jpg']},token));
  assert.equal(r.status,201);assert.equal(r.data.name,'New Gold Ring');assert.equal(r.data.metal,'Gold');assert.equal(r.data.purity,'22K');assert.equal(r.data.weight,18.2);assert.equal(r.data.images.length,1);
  r=await req('/api/admin/store',json('PUT',{name:'Karthik Jewellers',address:'Pune, India',email:'owner@example.com',phone:'1234567890',mapsUrl:''},token));assert.equal(r.status,200);assert.match(r.data.mapsUrl,/maps/);
  r=await req('/api/admin/products/p2',json('PUT',{name:'Updated Ring',metal:'Silver',category:'Rings',price:3999},token));
  assert.equal(r.status,200);assert.equal(r.data.price,3999);assert.equal(r.data.metal,'Silver');assert.equal(r.data.weight,null);
  r=await req('/api/admin/products/p2',{method:'DELETE',headers:{Authorization:'Bearer '+token}});
  assert.equal(r.status,200);assert.equal(items.length,1);
  r=await req('/api/admin/customers',json('POST',{name:'Visitor 2',phone:'9999999998',marketingConsent:true},token));
  assert.equal(r.status,400);
  r=await req('/api/admin/stats',{headers:{Authorization:'Bearer '+token}});assert.equal(r.status,200);
  const customerPath='/api/admin/customers/'+visitorId;
  const adminHeaders={Authorization:'Bearer '+token};
  assert.equal((await req(customerPath,{method:'DELETE'})).status,401);
  assert.equal((await req('/api/admin/customers/bad-id',{method:'DELETE',headers:adminHeaders})).status,400);
  assert.equal((await req(customerPath,{method:'DELETE',headers:adminHeaders})).status,200);
  assert.equal((await req(customerPath,{method:'DELETE',headers:adminHeaders})).status,404);
  assert.equal(visitor.savingsAccount,accountId);
  assert.equal(visitor.marketingConsent,false);
  assert.equal(visitor.whatsappConsent,false);
  assert.equal(visitor.unsubscribed,true);
  assert.deepEqual((await req('/api/admin/customers',{headers:adminHeaders})).data,[]);
  assert.deepEqual((await req('/api/admin/whatsapp/audience',{headers:adminHeaders})).data.customers,[]);
  assert.equal((await req('/api/admin/stats',{headers:adminHeaders})).data.customers,0);
  r=await req('/api/admin/upload',{method:'POST',headers:{Authorization:'Bearer '+token}});assert.equal(r.status,400);
  r=await req('/api/contact',json('POST',{name:'A',email:'bad',message:'Hi'}));assert.equal(r.status,400);
 } finally {
  await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  StoreSettings.findOne=previous.store;StoreSettings.findOneAndUpdate=previous.updateStore;
  Admin.findOne=previous.admin;Product.find=previous.products;Product.create=previous.createProduct;
  Product.findByIdAndUpdate=previous.updateProduct;Product.findByIdAndDelete=previous.deleteProduct;
  Product.countDocuments=previous.countProduct;Customer.create=previous.customerCreate;
  Customer.find=previous.customerFind;Customer.countDocuments=previous.customerCount;Customer.findOneAndUpdate=previous.customerUpdate;
 }
});
