import PostalMime from 'postal-mime';
import {enabled,now,domain} from './core.mjs';
export async function receiveTimed(message,env) {
 const address=message.to.toLowerCase();
 if(!enabled(env)) {
  // Keep the reserved namespace private even while the service is switched off.
  if(address.startsWith('vltemp-')) {
   const legacy=await env.db.prepare('SELECT 1 FROM account WHERE lower(email)=?').bind(address).first();
   if(!legacy){message.setReject('Private mailbox service disabled');return true;}
  }
  return false;
 }
 const box=await env.db.prepare('SELECT b.id,c.expires_at FROM timed_mailbox b JOIN timed_customer c ON c.id=b.customer_id WHERE b.email=? COLLATE NOCASE').bind(address).first();
 if(!box) {
  if(address.startsWith('vltemp-')&&address.endsWith('@'+domain(env))) {
   // Preserve any legacy account that already used this prefix before rollout.
   const legacy=await env.db.prepare('SELECT 1 FROM account WHERE lower(email)=?').bind(address).first();
   if(!legacy){message.setReject('Unknown private mailbox');return true;}
  }
  return false;
 }
 if(box.expires_at<=now()){message.setReject('Mailbox expired');return true;}
 const limit=1024*1024;
 if(message.rawSize>limit){message.setReject('Message exceeds 1 MiB');return true;}
 const reader=message.raw.getReader(),chunks=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();message.setReject('Message exceeds 1 MiB');return true;}chunks.push(value);}
 const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
 const parsed=await PostalMime.parse(raw);
 // HTML is never served/rendered. Attachments are metadata only; no public asset links.
 const text=parsed.text || String(parsed.html||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
 const time=now();
 const result=await env.db.prepare('INSERT INTO timed_message(id,mailbox_id,sender,subject,body,attachments,received_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM timed_mailbox b JOIN timed_customer c ON c.id=b.customer_id WHERE b.id=? AND c.expires_at>?)').bind(crypto.randomUUID(),box.id,String(parsed.from?.address||message.from).slice(0,500),String(parsed.subject||'(无主题)').slice(0,1000),text.slice(0,200000),JSON.stringify((parsed.attachments||[]).map(a=>({name:String(a.filename||'附件').slice(0,255),size:a.content?.byteLength||0}))),time,box.id,time).run();
 if(result.meta.changes!==1)message.setReject('Mailbox expired');
 return true;
}
