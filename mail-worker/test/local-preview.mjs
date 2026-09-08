// Local-only test harness. Never imported by the production Worker.
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {timedApi} from '../src/timed/api.mjs';
import {hash} from '../src/timed/core.mjs';
const sql=new DatabaseSync(':memory:');sql.exec('CREATE TABLE account(email TEXT);');sql.exec(readFileSync(new URL('../migrations/0001_timed_mail.sql',import.meta.url),'utf8'));
const db={prepare(query){const statement=sql.prepare(query);let args=[];return{bind(...values){args=values;return this;},async first(){return statement.get(...args)||null;},async all(){return{results:statement.all(...args)};},async run(){return{meta:{changes:statement.run(...args).changes}};}};},async batch(statements){sql.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results;}catch(e){sql.exec('ROLLBACK');throw e;}}};
for(const char of ['a','b','c'])sql.prepare('INSERT INTO timed_card(code_hash,issued_at) VALUES(?,0)').run(await hash(char.repeat(48)));
const env={db,TIMED_MAIL_ENABLED:'true',TIMED_MAIL_DOMAIN:'example.com'};
createServer(async(req,res)=>{try{
 const origin='http://localhost:4187';let output;
 if(req.url.startsWith('/api/timed/')){let bytes=[];for await(const chunk of req)bytes.push(chunk);output=await timedApi(new Request(origin+req.url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(bytes)}:{})}),env);}
 else{const path=req.url==='/timed/'?'index.html':req.url.split('/').pop();if(!['index.html','app.js','style.css','admin.html','admin.js'].includes(path)){res.writeHead(404);res.end();return;}output=new Response(readFileSync(new URL('../../mail-vue/public/timed/'+path,import.meta.url)),{headers:{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html'}});}
 res.writeHead(output.status,Object.fromEntries(output.headers));res.end(Buffer.from(await output.arrayBuffer()));
 }catch(e){res.writeHead(500);res.end('Preview error');console.error(e);}}).listen(4187,'127.0.0.1',()=>console.log('Local preview: http://localhost:4187/timed/; test cards: a/b/c repeated 48 times'));
