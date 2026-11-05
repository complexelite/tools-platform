import crypto from 'node:crypto';
import http from 'node:http';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,access,mkdtemp,stat,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createWriteStream,createReadStream} from 'node:fs';
import {Transform} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';

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
const previewPort = Number(process.env.HYPERFRAMES_PREVIEW_PORT) || 3002;
const projectDir = path.join(process.env.HYPERFRAMES_DATA_DIR || '/data/hyperframes', 'default');
let previewProcess;
let activeConversions=0;
const maxUploadBytes=500*1024*1024;
const conversionPresets={
 mp4:{ext:'mp4',mime:'video/mp4',args:['-map','0:v:0','-map','0:a:0?','-c:v','mpeg4','-q:v','5','-c:a','aac','-b:a','192k','-movflags','+faststart']},
 m4a:{ext:'m4a',mime:'audio/mp4',args:['-map','0:a:0','-vn','-c:a','aac','-b:a','192k']},
 flac:{ext:'flac',mime:'audio/flac',args:['-map','0:a:0','-vn','-c:a','flac']},
 wav:{ext:'wav',mime:'audio/wav',args:['-map','0:a:0','-vn','-c:a','pcm_s16le']},
};
const tools = {
  hyperframes: {name:'HyperFrames', source:'https://github.com/heygen-com/hyperframes', command:'hyperframes', args:['--version'], purpose:'Timeline-based video projects, preview, and render orchestration.'},
  ffmpeg: {name:'FFmpeg', source:'https://github.com/FFmpeg/FFmpeg', command:'ffmpeg', args:['-version'], purpose:'Audio/video encode, decode, mux, demux, and media processing runtime.'},
};
const pages = new Map([
  ['/','catalog'],
  ['/hyperframes','hyperframes'], ['/hyperframes/','hyperframes'],
  ['/ffmpeg','ffmpeg'], ['/ffmpeg/','ffmpeg'],
  ['/google-maps-scraper','google-maps-scraper'], ['/google-maps-scraper/','google-maps-scraper'],
  ['/openreply','openreply'], ['/openreply/','openreply'],
  ['/scrapling','scrapling'], ['/scrapling/','scrapling'],
  ['/ai-video-captions','ai-video-captions'], ['/ai-video-captions/','ai-video-captions'],
]);
const mapsRootPaths=['/static/','/scrape','/download','/delete','/jobs','/view','/api/docs','/api/v1/'];
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
function catalogPage(user) {
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Complex Elite Tools</title><link rel="stylesheet" href="/assets/tools.css"></head><body><main><header><a href="/">Complex Elite Media Group</a><form method="post" action="/auth/logout"><button>Sign out · ${esc(user.name)}</button></form></header><p class="eyebrow">PRIVATE TOOL RUNTIME</p><h1>Tools</h1><p class="lead">Open an installed tool. Each tool has its own address and stays behind your Perfex staff sign-in.</p><section class="tool-list"><article><h2>HyperFrames</h2><p class="muted">Create, preview, and render timeline-based video projects.</p><a class="tool-link" href="/hyperframes">Open HyperFrames →</a><p class="muted"><small>tools.complexelite.com/hyperframes</small></p></article><article><h2>FFmpeg</h2><p class="muted">Convert video and audio files using fixed, reviewed presets.</p><a class="tool-link" href="/ffmpeg">Open FFmpeg →</a><p class="muted"><small>tools.complexelite.com/ffmpeg</small></p></article><article><h2>Google Maps Scraper</h2><p class="muted">Search and export Google Maps business results from the Tools-hosted service. Protected by Perfex sign-in.</p><a class="tool-link" href="/google-maps-scraper">Open Google Maps Scraper →</a><p class="muted"><small><a href="https://github.com/complexelite/google-maps-scraper">GitHub source</a></small></p></article><article><h2>OpenReply</h2><p class="muted">Instagram comment-to-DM campaigns and inbox. Migrated to the Tools-hosted stack with its existing account data and provider configuration.</p><a class="tool-link" href="/openreply">Open OpenReply →</a><p class="muted"><small><a href="https://github.com/complexelite/openreply">GitHub source</a> · the app keeps its existing magic-link sign-in and provider callbacks.</small></p></article><article><h2>Scrapling</h2><p class="muted">Scraping library and MCP service for connected agents. MCP requests still require Scrapling’s bearer token.</p><a class="tool-link" href="/scrapling">View Scrapling connection →</a><p class="muted"><small><a href="https://github.com/complexelite/Scrapling">GitHub source</a></small></p></article><article><h2>AI Video Captions</h2><p class="muted">Generate animated subtitles with Whisper and FFmpeg. Uploads and results stay on the VPS with a 24-hour cleanup policy.</p><a class="tool-link" href="/ai-video-captions">Open AI Video Captions →</a><p class="muted"><small><a href="https://github.com/complexelite/ai-video-captions">GitHub source</a></small></p></article></section><aside>Only installed routes are opened here. Unknown paths return 404.</aside><footer>Complex Elite · Tools platform</footer></main></body></html>`;
}
function scraplingPage(user) {
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Scrapling · Complex Elite Tools</title><link rel="stylesheet" href="/assets/tools.css"></head><body><main><header><a href="/">Complex Elite Tools</a><form method="post" action="/auth/logout"><button>Sign out · ${esc(user.name)}</button></form></header><p class="eyebrow">PRIVATE MCP SERVICE</p><h1>Scrapling</h1><p class="lead">Scrapling is an MCP endpoint for connected agents, not a browser application.</p><section><div class="state"><span class="dot good"></span><b>Service installed</b></div><dl><dt>Endpoint</dt><dd><code>https://tools.complexelite.com/scrapling/mcp</code></dd><dt>Authentication</dt><dd>Configure the existing Scrapling bearer token in the MCP client. The service rejects requests without it.</dd><dt>Source</dt><dd><a href="https://github.com/complexelite/Scrapling" target="_blank" rel="noreferrer">complexelite/Scrapling</a></dd></dl></section><aside>Perfex sign-in protects this information page. MCP calls are separately checked by Scrapling’s bearer-token authentication.</aside><footer>Complex Elite · Tools platform</footer></main></body></html>`;
}
function ffmpegPage(user,status) {
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>FFmpeg · Complex Elite Tools</title><link rel="stylesheet" href="/assets/tools.css"><script src="/assets/ffmpeg.js" defer></script></head><body><main><header><a href="/">Complex Elite Tools</a><form method="post" action="/auth/logout"><button>Sign out · ${esc(user.name)}</button></form></header><p class="eyebrow">PRIVATE MEDIA TOOL</p><h1>FFmpeg</h1><p class="lead">Convert a video or audio file using the installed FFmpeg engine. Choose a preset, upload a file, then download the finished result.</p><nav><a href="/hyperframes">HyperFrames editor</a><a aria-current="page" href="/ffmpeg">FFmpeg converter</a></nav><section><div class="state"><span class="dot ${status.ok?'good':'bad'}"></span><b>${status.ok?'FFmpeg installed and responding':'FFmpeg runtime check failed'}</b></div><p class="muted">${esc(status.version)}</p><form id="convert-form"><label for="preset">Output format</label><select id="preset" name="preset"><option value="mp4">MP4 · MPEG-4 video, AAC audio</option><option value="m4a">M4A · AAC audio</option><option value="flac">FLAC · lossless audio</option><option value="wav">WAV · uncompressed audio</option></select><label for="media-file">Choose a media file</label><input id="media-file" type="file" accept="video/*,audio/*,.mkv,.mov,.m4v,.avi,.flac,.ogg,.aac" required><p class="muted">Maximum upload: 500 MB. Files are processed temporarily and removed after download or failure.</p><button class="primary" id="convert-button" type="submit">Convert file</button><div id="conversion-status" role="status" aria-live="polite"></div><progress id="conversion-progress" max="100" value="0" hidden></progress></form></section><aside>Conversion uses fixed, reviewed FFmpeg presets. The page does not accept shell commands or remote media URLs.</aside><footer>Complex Elite · Tools platform</footer></main></body></html>`;
}
async function convertMedia(req,res,url) {
 const preset=conversionPresets[url.searchParams.get('preset')||''];
 if(!preset)return send(res,400,JSON.stringify({error:'Choose a supported output format.'}),'application/json');
 if(activeConversions>=1)return send(res,429,JSON.stringify({error:'A conversion is already running. Retry when it finishes.'}),'application/json');
 const declared=Number(req.headers['content-length']||0);
 if(declared>maxUploadBytes){req.resume();return send(res,413,JSON.stringify({error:'Files must be 500 MB or smaller.'}),'application/json');}
 activeConversions++;
 let workDir;
 let releaseSlot=true;
 try {
  workDir=await mkdtemp(path.join(os.tmpdir(),'ce-ffmpeg-'));
  const input=path.join(workDir,'input.media'),output=path.join(workDir,`output.${preset.ext}`);
  let received=0;
  await new Promise((resolve,reject)=>{
   const outputStream=createWriteStream(input,{flags:'wx',mode:0o600});
   const fail=error=>{req.off('data',onData);outputStream.destroy();reject(error);};
   const onData=chunk=>{received+=chunk.length;if(received>maxUploadBytes){const error=Object.assign(new Error('Upload exceeds the 500 MB limit.'),{statusCode:413});req.off('data',onData);req.resume();outputStream.destroy();reject(error);return;}if(!outputStream.write(chunk)){req.pause();outputStream.once('drain',()=>req.resume());}};
   req.on('data',onData);req.once('aborted',()=>fail(new Error('Upload was interrupted.')));req.once('error',fail);outputStream.once('error',fail);req.once('end',()=>{req.off('data',onData);outputStream.end(resolve);});
  });
  if(received===0)return send(res,400,JSON.stringify({error:'Choose a media file first.'}),'application/json');
  await execFileAsync('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',input,'-t','600',...preset.args,'-fs','1073741824',output],{timeout:300000,maxBuffer:65536,env:{PATH:process.env.PATH,HOME:workDir}});
  const outputSize=(await stat(output)).size;
  if(!outputSize)throw new Error('FFmpeg produced an empty file. Check that the input contains the media type required by this preset.');
  res.writeHead(200,{'Content-Type':preset.mime,'Content-Length':outputSize,'Content-Disposition':`attachment; filename="converted.${preset.ext}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  const stream=createReadStream(output);stream.on('error',()=>res.destroy());stream.on('close',()=>{void rm(workDir,{recursive:true,force:true});activeConversions--;});res.on('close',()=>stream.destroy());releaseSlot=false;stream.pipe(res);
 } catch(error) {
  if(workDir)await rm(workDir,{recursive:true,force:true}).catch(()=>{});
  const status=error.statusCode||422;
  const message=status===413?'Files must be 500 MB or smaller.':(error.killed?'Conversion exceeded the 5 minute limit.':(error.message||'Conversion failed.').slice(0,400));
  if(!res.headersSent)send(res,status,JSON.stringify({error:message}),'application/json');else res.destroy();
 } finally {if(releaseSlot)activeConversions--;}
}
async function probe(slug) {
 const t=tools[slug];
 try { const {stdout,stderr}=await execFileAsync(t.command,t.args,{timeout:10000,maxBuffer:65536,env:{...process.env,HOME:'/tmp'}}); return {ok:true,version:(stdout||stderr).split('\n').find(Boolean)?.trim()||'Installed',detail:slug==='ffmpeg'?'FFmpeg source build · network protocols disabled':'HyperFrames npm release 0.8.226 · Node.js '+process.versions.node}; }
 catch(e) { return {ok:false,version:'Unavailable',detail:e.code==='ENOENT'?'The executable was not found in this runtime.':'The fixed version probe failed.'}; }
}
async function startPreview() {
 await mkdir(projectDir,{recursive:true});
 try { await access(path.join(projectDir,'index.html')); }
 catch { await execFileAsync('hyperframes',['init',projectDir,'--example','blank','--skip-skills','--non-interactive'],{timeout:120000,maxBuffer:1024*1024,env:{...process.env,HYPERFRAMES_SKIP_SKILLS:'1'}}); }
 previewProcess=spawn('hyperframes',['preview','--port',String(previewPort),'--foreground',projectDir],{stdio:'ignore',env:{...process.env,NO_OPEN:'1',CI:'1'}});
 previewProcess.on('exit',()=>{previewProcess=undefined;});
 for(let i=0;i<60;i++) { if(previewProcess.exitCode!==null) throw new Error('HyperFrames preview exited during startup'); try { const response=await fetch(`http://127.0.0.1:${previewPort}/`,{signal:AbortSignal.timeout(1000)}); if(response.ok)return; } catch {} await new Promise(resolve=>setTimeout(resolve,1000)); }
 throw new Error('HyperFrames preview did not become ready');
}
function previewPath(requestPath,stripEditorPrefix=false) {
 if(!stripEditorPrefix)return requestPath;
 const editorPrefix='/hyperframes/editor';
 return requestPath===editorPrefix||requestPath.startsWith(`${editorPrefix}/`) ? requestPath.slice(editorPrefix.length)||'/' : requestPath;
}
function proxyPreview(req,res,upstreamPath=req.url||'/',stripEditorPrefix=false) {
 upstreamPath=previewPath(upstreamPath,stripEditorPrefix);
 const upstream=http.request({hostname:'127.0.0.1',port:previewPort,path:upstreamPath,method:req.method,headers:{...req.headers,host:`127.0.0.1:${previewPort}`}},response=>{res.writeHead(response.statusCode||502,response.statusMessage,response.headers);response.pipe(res);});
 upstream.on('error',()=>{if(!res.headersSent)send(res,502,'HyperFrames Studio is starting or unavailable. Retry shortly.');else res.destroy();}); req.pipe(upstream);
}
function proxyGoogleMaps(req,res,upstreamPath) {
 const upstream=http.request({hostname:'tools-google-maps-scraper',port:8080,path:upstreamPath,method:req.method,headers:{...req.headers,host:'tools-google-maps-scraper:8080','x-forwarded-host':req.headers.host||'tools.complexelite.com','x-forwarded-proto':'https'}},response=>{res.writeHead(response.statusCode||502,response.statusMessage,response.headers);response.pipe(res);});
 upstream.on('error',()=>{if(!res.headersSent)send(res,502,'Google Maps Scraper is starting or unavailable. Retry shortly.');else res.destroy();});req.pipe(upstream);
}
const openReplyInternalPrefix='/tools/openreply';
const openReplyPublicPrefix='/openreply';
const openReplyEncodedPrefix=encodeURIComponent(openReplyInternalPrefix);
function rewriteOpenReplyReference(value) {
 if(Array.isArray(value))return value.map(rewriteOpenReplyReference);
 if(typeof value!=='string')return value;
 return value.replaceAll(openReplyInternalPrefix,openReplyPublicPrefix).replace(new RegExp(openReplyEncodedPrefix,'ig'),encodeURIComponent(openReplyPublicPrefix));
}
function rewriteOpenReplyBody() {
 let carry='';
 const decoder=new StringDecoder('utf8');
 const keep=Math.max(openReplyInternalPrefix.length,openReplyEncodedPrefix.length)-1;
 return new Transform({
  transform(chunk,encoding,callback) {
   const input=carry+decoder.write(chunk);
   const safeLength=Math.max(0,input.length-keep);
   carry=input.slice(safeLength);
   callback(null,rewriteOpenReplyReference(input.slice(0,safeLength)));
  },
  flush(callback) { callback(null,rewriteOpenReplyReference(carry+decoder.end())); }
 });
}
function proxyOpenReply(req,res,upstreamPath) {
 const headers={...req.headers,host:'tools.complexelite.com','x-forwarded-host':req.headers.host||'tools.complexelite.com','x-forwarded-proto':'https','accept-encoding':'identity'};
 if(req.headers.origin) {
  try { if(new URL(req.headers.origin).host!==(req.headers.host||'')){req.resume();return send(res,403,'Cross-origin OpenReply request refused.');} }
  catch {req.resume();return send(res,403,'Invalid OpenReply request origin.');}
  // OpenReply validates its canonical Tools origin after this gateway checks the browser origin.
 }
 const upstream=http.request({hostname:'tools-openreply-web',port:3000,path:upstreamPath,method:req.method,headers},response=>{
  const responseHeaders={...response.headers};
  for(const key of ['location','link','content-security-policy','content-security-policy-report-only'])if(responseHeaders[key])responseHeaders[key]=rewriteOpenReplyReference(responseHeaders[key]);
  if(responseHeaders['set-cookie'])responseHeaders['set-cookie']=responseHeaders['set-cookie'].map(rewriteOpenReplyReference);
  const contentType=String(responseHeaders['content-type']||'');
  const rewriteBody=/^(text\/|application\/(?:javascript|json|manifest\+json|xml)|image\/svg\+xml)/i.test(contentType)&&!responseHeaders['content-encoding'];
  if(rewriteBody)for(const key of ['content-length','content-md5','digest','etag'])delete responseHeaders[key];
  res.writeHead(response.statusCode||502,response.statusMessage,responseHeaders);
  if(rewriteBody)response.pipe(rewriteOpenReplyBody()).pipe(res);else response.pipe(res);
 });
 upstream.on('error',()=>{if(!res.headersSent)send(res,502,'OpenReply is starting or unavailable. Retry shortly.');else res.destroy();});req.pipe(upstream);
}
function proxyScrapling(req,res,upstreamPath) {
 const upstream=http.request({hostname:'tools-scrapling',port:8000,path:upstreamPath,method:req.method,headers:{...req.headers,host:req.headers.host||'tools.complexelite.com','x-forwarded-host':req.headers.host||'tools.complexelite.com','x-forwarded-proto':'https'}},response=>{res.writeHead(response.statusCode||502,response.statusMessage,response.headers);response.pipe(res);});
 upstream.on('error',()=>{if(!res.headersSent)send(res,502,'Scrapling is starting or unavailable. Retry shortly.');else res.destroy();});req.pipe(upstream);
}
function proxyAiCaptions(req,res,upstreamPath) {
 const upstream=http.request({hostname:'caption-frontend',port:3000,path:upstreamPath,method:req.method,headers:{...req.headers,host:'caption-frontend:3000','x-forwarded-host':req.headers.host||'tools.complexelite.com','x-forwarded-proto':'https'}},response=>{res.writeHead(response.statusCode||502,response.statusMessage,response.headers);response.pipe(res);});
 upstream.on('error',()=>{if(!res.headersSent)send(res,502,'AI Video Captions is starting or unavailable. Retry shortly.');else res.destroy();});req.pipe(upstream);
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
   const requested=url.searchParams.get('next')||'/', next=pages.has(requested)?requested:'/';
   const state=crypto.randomBytes(32).toString('hex'), target=new URL(loginUrl); target.searchParams.set('state',state);
   return send(res,303,'','text/plain; charset=utf-8',{Location:target.toString(),'Set-Cookie':[cookie(stateName,state,300),cookie(nextName,encodeURIComponent(next),300)]});
 }
 if(path==='/auth/perfex'&&req.method==='GET') {
   const code=url.searchParams.get('code')||'', state=url.searchParams.get('state')||'', saved=cookies(req)[stateName]||'';
   if(!secret||!/^[a-f0-9]{64}$/i.test(code)||!/^[a-f0-9]{64}$/i.test(state)||!/^[a-f0-9]{64}$/i.test(saved)||!crypto.timingSafeEqual(Buffer.from(state.toLowerCase()),Buffer.from(saved.toLowerCase()))) return send(res,400,'Invalid or expired Perfex sign-in handoff.');
   const timestamp=String(Math.floor(Date.now()/1000)), signature=crypto.createHmac('sha256',secret).update(`${timestamp}\n${code}`).digest('hex');
   try {
    const response=await fetch(exchangeUrl,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Studio-Timestamp':timestamp,'X-Studio-Signature':signature},body:new URLSearchParams({code,app:'tools'}),signal:AbortSignal.timeout(10000),redirect:'error'});
    const result=await response.json(); if(!response.ok||result.ok!==true||!result.user||!Number.isInteger(Number(result.user.id))) return send(res,401,'Perfex sign-in expired or could not be verified.');
    const token=crypto.randomBytes(32).toString('base64url'); sessions.set(token,{user:{id:Number(result.user.id),name:String(result.user.name||'Perfex user'),email:String(result.user.email||''),role:String(result.user.role||'staff')},expires:Date.now()+ttl});
    const next=decodeURIComponent(cookies(req)[nextName]||'/'); return send(res,303,'','text/plain; charset=utf-8',{Location:pages.has(next)?next:'/','Set-Cookie':[cookie(cookieName,token,ttl/1000),cookie(stateName,'',0),cookie(nextName,'',0)]});
   } catch {return send(res,502,'Perfex sign-in could not be reached. Retry shortly.');}
 }
 if(path==='/auth/logout'&&req.method==='POST') {const host=req.headers.host||'',origin=req.headers.origin||''; if(origin&&!origin.endsWith(`://${host}`))return send(res,403,'Request refused.'); const s=session(req);if(s)sessions.delete(s.token);return send(res,303,'','text/plain; charset=utf-8',{Location:'/','Set-Cookie':cookie(cookieName,'',0)});}
 if(path==='/'&&req.method==='GET') {const s=session(req);if(!s)return send(res,302,'','text/plain; charset=utf-8',{Location:`/auth/login?next=${encodeURIComponent('/')}`});return send(res,200,catalogPage(s.user),'text/html; charset=utf-8',{'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});}
 const api=path.match(/^\/api\/v1\/runtime\/(hyperframes|ffmpeg)$/);
 if(api&&req.method==='GET') {if(!authenticatedApi(req))return send(res,401,JSON.stringify({ok:false,error:'Unauthorized'}),'application/json');return send(res,200,JSON.stringify(await probe(api[1])),'application/json');}
 if(path==='/api/ffmpeg/convert'&&req.method==='POST') {if(!session(req))return send(res,401,JSON.stringify({error:'Perfex sign-in is required.'}),'application/json');const origin=req.headers.origin;if(origin&&new URL(origin).host!==(req.headers.host||'')){req.resume();return send(res,403,JSON.stringify({error:'Cross-origin conversion requests are refused.'}),'application/json');}return convertMedia(req,res,url);}
 if(path==='/ai-video-captions'||path.startsWith('/ai-video-captions/')) {
   if(!session(req)) {req.resume();return send(res,302,'','text/plain; charset=utf-8',{Location:`/auth/login?next=${encodeURIComponent('/ai-video-captions')}`});}
   return proxyAiCaptions(req,res,req.url||'/');
 }
 if(path==='/tools/openreply'||path.startsWith('/tools/openreply/')) {
   const publicPath=path.slice('/tools'.length)+url.search;
   return send(res,308,'','text/plain; charset=utf-8',{Location:publicPath});
 }
 if(path==='/openreply'||path.startsWith('/openreply/')) {
   if(!session(req)) {req.resume();return send(res,302,'','text/plain; charset=utf-8',{Location:`/auth/login?next=${encodeURIComponent('/openreply')}`});}
   const suffix=path.slice(openReplyPublicPrefix.length)||'';
   const upstreamPath=`${openReplyInternalPrefix}${suffix}${url.search}`;
   return proxyOpenReply(req,res,upstreamPath);
 }
 if(path==='/scrapling'||path==='/scrapling/') {
   const s=session(req);if(!s)return send(res,302,'','text/plain; charset=utf-8',{Location:`/auth/login?next=${encodeURIComponent('/scrapling')}`});
   return send(res,200,scraplingPage(s.user),'text/html; charset=utf-8',{'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
 }
 if(path==='/scrapling/mcp') {
   if(!session(req)&&!/^Bearer\s+\S+$/i.test(String(req.headers.authorization||''))) {req.resume();return send(res,401,'Perfex staff sign-in or Scrapling bearer authentication is required.');}
   const upstreamPath=`/mcp${url.search}`;
   return proxyScrapling(req,res,upstreamPath);
 }
 const mapsPage=path==='/google-maps-scraper'||path==='/google-maps-scraper/';
 const mapsAppPath=path==='/google-maps-scraper'||path.startsWith('/google-maps-scraper/');
 const mapsRootAsset=mapsRootPaths.some(prefix=>path===prefix||path.startsWith(prefix))&&!path.startsWith('/api/v1/runtime/');
 if(mapsAppPath||mapsRootAsset) {
   if(!session(req)) {
     if(mapsPage)return send(res,302,'','text/plain; charset=utf-8',{Location:`/auth/login?next=${encodeURIComponent('/google-maps-scraper')}`});
     req.resume();return send(res,401,'Perfex staff sign-in is required.','text/plain; charset=utf-8');
   }
   const upstreamPath=mapsAppPath?`${path.slice('/google-maps-scraper'.length)||'/'}${url.search}`:req.url||'/';
   return proxyGoogleMaps(req,res,upstreamPath);
 }
 const slug=pages.get(path);
 if(slug==='hyperframes') {if(!session(req))return send(res,302,'','text/plain; charset=utf-8',{Location:`/auth/login?next=${encodeURIComponent(path)}`});return send(res,302,'','text/plain; charset=utf-8',{Location:'/hyperframes/editor/#project/default'});}
 if(path==='/hyperframes/editor'||path==='/hyperframes/editor/') {if(!session(req))return send(res,302,'','text/plain; charset=utf-8',{Location:`/auth/login?next=${encodeURIComponent('/hyperframes')}`});return proxyPreview(req,res,'/'+url.search);}
 if(slug==='ffmpeg') {const s=session(req);if(!s)return send(res,302,'','text/plain; charset=utf-8',{Location:`/auth/login?next=${encodeURIComponent(path)}`});return send(res,200,ffmpegPage(s.user,await probe(slug)),'text/html; charset=utf-8',{'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});}
 if(path==='/assets/tools.css') {const fs=await import('node:fs/promises');return send(res,200,await fs.readFile(new URL('../public/tools.css',import.meta.url)),'text/css; charset=utf-8');}
 if(path==='/assets/ffmpeg.js') {const fs=await import('node:fs/promises');return send(res,200,await fs.readFile(new URL('../public/ffmpeg.js',import.meta.url)),'text/javascript; charset=utf-8');}
 if(path.startsWith('/assets/')||path==='/favicon.svg') {if(!session(req))return send(res,302,'','text/plain; charset=utf-8',{Location:`/auth/login?next=${encodeURIComponent('/hyperframes')}`});return proxyPreview(req,res,req.url||'/');}
 return send(res,404,'Not found.');
}
setInterval(()=>{const now=Date.now();for(const [key,s] of sessions)if(s.expires<=now)sessions.delete(key)},60000).unref();
const server=http.createServer((req,res)=>{void handle(req,res).catch(()=>send(res,500,'Request could not be completed.'))});
server.on('upgrade',(req,socket,head)=>{
 if(!session(req)){socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;}
 const upstream=http.request({hostname:'127.0.0.1',port:previewPort,path:previewPath(req.url||'/',true),method:req.method,headers:{...req.headers,host:`127.0.0.1:${previewPort}`}});
 upstream.on('upgrade',(response,upstreamSocket,upstreamHead)=>{socket.write(`HTTP/1.1 ${response.statusCode||101} ${response.statusMessage||'Switching Protocols'}\r\n${Object.entries(response.headers).map(([key,value])=>`${key}: ${value}`).join('\r\n')}\r\n\r\n`);if(upstreamHead.length)socket.write(upstreamHead);if(head.length)upstreamSocket.write(head);socket.pipe(upstreamSocket).pipe(socket);});
 upstream.on('response',response=>socket.end(`HTTP/1.1 ${response.statusCode||502} ${response.statusMessage||'Bad Gateway'}\r\nConnection: close\r\n\r\n`)); upstream.on('error',()=>socket.destroy()); upstream.end();
});
await startPreview();
server.listen(port,'0.0.0.0');
