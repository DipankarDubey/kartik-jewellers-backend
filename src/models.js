import mongoose from 'mongoose';
const opts={timestamps:true};
const adminSchema=new mongoose.Schema({username:{type:String,required:true,unique:true},passwordHash:{type:String,required:true}},opts);
const productSchema=new mongoose.Schema({name:{type:String,required:true,trim:true,maxlength:120},category:{type:String,required:true,enum:['Necklaces','Earrings','Bangles','Rings','Pendants','Other']},price:{type:Number,required:true,min:0},metal:{type:String,enum:['Gold','Silver'],default:'Gold'},description:{type:String,default:'',maxlength:2000},purity:{type:String,default:'',maxlength:70},weight:{type:Number,min:0,default:null},images:{type:[String],default:[]},imageUrl:{type:String,default:''},imagePublicId:{type:String,default:''},featured:{type:Boolean,default:false},active:{type:Boolean,default:true}},opts);
const customerSchema=new mongoose.Schema({name:{type:String,required:true,trim:true,maxlength:120},phone:{type:String,default:'',trim:true,maxlength:20},savingsAccount:{type:mongoose.Schema.Types.ObjectId,ref:'SavingsAccount',unique:true,sparse:true},source:{type:String,default:'store'},removedAt:Date,emailVerifiedAt:Date,lastPortalLoginAt:Date,googleLinkedAt:Date,emailMarketingOptInAt:Date,email:{type:String,lowercase:true,trim:true,default:''},visitedAt:{type:Date,default:Date.now},interestedIn:{type:String,default:''},notes:{type:String,default:'',maxlength:2000},marketingConsent:{type:Boolean,default:false},whatsappConsent:{type:Boolean,default:false},unsubscribed:{type:Boolean,default:false},unsubscribeToken:{type:String,unique:true,sparse:true}},opts);
export const Admin=mongoose.model('Admin',adminSchema);
export const Product=mongoose.model('Product',productSchema);
export const Customer=mongoose.model('Customer',customerSchema);

const settingsSchema=new mongoose.Schema({key:{type:String,unique:true,default:'store'},name:{type:String,default:'Karthik Jewellers'},email:{type:String,default:''},phone:{type:String,default:''},address:{type:String,default:''},mapsUrl:{type:String,default:''},logoUrl:{type:String,default:''},faviconUrl:{type:String,default:''}},opts);
export const StoreSettings=mongoose.model('StoreSettings',settingsSchema);
