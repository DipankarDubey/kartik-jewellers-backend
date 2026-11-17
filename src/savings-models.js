import mongoose from 'mongoose';

const {Schema} = mongoose;
const ref = model => ({type: Schema.Types.ObjectId, ref: model, required: true});
const model = (name, fields, indexes = []) => {
  const schema = new Schema(fields, {timestamps: true});
  for (const [keys, options] of indexes) schema.index(keys, options);
  return mongoose.model(name, schema);
};

export const Account = model('SavingsAccount', {
  email: {type: String, required: true, unique: true},
  name: {type: String, required: true},
  lastLoginAt: Date,
  mobile: {type: String, unique: true, sparse: true},
  passwordHash: {type: String, select: false},
  authVersion: String,
  passwordEmailVerifiedAt: Date,
  temporaryPasswordUntil: Date,
  inviteState: String,
  inviteAttemptAt: Date,
  googleSubject: {type: String, unique: true, sparse: true, select: false},
  googleLinkedAt: Date
});
export const LoginCode = model('SavingsLoginCode', {
  email: {type: String, required: true, unique: true},
  name: String,
  mobile: String,
  mode: String,
  digest: String,
  attempts: Number,
  expiresAt: {type: Date, expires: 0}
});
export const Plan = model('SavingsPlan', {
  name: {type: String, required: true},
  description: String,
  amountPaise: {type: Number, required: true},
  months: {type: Number, required: true},
  bonusMonths: {type: Number, required: true},
  active: {type: Boolean, default: true}
});
export const Enrollment = model('SavingsEnrollment', {
  account: ref('SavingsAccount'),
  plan: ref('SavingsPlan'),
  name: String,
  amountPaise: Number,
  months: Number,
  bonusMonths: Number,
  startMonth: String
}, [[{account: 1, plan: 1}, {unique: true}]]);
export const Payment = model('SavingsPayment', {
  enrollment: ref('SavingsEnrollment'),
  installment: Number,
  amountPaise: Number,
  channel: {type: String, enum: ['paytm', 'offline']},
  status: {type: String, enum: ['pending', 'paid', 'failed']},
  orderId: {type: String, unique: true, sparse: true},
  gatewayTxn: {type: String, unique: true, sparse: true},
  checkoutToken: {type: String, select: false},
  startedAt: Date,
  paidAt: Date,
  paidMonth: String,
  reference: String,
  recordedBy: {type: Schema.Types.ObjectId, ref: 'Admin'}
}, [
  [{enrollment: 1, installment: 1}, {unique: true}],
  [{enrollment: 1, reference: 1}, {unique: true, partialFilterExpression: {channel: 'offline', reference: {$type: 'string'}}}],
  [{status: 1, paidMonth: 1}, {}]
]);

export const initializeSavings = () => Promise.all(
  [Account, LoginCode, Plan, Enrollment, Payment].map(collection => collection.init())
);
