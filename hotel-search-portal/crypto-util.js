const crypto=require('crypto');
function key(){
  const configured=process.env.CRED_ENCRYPTION_KEY||'';
  if(/^[0-9a-f]{64}$/i.test(configured)) return Buffer.from(configured,'hex');
  const jwt=process.env.JWT_SECRET||'';
  if(jwt.length>=32) return crypto.createHash('sha256').update(`hotel-portal-credentials:${jwt}`).digest();
  throw new Error('CRED_ENCRYPTION_KEY must be exactly 64 hex characters, or JWT_SECRET must be at least 32 characters');
}
function encrypt(text){if(!text)return '';const iv=crypto.randomBytes(12);const c=crypto.createCipheriv('aes-256-gcm',key(),iv);const enc=Buffer.concat([c.update(text,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),enc]).toString('base64');}
function decrypt(payload){if(!payload)return '';const b=Buffer.from(payload,'base64');const d=crypto.createDecipheriv('aes-256-gcm',key(),b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}
module.exports={encrypt,decrypt};
