const crypto=require('crypto');
function key(){ if(!/^[0-9a-f]{64}$/i.test(process.env.CRED_ENCRYPTION_KEY||'')) throw new Error('CRED_ENCRYPTION_KEY must be exactly 64 hex characters'); return Buffer.from(process.env.CRED_ENCRYPTION_KEY,'hex'); }
function encrypt(text){ if(!text)return ''; const iv=crypto.randomBytes(12); const c=crypto.createCipheriv('aes-256-gcm',key(),iv); const enc=Buffer.concat([c.update(text,'utf8'),c.final()]); return Buffer.concat([iv,c.getAuthTag(),enc]).toString('base64'); }
function decrypt(payload){ if(!payload)return ''; const b=Buffer.from(payload,'base64'); const d=crypto.createDecipheriv('aes-256-gcm',key(),b.subarray(0,12)); d.setAuthTag(b.subarray(12,28)); return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8'); }
module.exports={encrypt,decrypt};
