import {now,random,hash,passwordHash,equal,redeem,createStatement,enabled,domain} from './core.mjs';
const cookieName='__Host-vulpe-mail';
const response=(data,status=200,headers={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store',...headers}});
const sessionCookie=token=>`${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800`;
export async function timedApi(request,env) {
 if(!enabled(env)) return response({error:'卡密邮箱尚未启用'},503);
 try { return await handle(request,env); }
 catch(error) {
  if(error.message?.includes('Mailbox quota or time exhausted')) return response({error:'使用时间已到或本轮名额已用完'},409);
  console.error('Timed mailbox request failed',error.name);
  return response({error:'操作失败，请稍后重试'},500);
 }
}
async function handle(request,env) {
 const url=new URL(request.url), path=url.pathname.slice('/api/timed'.length), time=now(), db=env.db;
 if(!['GET','POST'].includes(request.method)) return response({error:'不支持此操作'},405);
 let body={};
 if(request.method==='POST') {
  if(request.headers.get('Origin')!==url.origin) return response({error:'请求来源无效'},403);
  if(!request.headers.get('Content-Type')?.startsWith('application/json')) return response({error:'需要 JSON 请求'},415);
  // Stream with a hard cap, including requests without Content-Length.
  const reader=request.body?.getReader(); let bytes=0,chunks=[];
  if(reader) while(true) {const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>4096){await reader.cancel();return response({error:'请求过大'},413);}chunks.push(value);}
  const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.length;}
  try {body=JSON.parse(new TextDecoder().decode(buffer));if(!body || typeof body!=='object'||Array.isArray(body))throw Error();} catch{return response({error:'请求格式错误'},400);}
 }
 if(request.method==='POST' && ['/register','/login'].includes(path)) {
  const rateKey=await hash(request.headers.get('CF-Connecting-IP') || 'local');
  const bucket=Math.floor(time/900);
  const rate=await db.prepare('INSERT INTO timed_rate(key,bucket,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET bucket=excluded.bucket,count=CASE WHEN bucket=excluded.bucket THEN count+1 ELSE 1 END RETURNING count').bind(rateKey,bucket).first();
  if(rate.count>20) return response({error:'尝试过于频繁，请 15 分钟后重试'},429);
  const username=String(body.username||'').toLowerCase(),password=String(body.password||'');
  if(!/^[a-z0-9_-]{3,40}$/.test(username)||password.length<12||password.length>128) return response({error:'账号需 3–40 位字母、数字或下划线，密码需 12–128 位'},400);
  const token=random(),tokenHash=await hash(token);
  if(path==='/register') {
   const code=String(body.code||'').trim(); if(!/^[a-f0-9]{48}$/.test(code)) return response({error:'卡密无效或已使用'},400);
   const id=crypto.randomUUID(),salt=random(),pass=await passwordHash(password,salt),codeHash=await hash(code);
   let results;
   try { results=await db.batch([
    db.prepare('INSERT INTO timed_customer(id,username,password_hash,salt) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM timed_card WHERE code_hash=? AND redeemed_by IS NULL)').bind(id,username,pass,salt,codeHash),
    db.prepare('UPDATE timed_card SET redeemed_by=?,redeemed_at=? WHERE code_hash=? AND redeemed_by IS NULL AND EXISTS(SELECT 1 FROM timed_customer WHERE id=?)').bind(id,time,codeHash,id),
    db.prepare('INSERT INTO timed_session(token_hash,customer_id,expires_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM timed_card WHERE code_hash=? AND redeemed_by=?)').bind(tokenHash,id,time+604800,codeHash,id)
   ]);} catch(error) {if(error.message?.includes('UNIQUE')) return response({error:'账号已存在'},409);throw error;}
   if(results[0].meta.changes!==1) return response({error:'卡密无效或已使用'},400);
  } else {
   const user=await db.prepare('SELECT * FROM timed_customer WHERE username=?').bind(username).first();
   const candidate=await passwordHash(password,user?.salt||'invalid-user-timing-salt');
   if(!user||!equal(candidate,user.password_hash)) return response({error:'账号或密码不正确'},401);
   await db.batch([db.prepare('DELETE FROM timed_session WHERE customer_id=?').bind(user.id),db.prepare('INSERT INTO timed_session VALUES(?,?,?)').bind(tokenHash,user.id,time+604800)]);
  }
  return response({ok:true},200,{'Set-Cookie':sessionCookie(token)});
 }
 const token=(request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';
 if(!/^[a-f0-9]{48}$/.test(token)) return response({error:'请先登录'},401);
 const tokenHash=await hash(token);
 const user=await db.prepare('SELECT c.* FROM timed_session s JOIN timed_customer c ON c.id=s.customer_id WHERE s.token_hash=? AND s.expires_at>?').bind(tokenHash,time).first();
 if(!user) return response({error:'登录已失效，请重新登录'},401);
 if(path==='/logout'&&request.method==='POST') {await db.prepare('DELETE FROM timed_session WHERE token_hash=?').bind(tokenHash).run();return response({ok:true},200,{'Set-Cookie':`${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`});}
 if(path==='/me'&&request.method==='GET') {
  const boxes=await db.prepare('SELECT id,email,created_at FROM timed_mailbox WHERE customer_id=? ORDER BY created_at DESC,id').bind(user.id).all();
  return response({username:user.username,expiresAt:user.expires_at,remaining:user.remaining,serverTime:time,mailboxes:boxes.results});
 }
 if(path==='/redeem'&&request.method==='POST') {
  const code=String(body.code||'').trim();
  if(!/^[a-f0-9]{48}$/.test(code)||!await redeem(db,await hash(code),user.id,time)) return response({error:'卡密无效或已使用'},400);
  return response({ok:true});
 }
 if(user.expires_at<=time) return response({error:'使用时间已到，请兑换新卡密'},403);
 if(path==='/mailboxes'&&request.method==='POST') {
  const id=crypto.randomUUID(),email=`vltemp-${random()}@${domain(env)}`;
  await createStatement(db,id,email,user.id,now()).run();return response({id,email},201);
 }
 if(path==='/messages'&&request.method==='GET') {
  const box=url.searchParams.get('mailbox')||'';
  const rows=await db.prepare('SELECT m.id,m.sender,m.subject,m.received_at FROM timed_message m JOIN timed_mailbox b ON b.id=m.mailbox_id JOIN timed_customer c ON c.id=b.customer_id WHERE b.id=? AND b.customer_id=? AND c.expires_at>? ORDER BY m.received_at DESC,m.id DESC LIMIT 100').bind(box,user.id,now()).all();
  return response({messages:rows.results});
 }
 if(path.startsWith('/messages/')&&request.method==='GET') {
  const row=await db.prepare('SELECT m.* FROM timed_message m JOIN timed_mailbox b ON b.id=m.mailbox_id JOIN timed_customer c ON c.id=b.customer_id WHERE m.id=? AND b.customer_id=? AND c.expires_at>?').bind(path.slice('/messages/'.length),user.id,now()).first();
  return row?response(row):response({error:'邮件不存在或无法访问'},404);
 }
 return response({error:'接口不存在'},404);
}
