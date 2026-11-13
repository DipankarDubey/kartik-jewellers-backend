import bcrypt from 'bcryptjs';
import {Admin,Product} from './models.js';
const initialProducts=[
  ['Royal Gold Necklace','Necklaces',125000,'Traditional bridal necklace with elegant gold detailing',1,true],
  ['Diamond Drop Earrings','Earrings',72000,'Sparkling drop earrings for every occasion',2,true],
  ['Heritage Gold Bangle','Bangles',58000,'Intricately designed timeless bangle',3,false],
  ['Classic Diamond Ring','Rings',95000,'An elegant ring crafted for special moments',4,true],
  ['Temple Gold Necklace','Necklaces',180000,'Statement temple-inspired gold jewellery',5,false],
  ['Golden Jhumka Earrings','Earrings',65000,'Traditional jhumkas with delicate detail',6,false]
];
export async function seed(){
 const username=process.env.ADMIN_USERNAME;const password=process.env.ADMIN_PASSWORD;
 if(!username||!password||password.length<12)throw new Error('Set ADMIN_USERNAME and ADMIN_PASSWORD (minimum 12 characters) in .env');
 // Does not overwrite an existing admin password on every restart.
 const existing=await Admin.findOne({username});
 if(!existing)await Admin.create({username,passwordHash:await bcrypt.hash(password,12)});
 // Seed only when setting up the first admin, never after deliberate product deletions.
 if(!existing && await Product.countDocuments()===0){await Product.insertMany(initialProducts.map(([name,category,price,description,num,featured])=>({name,category,price,description,imageUrl:`${process.env.FRONTEND_URL||'http://localhost:5173'}/images/jewel-${num}.webp`,featured})));console.log('Created six editable sample products.');}
}
