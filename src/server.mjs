import crypto from 'node:crypto';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT) || 3000;
const loginUrl = 'https://clients.complexelite.com/studio/login?app=tools';
const exchangeUrl = process.env.PERFEX_SSO_EXCHANGE_URL || 'https://clients.complexelite.com/studio/sso/exchange';
const secret = process.env.STUDIO_SSO_SECRET || '';
const apiSecret = process.env.TOOLS_API_SECRET || '';
const cookieName = 'ce_tools_session';
const stateName = 'ce_tools_state';
const nextName = 'ce_tools_next';
const ttl = 8 * 60 * 60 * 1000;
const sessions = new Map();
const tools = {
  hyperframes: {name:'HyperFrames', source:'https://github.com/heygen-com/hyperframes', command:'hyperframes', args:['--version'], purpose:'Timeline-based video projects, preview, and render orchestration.'},
  ffmpeg: {name:'FFmpeg', source:'https://github.com/FFmpeg/FFmpeg', command:'ffmpeg', args:['-version'], purpose:'Audio/video encode, decode, mux, demux, and media processing runtime.'},
};
const pages = new Map([
  ['/hyperframes','hyperframes'], ['/hyperframes/','hyperframes'],
  ['/ffmpeg','ffmpeg'], ['/ffmpeg/','ffmpeg'],
]);
function send(res,status,body,type='text/plain; charset=utf-8',headers={}) {
  res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',...headers}); res.end(body);
}
function cookies(req) { return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split(/=(.*)/s).slice(0,2)).filter(([k,v])=>k&&v!==undefined)); }
function session(req) { const token=cookies(req)[cookieName], value=sessions.get(token); if(!value||value.expires<=Date.now()){sessions.delete(token);return null;} return {token,...value}; }
function cookie(name,value,age) {return `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`}
function esc(x) { return String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function page(slug,user,status) {
 const t=tools[slug]; const peer=slug==='hyperframes'?'ffmpeg':'hyperframes';
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${t.name} · Complex Elite Tools</title><link rel="stylesheet" href="/assets/tools.css"></head><body><main><header><a href="/">Complex Elite Tools</a><form method="post" action="/auth/logout"><button>Sign out · ${esc(user.name)}</button></form></header><p class="eyebrow">PRIVATE TOOL RUNTIME</p><h1>${t.name}</h1><p class="lead">${t.purpose}</p><nav><a ${slug==='hyperframes'?'aria-current="page"':''} href="/hyperframes">HyperFrames</a><a ${slug==='ffmpeg'?'aria-current="page"':''} href="/ffmpeg">FFmpeg</a></nav><section><div class="state"><span class="dot ${status.ok?'good':'bad'}"></span><b>${status.ok?'Installed and responding':'Runtime check failed'}</b></div><dl><dt>Version</dt><dd>${esc(status.version)}</dd><dt>Build</dt><dd>${esc(status.detail)}</dd><dt>Upstream</dt><dd><a href="${t.source}" target="_blank" rel="noreferrer">${t.source}</a></dd><dt>Integration</dt><dd>Private status page · fixed health probe only</dd></dl><form method="get" action="/${slug}"><button class="primary">Refresh runtime check</button></form></section><aside>Staff sign-in is verified by clients.complexelite.com. This page does not provide shell access or accept arbitrary commands.</aside><footer>Complex Elite · Tools platform</footer></main></body></html>`;
}
async function probe(slug) {
 const t=tools[slug];
 try { const {stdout,stderr}=await execFileAsync(t.command,t.args,{timeout:10000,maxBuffer:65536,env:{...process.env,HOME:'/tmp'}}); return {ok:true,version:(stdout||stderr).split('\n').find(Boolean)?.trim()||'Installed',detail:slug==='ffmpeg'?'FFmpeg source build · network protocols disabled':'HyperFrames npm release 0.8.226 · Node.js '+process.versions.node}; }
 catch(e) { return {ok:false,version:'Unavailable',detail:e.code==='ENOENT'?'The executable was not found in this runtime.':'The fixed version probe failed.'}; }
}
function authenticatedApi(req) {
 if(!apiSecret) return false;
 const ts=String(req.headers['x-ce-timestamp']||''), sig=String(req.headers['x-ce-signature']||'');
 if(!/^\d{10}$/.test(ts)||Math.abs(Math.floor(Date.now()/1000)-Number(ts))>60||! /^[a-f0-9]{64}$/i.test(sig)) return false;
 return crypto.timingSafeEqual(Buffer.from(sig.toLowerCase()),Buffer.from(crypto.createHmac('sha256',apiSecret).update(`${ts}\n${req.method}\n${new URL(req.url,'http://tools.internal').pathname}`).digest('hex')));
}
async function handle(req,res) {
 const url=new URL(req.url||'/', 'http://tools.internal'), path=url.pathname;
 if(path==='/healthz'&&req.method==='GET') return send(res,200,'ok');
 if(path==='/auth/login'&&req.method==='GET') {
   const requested=url.searchParams.get('next')||'/hyperframes', next=pages.has(requested)?requested:'/hyperframes';
   const state=crypto.randomBytes(32).toString('hex'), target=new URL(loginUrl); target.searchParams.set('state',state);
   return send(res,303,'','text/plain; charset=utf-8',{Location:target.toString(),'Set-Cookie':[cookie(stateName,state,300),cookie(nextName,encodeURIComponent(next),300)]});
 }
 if(path==='/auth/perfex'&&req.method==='GET') {
   const code=url.searchParams.get('code')||'', state=url.searchParams.get('state')||'', saved=cookies(req)[stateName]||'';
   if(!secret||!/^[a-f0-9]{64}$/i.test(code)||!/^[a-f0-9]{64}$/i.test(state)||!crypto.timingSafeEqual(Buffer.from(state.toLowerCase()),Buffer.from(saved.toLowerCase()))) return send(res,400,'Invalid or expired Perfex sign-in handoff.');
   const timestamp=String(Math.floor(Date.now()/1000)), signature=crypto.createHmac('sha256',secret).update(`${timestamp}\n${code}`).digest('hex');
   try {
    const response=await fetch(exchangeUrl,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Studio-Timestamp':timestamp,'X-Studio-Signature':signature},body:new URLSearchParams({code,app:'tools'}),signal:AbortSignal.timeout(10000),redirect:'error'});
    const result=await response.json(); if(!response.ok||result.ok!==true||!result.user||!Number.isInteger(Number(result.user.id))) return send(res,401,'Perfex sign-in expired or could not be verified.');
    const token=crypto.randomBytes(32).toString('base64url'); sessions.set(token,{user:{id:Number(result.user.id),name:String(result.user.name||'Perfex user'),email:String(result.user.email||''),role:String(result.user.role||'staff')},expires:Date.now()+ttl});
    const next=decodeURIComponent(cookies(req)[nextName]||'/hyperframes'); return send(res,303,'','text/plain; charset=utf-8',{Location:pages.has(next)?next:'/hyperframes','Set-Cookie':[cookie(cookieName,token,ttl/1000),cookie(stateName,'',0),cookie(nextName,'',0)]});
   } catch {return send(res,502,'Perfex sign-in could not be reached. Retry shortly.');}
 }
 if(path==='/auth/logout'&&req.method==='POST') {const host=req.headers.host||'',origin=req.headers.origin||''; if(origin&&!origin.endsWith(`://${host}`))return send(res,403,'Request refused.'); const s=session(req);if(s)sessions.delete(s.token);return send(res,303,'','text/plain; charset=utf-8',{Location:'/hyperframes','Set-Cookie':cookie(cookieName,'',0)});}
 if(path==='/') return send(res,302,'','text/plain; charset=utf-8',{Location:'/hyperframes'});
 const api=path.match(/^\/api\/v1\/runtime\/(hyperframes|ffmpeg)$/);
 if(api&&req.method==='GET') {if(!authenticatedApi(req))return send(res,401,JSON.stringify({ok:false,error:'Unauthorized'}),'application/json');return send(res,200,JSON.stringify(await probe(api[1])),'application/json');}
 const slug=pages.get(path);
 if(slug) {const s=session(req); if(!s)return send(res,302,'','text/plain; charset=utf-8',{Location:`/auth/login?next=${encodeURIComponent(path)}`}); return send(res,200,page(slug,s.user,await probe(slug)),'text/html; charset=utf-8',{'Content-Security-Policy':"default-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});}
 if(path==='/assets/tools.css') {const fs=await import('node:fs/promises');return send(res,200,await fs.readFile(new URL('../public/tools.css',import.meta.url)),'text/css; charset=utf-8');}
 return send(res,404,'Not found.');
}
setInterval(()=>{const now=Date.now();for(const [key,s] of sessions)if(s.expires<=now)sessions.delete(key)},60000).unref();
http.createServer((req,res)=>{void handle(req,res).catch(()=>send(res,500,'Request could not be completed.'))}).listen(port,'0.0.0.0');
