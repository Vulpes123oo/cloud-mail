import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {redeem,createStatement,hash,now} from '../src/timed/core.mjs';
import {timedApi} from '../src/timed/api.mjs';
import {receiveTimed} from '../src/timed/receive.mjs';
function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON;CREATE TABLE account(email TEXT);');sql.exec(readFileSync(new URL('../migrations/0001_timed_mail.sql',import.meta.url),'utf8'));
 const db={prepare(query){const statement=sql.prepare(query);let args=[];return{bind(...values){args=values;return this;},async first(){return statement.get(...args)||null;},async all(){return{results:statement.all(...args)};},async run(){return{meta:{changes:statement.run(...args).changes}};}};},async batch(statements){sql.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const customer=id=>sql.prepare('INSERT INTO timed_customer(id,username,password_hash,salt) VALUES(?,?,?,?)').run(id,id,'unused','salt');
 const card=async code=>sql.prepare('INSERT INTO timed_card(code_hash,issued_at) VALUES(?,?)').run(await hash(code),now());
 return{sql,db,customer,card,env:{db,TIMED_MAIL_ENABLED:'true',TIMED_MAIL_DOMAIN:'example.com'}};
}
test('redemption is one-use; renewal resets quota, extends time and retains immutable private addresses',async()=>{
 const f=fixture();f.customer('alice');f.customer('bob');await f.card('one');await f.card('two');
 assert.equal(await redeem(f.db,await hash('one'),'alice',1000),true);
 assert.equal(await redeem(f.db,await hash('one'),'bob',1001),false);
 for(let i=0;i<20;i++)await createStatement(f.db,String(i),`box${i}@example.com`,'alice',1001).run();
 await assert.rejects(createStatement(f.db,'extra','extra@example.com','alice',1001).run());
 assert.equal(await redeem(f.db,await hash('two'),'alice',1100),true);
 const user=f.sql.prepare('SELECT * FROM timed_customer WHERE id=?').get('alice');assert.equal(user.expires_at,2200);assert.equal(user.remaining,20);
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM timed_mailbox').get().n,20);
 assert.throws(()=>f.sql.exec("DELETE FROM timed_mailbox WHERE id='0'"));assert.throws(()=>f.sql.exec("UPDATE timed_mailbox SET customer_id='bob' WHERE id='0'"));
 assert.throws(()=>f.sql.exec("INSERT INTO account VALUES('BOX0@example.com')"));
 await assert.rejects(createStatement(f.db,'duplicate','BOX0@example.com','alice',1101).run());
 assert.equal(f.sql.prepare("SELECT remaining FROM timed_customer WHERE id='alice'").get().remaining,20);
 f.sql.exec("INSERT INTO account VALUES('previous@example.com');DELETE FROM account WHERE email='previous@example.com'");
 await assert.rejects(createStatement(f.db,'previous','previous@example.com','alice',1101).run());
 await assert.rejects(createStatement(f.db,'expired','expired@example.com','alice',2200).run());
 await f.card('three');await redeem(f.db,await hash('three'),'alice',3000);assert.equal(f.sql.prepare("SELECT expires_at FROM timed_customer WHERE id='alice'").get().expires_at,3600);
});
test('API registration replay, authentication, cross-user access, expiry, CSRF and send denial',async()=>{
 const f=fixture(),code='a'.repeat(48);await f.card(code);
 const call=(path,body,cookie,origin='https://mail.example.com')=>timedApi(new Request('https://mail.example.com/api/timed'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)}),f.env);
 const registration=await call('/register',{username:'alice',password:'long-password-here',code});assert.equal(registration.status,200);const alice=registration.headers.get('set-cookie').split(';')[0];
 assert.equal((await call('/register',{username:'bob',password:'long-password-here',code})).status,400);
 assert.equal((await call('/me')).status,401);assert.equal((await call('/mailboxes',{},alice,'https://evil.example')).status,403);
 const box=await(await call('/mailboxes',{},alice)).json();f.sql.prepare('INSERT INTO timed_message VALUES(?,?,?,?,?,?,?)').run('secret',box.id,'sender','private','body','[]',now());
 const bobCode='b'.repeat(48);await f.card(bobCode);const bob=(await call('/register',{username:'bob',password:'long-password-here',code:bobCode})).headers.get('set-cookie').split(';')[0];
 assert.equal((await call('/messages/secret',undefined,bob)).status,404);assert.equal((await(await call('/messages?mailbox='+box.id,undefined,bob)).json()).messages.length,0);
 assert.equal((await call('/send',{},alice)).status,404);assert.equal((await call('/messages/secret',undefined,alice)).status,200);
 f.sql.exec("UPDATE timed_customer SET expires_at=0 WHERE username='alice'");assert.equal((await call('/messages/secret',undefined,alice)).status,403);assert.equal((await call('/mailboxes',{},alice)).status,403);assert.equal((await call('/me',undefined,alice)).status,200);
 const renewal='c'.repeat(48);await f.card(renewal);assert.equal((await call('/redeem',{code:renewal},alice)).status,200);assert.equal((await call('/messages/secret',undefined,alice)).status,200);
 const login=await call('/login',{username:'alice',password:'long-password-here'});assert.equal(login.status,200);assert.equal((await call('/me',undefined,alice)).status,401);
 assert.equal((await call('/login',{username:'alice',password:'wrong-password-here'})).status,401);
});
test('parallel quota and card attempts have exactly one winning redemption and at most 20 mailboxes',async()=>{
 const f=fixture();f.customer('alice');f.customer('bob');await f.card('race');
 const digest=await hash('race');const attempts=await Promise.all(['alice','bob','alice','bob'].map(id=>redeem(f.db,digest,id,now())));
 assert.equal(attempts.filter(Boolean).length,1);
 const winner=f.sql.prepare('SELECT redeemed_by FROM timed_card').get().redeemed_by;
 const boxes=await Promise.allSettled(Array.from({length:35},(_,i)=>createStatement(f.db,String(i),`race${i}@example.com`,winner,now()).run()));
 assert.equal(boxes.filter(x=>x.status==='fulfilled').length,20);
});
test('inbound mail is isolated, rejects expired and oversized messages, and never forwards attachments',async()=>{
 const f=fixture();f.customer('alice');await f.card('receive');await redeem(f.db,await hash('receive'),'alice');await createStatement(f.db,'box','vltemp-box@example.com','alice',now()).run();
 const message=(to='vltemp-box@example.com',size)=>{let rejection;return{to,from:'sender@example.org',rawSize:size,raw:new Blob(['From: sender@example.org\r\nSubject: hello\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<b>private</b><script>alert(1)</script>']).stream(),setReject(value){rejection=value;},get rejection(){return rejection;},forward(){throw Error('Must never forward');}};};
 const accepted=message();assert.equal(await receiveTimed(accepted,f.env),true);assert.equal(accepted.rejection,undefined);assert.equal(f.sql.prepare('SELECT body FROM timed_message').get().body.trim(),'private');
 const oversized=message(undefined,2*1024*1024);await receiveTimed(oversized,f.env);assert.match(oversized.rejection,/exceeds/);
 const unknown=message('vltemp-unknown@example.com');await receiveTimed(unknown,f.env);assert.match(unknown.rejection,/Unknown/);
 const legacy=message('owner@example.com');assert.equal(await receiveTimed(legacy,f.env),false);
 const disabled=message();assert.equal(await receiveTimed(disabled,{...f.env,TIMED_MAIL_ENABLED:'false'}),true);assert.match(disabled.rejection,/disabled/);
 f.sql.exec("UPDATE timed_customer SET expires_at=0");const expired=message();await receiveTimed(expired,f.env);assert.match(expired.rejection,/expired/);assert.equal(f.sql.prepare('SELECT count(*) n FROM timed_message').get().n,1);
});
