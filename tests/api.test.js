import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

process.env.NODE_ENV='test';
process.env.JWT_SECRET='test-only-secret-at-least-32-characters-long';
process.env.FRONTEND_URL='http://localhost:5173';
process.env.STORE_NAME='Karthik Jewellers';
process.env.STORE_ADDRESS='Test address';
const {app}=await import('../src/server.js');
const {Admin,Product,Customer}=await import('../src/models.js');

test('public API, admin auth, product CRUD and customer consent (mocked database)', async () => {
 const previous={
  admin:Admin.findOne,
  products:Product.find,
  createProduct:Product.create,
  updateProduct:Product.findByIdAndUpdate,
  deleteProduct:Product.findByIdAndDelete,
  countProduct:Product.countDocuments,
  customerCreate:Customer.create,
  customerFind:Customer.find,
  customerCount:Customer.countDocuments
 };
 let items=[{_id:'p1',name:'Test Ring',category:'Rings',price:1000,active:true,featured:false}];
 let visitors=[];
 const passwordHash=await bcrypt.hash('test-strong-password',4);
 Admin.findOne=async({username})=>username==='test-admin'?{id:'admin1',username,passwordHash}:null;
 Product.find=filter=>({sort:()=>({lean:async()=>filter?.active===true?items.filter(p=>p.active):items})});
 Product.create=async fields=>{const p={_id:'p2',...fields};items.push(p);return p};
 Product.findByIdAndUpdate=async(id,fields)=>{const p=items.find(p=>p._id===id);if(!p)return null;Object.assign(p,fields);return p};
 Product.findByIdAndDelete=async id=>{const i=items.findIndex(p=>p._id===id);return i===-1?null:items.splice(i,1)[0]};
 Product.countDocuments=async()=>items.length;
 Customer.create=async fields=>{const v={_id:'v1',...fields};visitors.push(v);return v};
 Customer.find=()=>({sort:()=>({limit:()=>({lean:async()=>visitors})}),limit:async()=>[]});
 Customer.countDocuments=async()=>visitors.length;
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
  r=await req('/api/admin/products',json('POST',{name:'New Gold Ring',category:'Rings',price:2999},token));
  assert.equal(r.status,201);assert.equal(r.data.name,'New Gold Ring');
  r=await req('/api/admin/products/p2',json('PUT',{name:'Updated Ring',category:'Rings',price:3999},token));
  assert.equal(r.status,200);assert.equal(r.data.price,3999);
  r=await req('/api/admin/products/p2',{method:'DELETE',headers:{Authorization:'Bearer '+token}});
  assert.equal(r.status,200);assert.equal(items.length,1);
  r=await req('/api/admin/customers',json('POST',{name:'Visitor',phone:'9999999999',email:'visitor@example.com',marketingConsent:true},token));
  assert.equal(r.status,201);assert.equal(visitors.length,1);assert.equal(r.data.marketingConsent,true);
  r=await req('/api/admin/customers',json('POST',{name:'Visitor 2',phone:'9999999998',marketingConsent:true},token));
  assert.equal(r.status,400);
  r=await req('/api/admin/stats',{headers:{Authorization:'Bearer '+token}});assert.equal(r.status,200);
  r=await req('/api/admin/upload',{method:'POST',headers:{Authorization:'Bearer '+token}});assert.equal(r.status,400);
  r=await req('/api/contact',json('POST',{name:'A',email:'bad',message:'Hi'}));assert.equal(r.status,400);
 } finally {
  await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  Admin.findOne=previous.admin;Product.find=previous.products;Product.create=previous.createProduct;
  Product.findByIdAndUpdate=previous.updateProduct;Product.findByIdAndDelete=previous.deleteProduct;
  Product.countDocuments=previous.countProduct;Customer.create=previous.customerCreate;
  Customer.find=previous.customerFind;Customer.countDocuments=previous.customerCount;
 }
});
