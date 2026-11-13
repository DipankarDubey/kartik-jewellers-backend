import test from 'node:test';
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import {v2 as cloudinary} from 'cloudinary';

process.env.NODE_ENV='test';
process.env.JWT_SECRET='test-only-secret-at-least-32-characters-long';
process.env.SMTP_HOST='smtp.example.test';
process.env.SMTP_FROM='test@example.test';
process.env.STORE_EMAIL='owner@example.test';
process.env.PUBLIC_BASE_URL='https://api.example.test';
process.env.CLOUDINARY_CLOUD_NAME='test-cloud';
process.env.CLOUDINARY_API_KEY='test-key';
process.env.CLOUDINARY_API_SECRET='test-secret';

const {app}=await import('../src/server.js');
const {Customer}=await import('../src/models.js');

test('image upload, consent-only campaigns, unsubscribe and contact email (mocked providers)',async()=>{
 const original={
  upload:cloudinary.uploader.upload_stream,
  transport:nodemailer.createTransport,
  find:Customer.find,
  unsubscribe:Customer.findOneAndUpdate
 };
 const mail=[];
 const audience=[
  {name:'Opted In',email:'optin@example.test',marketingConsent:true,unsubscribed:false,unsubscribeToken:'token-1'},
  {name:'No Consent',email:'optout@example.test',marketingConsent:false,unsubscribed:false,unsubscribeToken:'token-2'},
  {name:'Unsubscribed',email:'blocked@example.test',marketingConsent:true,unsubscribed:true,unsubscribeToken:'token-3'}
 ];
 nodemailer.createTransport=()=>({sendMail:async message=>{mail.push(message);return {messageId:'fake'}}});
 cloudinary.uploader.upload_stream=(options,callback)=>{
   assert.equal(options.folder,'karthik-jewellers');
   return new Writable({write(chunk,encoding,done){done()},final(done){done();queueMicrotask(()=>callback(null,{secure_url:'https://res.cloudinary.com/test/image/upload/ring.png',public_id:'karthik-jewellers/ring'}))}});
 };
 Customer.find=filter=>({limit:async()=>audience.filter(c=>c.marketingConsent&&!c.unsubscribed&&c.email)});
 Customer.findOneAndUpdate=async(filter,update)=>{const c=audience.find(x=>x.unsubscribeToken===filter.unsubscribeToken);if(c)Object.assign(c,update);return c};
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const auth='Bearer '+jwt.sign({sub:'test-admin',role:'admin'},process.env.JWT_SECRET,{algorithm:'HS256'});
 const req=async(path,opts={})=>{const r=await fetch(base+path,opts);return {status:r.status,data:await r.json().catch(()=>null)}};
 try{
   let r=await req('/api/admin/upload',{method:'POST'});
   assert.equal(r.status,401);
   const uploadData=new FormData();uploadData.set('image',new Blob([new Uint8Array([137,80,78,71,13,10,26,10])],{type:'image/png'}),'ring.png');
   r=await req('/api/admin/upload',{method:'POST',headers:{Authorization:auth},body:uploadData});
   assert.equal(r.status,200);assert.match(r.data.imageUrl,/cloudinary/);
   const invalidFile=new FormData();invalidFile.set('image',new Blob(['bad'],{type:'text/plain'}),'test.txt');
   r=await req('/api/admin/upload',{method:'POST',headers:{Authorization:auth},body:invalidFile});
   assert.equal(r.status,400);
   r=await req('/api/admin/campaigns/send',{method:'POST',headers:{Authorization:auth,'Content-Type':'application/json'},body:JSON.stringify({subject:'Holiday offer',message:'Welcome to our special offer this week!'})});
   assert.equal(r.status,200);assert.equal(r.data.sent,1);assert.equal(mail.length,1);
   assert.equal(mail[0].to,'optin@example.test');assert.match(mail[0].text,/Unsubscribe/i);
   const un=await fetch(base+'/api/unsubscribe/token-1');assert.equal(un.status,200);assert.equal(audience[0].marketingConsent,false);
   r=await req('/api/contact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Visitor',email:'visitor@example.test',message:'Can I visit this week?'})});
   assert.equal(r.status,200);assert.equal(mail.length,2);assert.equal(mail[1].to,'owner@example.test');
 }finally{
  await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  cloudinary.uploader.upload_stream=original.upload;nodemailer.createTransport=original.transport;
  Customer.find=original.find;Customer.findOneAndUpdate=original.unsubscribe;
 }
});
