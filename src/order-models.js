import mongoose from 'mongoose';

const {Schema} = mongoose;
const line = new Schema({
  product: Schema.Types.ObjectId, name: String, metal: String, quantity: Number, unitPaise: Number
}, {_id: false});
const orderSchema = new Schema({
  account: {type: Schema.Types.ObjectId, ref: 'SavingsAccount', required: true},
  email: String,
  orderId: {type: String, unique: true},
  items: [line],
  address: {name: String, phone: String, line1: String, line2: String, city: String, state: String, pin: String},
  offerCode: String,
  subtotalPaise: Number,
  discountPaise: Number,
  amountPaise: Number,
  status: {type: String, enum: ['pending', 'failed', 'paid', 'delivered'], required: true},
  checkoutToken: {type: String, select: false},
  paymentStartedAt: Date,
  gatewayTxn: {type: String, unique: true, sparse: true},
  paidAt: Date,
  deliveredAt: Date,
  deliveredBy: {type: Schema.Types.ObjectId, ref: 'Admin'},
  deliveryEmailState: {type: String, enum: ['sending', 'failed', 'sent']},
  deliveryEmailAttemptAt: Date,
  deliveryEmailSentAt: Date
}, {timestamps: true});
orderSchema.index({account: 1, createdAt: -1});
orderSchema.index({account: 1}, {unique: true, partialFilterExpression: {status: 'pending'}});
orderSchema.index({status: 1, createdAt: -1});

export const Order = mongoose.model('ShopOrder', orderSchema);
export const Offer = mongoose.model('ShopOffer', new Schema({
  code: {type: String, unique: true, required: true},
  percent: {type: Number, required: true},
  active: {type: Boolean, default: true}
}, {timestamps: true}));
export const initializeOrders = () => Promise.all([Order.init(), Offer.init()]);
