export const now = () => Math.floor(Date.now() / 1000);
export const random = () => [...crypto.getRandomValues(new Uint8Array(24))].map(x => x.toString(16).padStart(2, '0')).join('');
export async function hash(value) {
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function passwordHash(password, salt) {
 const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
 const bits = await crypto.subtle.deriveBits({name:'PBKDF2', salt:new TextEncoder().encode(salt), iterations:100000, hash:'SHA-256'}, key, 256);
 return [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2,'0')).join('');
}
export function equal(a,b) {
 if (a.length !== b.length) return false;
 let difference=0; for(let i=0;i<a.length;i++) difference |= a.charCodeAt(i)^b.charCodeAt(i);
 return difference===0;
}
export const redeemStatement = (db, codeHash, customerId, time) => db.prepare(
 'UPDATE timed_card SET redeemed_by=?,redeemed_at=? WHERE code_hash=? AND redeemed_by IS NULL RETURNING code_hash'
).bind(customerId,time,codeHash);
export const createStatement = (db,id,email,customerId,time) => db.prepare(
 'INSERT INTO timed_mailbox(id,email,customer_id,created_at) VALUES(?,?,?,?)'
).bind(id,email,customerId,time);
export async function redeem(db, codeHash, customerId, time=now()) {
 return Boolean(await redeemStatement(db,codeHash,customerId,time).first());
}
export function enabled(env) {return String(env.TIMED_MAIL_ENABLED)==='true';}
export function domain(env) {
 const value=String(env.TIMED_MAIL_DOMAIN || '').toLowerCase();
 if(!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(value)) throw Error('TIMED_MAIL_DOMAIN is not configured');
 return value;
}
