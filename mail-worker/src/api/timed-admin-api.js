import app from '../hono/hono';
import {random,hash,now,enabled} from '../timed/core.mjs';
app.get('/timed-admin/status',c=>{
 if(!c.env.admin || c.get('user')?.email!==c.env.admin)return c.json({error:'仅管理员可管理卡密'},403);
 if(!enabled(c.env))return c.json({error:'卡密邮箱尚未启用'},503);
 return c.json({ok:true},{headers:{'Cache-Control':'no-store'}});
});
app.post('/timed-admin/cards',async c=>{
 if(!c.env.admin || c.get('user')?.email!==c.env.admin)return c.json({error:'仅管理员可生成卡密'},403);
 if(!enabled(c.env))return c.json({error:'卡密邮箱尚未启用'},503);
 const {count}=await c.req.json();
 if(!Number.isInteger(count)||count<1||count>100)return c.json({error:'数量需为 1–100'},400);
 const codes=Array.from({length:count},random);
 const hashes=await Promise.all(codes.map(hash));
 await c.env.db.batch(hashes.map(value=>c.env.db.prepare('INSERT INTO timed_card(code_hash,issued_at) VALUES(?,?)').bind(value,now())));
 return c.json({codes},{headers:{'Cache-Control':'no-store'}});
});
