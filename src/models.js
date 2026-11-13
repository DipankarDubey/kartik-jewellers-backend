import mongoose from 'mongoose';
const opts={timestamps:true};
const adminSchema=new mongoose.Schema({username:{type:String,required:true,unique:true},passwordHash:{type:String,required:true}},opts);
const productSchema=new mongoose.Schema({name:{type:String,required:true,trim:true,maxlength:120},category:{type:String,required:true,enum:['Necklaces','Earrings','Bangles','Rings','Pendants','Other']},price:{type:Number,required:true,min:0},description:{type:String,default:'',maxlength:2000},imageUrl:{type:String,default:''},imagePublicId:{type:String,default:''},featured:{type:Boolean,default:false},active:{type:Boolean,default:true}},opts);
const customerSchema=new mongoose.Schema({name:{type:String,required:true,trim:true,maxlength:120},phone:{type:String,required:true,trim:true,maxlength:20},email:{type:String,lowercase:true,trim:true,default:''},visitedAt:{type:Date,default:Date.now},interestedIn:{type:String,default:''},notes:{type:String,default:'',maxlength:2000},marketingConsent:{type:Boolean,default:false},unsubscribed:{type:Boolean,default:false},unsubscribeToken:{type:String,unique:true,sparse:true}},opts);
export const Admin=mongoose.model('Admin',adminSchema);
export const Product=mongoose.model('Product',productSchema);
export const Customer=mongoose.model('Customer',customerSchema);
