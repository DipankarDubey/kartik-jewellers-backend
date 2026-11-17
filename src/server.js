import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {mailTransport} from './mail.js';
import multer from 'multer';
import {v2 as cloudinary} from 'cloudinary';
import {Admin,Product,Customer,StoreSettings} from './models.js';
import {seed} from './seed.js';
import {savingsRouter} from './savings.js';
import {ordersRouter} from './orders.js';
import {initializeOrders} from './order-models.js';
import {initializeSavings} from './savings-models.js';

const app=express();
// Render terminates HTTPS at its reverse proxy. Trust only the nearest proxy hop,
// so express-rate-limit can use the forwarded client IP instead of a shared proxy IP.
app.set('trust proxy',1);
const port=Number(process.env.PORT)||5000;
const origin=(process.env.FRONTEND_URL||'http://localhost:5173').split(',').map(s=>s.trim());
app.use(helmet());app.use(cors({origin}));app.use(express.json({limit:'150kb'}));
app.use('/api',rateLimit({windowMs:15*60*1000,limit:300,standardHeaders:'draft-7',legacyHeaders:false}));
const authLimit=rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:'draft-7',legacyHeaders:false});
const str=(v,max=1000)=>typeof v==='string'?v.trim().slice(0,max):'';
const validEmail=s=>/^\S+@\S+\.\S+$/.test(s);
const fail=(res,msg,code=400)=>res.status(code).json({error:msg});
function auth(req,res,next){const token=req.headers.authorization?.replace(/^Bearer\s+/i,'');try{const decoded=jwt.verify(token,process.env.JWT_SECRET,{algorithms:['HS256']});if(decoded.role!=='admin')return fail(res,'Unauthorized',401);req.admin=decoded;next();}catch{return fail(res,'Unauthorized',401);}}
function handleError(err,req,res,next){console.error(err);if(err instanceof multer.MulterError)return fail(res,err.message,400);if(err?.name==='ValidationError'||err?.name==='CastError')return fail(res,'Invalid data',400);if(err?.code===11000)return fail(res,'Duplicate value',409);return fail(res,'Server error',500);}
app.get('/api/health',(req,res)=>res.json({status:'ok'}));
const defaultStore=()=>({name:process.env.STORE_NAME||'Karthik Jewellers',email:process.env.STORE_EMAIL||'',phone:process.env.STORE_PHONE||'',address:process.env.STORE_ADDRESS||'Add your actual shop address',mapsUrl:process.env.STORE_MAPS_URL||'',logoUrl:process.env.STORE_LOGO_URL||'',faviconUrl:process.env.STORE_FAVICON_URL||''});
const mapLink=address=>'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(address||'Karthik Jewellers');
async function getStore(){const saved=await StoreSettings.findOne({key:'store'}).lean();const data={...defaultStore(),...saved};data.mapsUrl=data.mapsUrl||mapLink(data.address);return {name:data.name,email:data.email,phone:data.phone,address:data.address,mapsUrl:data.mapsUrl,logoUrl:data.logoUrl||'',faviconUrl:data.faviconUrl||''};}
app.get('/api/store',async(req,res,next)=>{try{res.json(await getStore());}catch(e){next(e)}});
app.put('/api/admin/store',auth,async(req,res,next)=>{try{const d=req.body||{},address=str(d.address,500),name=str(d.name,120),email=str(d.email,250),phone=str(d.phone,30),mapsUrl=str(d.mapsUrl,1500),logoUrl=str(d.logoUrl,1500),faviconUrl=str(d.faviconUrl,1500);if(!address||!name||(email&&!validEmail(email))||(mapsUrl&&!/^https:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|goo\.gl\/maps|maps\.app\.goo\.gl\/)/i.test(mapsUrl)))return fail(res,'Enter a name, address and valid optional Google Maps URL');if([logoUrl,faviconUrl].some(v=>v&&!/^https:\/\/res\.cloudinary\.com\//.test(v)))return fail(res,'Brand assets must use secure Cloudinary image URLs');const data=await StoreSettings.findOneAndUpdate({key:'store'},{$set:{name,address,email,phone,mapsUrl,logoUrl,faviconUrl}},{upsert:true,new:true,runValidators:true});res.json({name:data.name,address:data.address,email:data.email,phone:data.phone,mapsUrl:data.mapsUrl||mapLink(data.address),logoUrl:data.logoUrl||'',faviconUrl:data.faviconUrl||''});}catch(e){next(e)}});
app.post('/api/admin/login',authLimit,async(req,res,next)=>{try{const user=await Admin.findOne({username:req.body?.username});if(!user||!await bcrypt.compare(String(req.body?.password||''),user.passwordHash))return fail(res,'Invalid username or password',401);const token=jwt.sign({sub:user.id,role:'admin'},process.env.JWT_SECRET,{expiresIn:'4h',algorithm:'HS256'});res.json({token,username:user.username});}catch(e){next(e)}});
app.get('/api/products',async(req,res,next)=>{try{const category=str(req.query.category,30);const metal=str(req.query.metal,10);if(metal&&!['Gold','Silver'].includes(metal))return fail(res,'Invalid metal');const filter={active:true};if(metal)filter.metal=metal==='Gold'?{$in:['Gold',null]}:metal;if(category&&category!=='All')filter.category=category;res.json(await Product.find(filter).sort({featured:-1,createdAt:-1}).lean());}catch(e){next(e)}});
app.get('/api/admin/products',auth,async(req,res,next)=>{try{res.json(await Product.find().sort({createdAt:-1}).lean());}catch(e){next(e)}});
function productFields(data){const name=str(data.name,120),category=str(data.category,30),price=Number(data.price);if(!name||!['Necklaces','Earrings','Bangles','Rings','Pendants','Other'].includes(category)||!Number.isFinite(price)||price<0)throw Error('VALIDATION');const imageUrl=str(data.imageUrl,1500);if(imageUrl&&!/^https?:\/\//i.test(imageUrl))throw Error('VALIDATION');const metal=str(data.metal,10)||'Gold';if(!['Gold','Silver'].includes(metal))throw Error('VALIDATION');const purity=str(data.purity,70),weight=(data.weight===''||data.weight==null)?null:Number(data.weight);
if(weight!==null&&(!Number.isFinite(weight)||weight<0))throw Error('VALIDATION');
const images=Array.isArray(data.images)?data.images.slice(0,7).map(v=>str(v,1500)).filter(v=>/^https:\/\//i.test(v)):[];
return {name,category,price,metal,purity,weight,images,description:str(data.description,2000),imageUrl,featured:data.featured===true,active:data.active!==false};}
app.post('/api/admin/products',auth,async(req,res,next)=>{try{res.status(201).json(await Product.create(productFields(req.body||{})));}catch(e){if(e.message==='VALIDATION')return fail(res,'Check name, category, price and image URL');next(e)}});
app.put('/api/admin/products/:id',auth,async(req,res,next)=>{try{const item=await Product.findByIdAndUpdate(req.params.id,productFields(req.body||{}),{new:true,runValidators:true});if(!item)return fail(res,'Product not found',404);res.json(item);}catch(e){if(e.message==='VALIDATION')return fail(res,'Invalid product fields');next(e)}});
app.delete('/api/admin/products/:id',auth,async(req,res,next)=>{try{const item=await Product.findByIdAndDelete(req.params.id);if(!item)return fail(res,'Product not found',404);res.json({message:'Product deleted'});}catch(e){next(e)}});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:12*1024*1024},fileFilter:(req,file,cb)=>cb(null,['image/jpeg','image/png','image/webp'].includes(file.mimetype))});
app.post('/api/admin/upload',auth,upload.single('image'),async(req,res,next)=>{try{if(!req.file)return fail(res,'Choose JPG, PNG or WEBP under 12 MB');if(!process.env.CLOUDINARY_CLOUD_NAME||!process.env.CLOUDINARY_API_KEY||!process.env.CLOUDINARY_API_SECRET)return fail(res,'Configure Cloudinary credentials on backend',503);cloudinary.config({cloud_name:process.env.CLOUDINARY_CLOUD_NAME,api_key:process.env.CLOUDINARY_API_KEY,api_secret:process.env.CLOUDINARY_API_SECRET,secure:true});const result=await new Promise((resolve,reject)=>{const stream=cloudinary.uploader.upload_stream({folder:'karthik-jewellers',resource_type:'image'},(err,result)=>err?reject(err):resolve(result));stream.end(req.file.buffer)});res.json({imageUrl:result.secure_url,imagePublicId:result.public_id});}catch(e){next(e)}});
app.get('/api/admin/customers',auth,async(req,res,next)=>{try{res.json(await Customer.find().sort({visitedAt:-1}).limit(1000).lean());}catch(e){next(e)}});
app.post('/api/admin/customers',auth,async(req,res,next)=>{try{const d=req.body||{};const name=str(d.name,120),phone=str(d.phone,20),email=str(d.email,250).toLowerCase();if(!name||!phone||email&&!validEmail(email))return fail(res,'Name, phone and a valid optional email are required');const marketingConsent=d.marketingConsent===true;const whatsappConsent=d.whatsappConsent===true;if(marketingConsent&&!email)return fail(res,'Email required for email consent');const visitedAt=d.visitedAt?new Date(d.visitedAt):new Date();if(Number.isNaN(visitedAt.getTime()))return fail(res,'Invalid visit date');const customer=await Customer.create({name,phone,email,visitedAt,interestedIn:str(d.interestedIn,100),notes:str(d.notes,2000),marketingConsent,whatsappConsent,unsubscribeToken:crypto.randomBytes(24).toString('hex')});res.status(201).json(customer);}catch(e){next(e)}});
app.get('/api/unsubscribe/:token',async(req,res,next)=>{try{await Customer.findOneAndUpdate({unsubscribeToken:req.params.token},{unsubscribed:true,marketingConsent:false});res.type('html').send('<!doctype html><title>Unsubscribed</title><main style="font:20px system-ui;padding:60px;text-align:center"><h1>You have been unsubscribed</h1><p>You will no longer receive Karthik Jewellers promotional emails.</p></main>');}catch(e){next(e)}});
app.get('/api/admin/stats',auth,async(req,res,next)=>{try{const [products,customers,subscribers]=await Promise.all([Product.countDocuments(),Customer.countDocuments(),Customer.countDocuments({email:{$ne:''},marketingConsent:true,unsubscribed:false})]);const [goldProducts,silverProducts,whatsappSubscribers]=await Promise.all([Product.countDocuments({metal:{$in:['Gold',null]}}),Product.countDocuments({metal:'Silver'}),Customer.countDocuments({whatsappConsent:true})]);res.json({products,customers,subscribers,goldProducts,silverProducts,whatsappSubscribers});}catch(e){next(e)}});
const htmlEscape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
app.post('/api/contact',rateLimit({windowMs:60*60*1000,limit:5}),async(req,res,next)=>{try{const {name,email,message,phone}=req.body||{};if(!str(name,120)||!validEmail(str(email,250))||str(message,2000).length<5)return fail(res,'Please enter a name, valid email and message');const currentStore=await getStore();if(!currentStore.email)return fail(res,'Shop contact email is not configured',503);const transport=mailTransport();await transport.sendMail({from:process.env.SMTP_FROM,to:currentStore.email,replyTo:str(email,250),subject:'Website enquiry from '+str(name,120),text:[str(message,2000),phone?'Phone: '+str(phone,30):''].filter(Boolean).join('\n\n')});res.json({message:'Your message was sent.'});}catch(e){if(e.message==='SMTP_NOT_CONFIGURED')return fail(res,'Email service not yet configured',503);next(e)}});
// Posters are uploaded with the existing authenticated Cloudinary image endpoint.
// Only HTTPS Cloudinary URLs are accepted for campaign attachments.
function posterUrl(v){const url=str(v,1500);if(!url)return '';let u;try{u=new URL(url)}catch{throw Error('INVALID_POSTER')};if(u.protocol!=='https:'||u.hostname!=='res.cloudinary.com')throw Error('INVALID_POSTER');return u.toString();}

function normalizeWhatsapp(phone){const digits=String(phone||'').replace(/\D/g,'');const result=digits.length===10?'91'+digits:digits;return /^\d{11,15}$/.test(result)?result:null;}
app.post('/api/admin/whatsapp/send',auth,rateLimit({windowMs:60*60*1000,limit:2}),async(req,res,next)=>{try{
 const poster=posterUrl(req.body?.posterUrl);
 const template=str(req.body?.templateName||process.env.WHATSAPP_TEMPLATE_NAME,100);
 const language=str(req.body?.language||process.env.WHATSAPP_TEMPLATE_LANGUAGE||'en',12);
 const token=process.env.WHATSAPP_ACCESS_TOKEN,phoneId=process.env.WHATSAPP_PHONE_NUMBER_ID;const graphVersion=/^v\d+\.\d+$/.test(process.env.WHATSAPP_GRAPH_API_VERSION||'')?process.env.WHATSAPP_GRAPH_API_VERSION:'v24.0';
 if(!poster||!template||!/^[-_a-z0-9]+$/.test(template)||!/^[-_a-z]{2,12}$/.test(language))return fail(res,'A Cloudinary poster and approved WhatsApp template are required');
 if(!token||!/^\d+$/.test(phoneId||''))return fail(res,'WhatsApp Business Cloud API credentials are not configured',503);
 if(req.body?.confirm!==true)return fail(res,'Explicit campaign confirmation required');
 const customers=await Customer.find({whatsappConsent:true}).select('name phone').limit(100).lean();
 if(!customers.length)return fail(res,'No WhatsApp opted-in customers found');
 let sent=0,failed=0;
 for(const customer of customers){const to=normalizeWhatsapp(customer.phone);if(!to){failed++;continue}
 try{
  const response=await fetch('https://graph.facebook.com/'+graphVersion+'/'+phoneId+'/messages',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to,type:'template',template:{name:template,language:{code:language},components:[{type:'header',parameters:[{type:'image',image:{link:poster}}]}]}}),signal:AbortSignal.timeout(12000)});
  if(response.ok)sent++;else{failed++;console.error('WhatsApp API rejected a campaign message:',response.status)}
 }catch(err){failed++;console.error('WhatsApp campaign delivery error:',err.message)}
 }
 res.json({sent,failed,total:customers.length,notice:'Submitted to WhatsApp; final delivery is not guaranteed'});
}catch(e){if(e.message==='INVALID_POSTER')return fail(res,'Poster must be a Cloudinary HTTPS image URL');next(e)}});
app.get('/api/admin/whatsapp/audience',auth,async(req,res,next)=>{try{const customers=await Customer.find({whatsappConsent:true}).select('name phone').limit(500).lean();res.json({customers});}catch(e){next(e)}});
app.post('/api/admin/campaigns/send',auth,rateLimit({windowMs:60*60*1000,limit:5}),async(req,res,next)=>{try{const subject=str(req.body?.subject,150),message=str(req.body?.message,5000);let poster;try{poster=posterUrl(req.body?.posterUrl)}catch{return fail(res,'Poster must be a Cloudinary HTTPS image URL')}if(subject.length<3||message.length<10)return fail(res,'Add a subject and message');const customers=await Customer.find({email:{$ne:''},marketingConsent:true,unsubscribed:false}).limit(500);if(!customers.length)return fail(res,'No opted-in customers available');const transport=mailTransport();const base=process.env.PUBLIC_BASE_URL||`http://localhost:${port}`;let sent=0;const errors=[];for(const c of customers){try{const unsubscribe=`${base}/api/unsubscribe/${c.unsubscribeToken}`;await transport.sendMail({attachments:poster?[{filename:'offer-poster.jpg',href:poster}]:[],from:process.env.SMTP_FROM,to:c.email,subject,text:`Hi ${c.name},\n\n${message}\n\nTo unsubscribe: ${unsubscribe}`,html:`<p>Hi ${htmlEscape(c.name)},</p><p>${htmlEscape(message).replace(/\n/g,'<br>')}</p><p><a href="${unsubscribe}">Unsubscribe</a></p>`});sent++;}catch(e){errors.push(c.email);}}res.json({sent,failed:errors.length,total:customers.length});}catch(e){if(e.message==='SMTP_NOT_CONFIGURED')return fail(res,'SMTP service not yet configured',503);next(e)}});
app.use('/api/savings', savingsRouter({adminAuth: auth, mailTransport, frontendOrigin: origin[0]}));
app.use('/api/orders', ordersRouter({adminAuth: auth, mailTransport, frontendOrigin: origin[0]}));
app.use(handleError);
async function start(){for(const key of ['MONGODB_URI','JWT_SECRET','ADMIN_USERNAME','ADMIN_PASSWORD'])if(!process.env[key])throw Error(`Missing ${key}`);if(process.env.JWT_SECRET.length<32)throw Error('JWT_SECRET must be at least 32 characters');await mongoose.connect(process.env.MONGODB_URI);await Promise.all([seed(), initializeSavings(), initializeOrders(), Customer.init()]);app.listen(port,()=>console.log(`Karthik Jewellers backend listening on ${port}`));}
if(process.env.NODE_ENV!=='test')start().catch(e=>{console.error(e.message);process.exit(1)});
export {app};
