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
import {Pool} from 'pg';
import {legacyGoogleMapsPath} from './google-maps-routes.mjs';

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT) || 3000;
const loginUrl = 'https://clients.complexelite.com/studio/login?app=tools';
const exchangeUrl = process.env.PERFEX_SSO_EXCHANGE_URL || 'https://clients.complexelite.com/studio/sso/exchange';
const secret = process.env.STUDIO_SSO_SECRET || '';
const apiSecret = process.env.TOOLS_API_SECRET || '';
const firecrawlWorkspaceDb = process.env.FIRECRAWL_WORKSPACE_DATABASE_URL ? new Pool({connectionString:process.env.FIRECRAWL_WORKSPACE_DATABASE_URL,max:4,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,application_name:'complex-elite-firecrawl-workspace'}) : null;
const firecrawlMonitorJobs = new Set();
const firecrawlInternalOrigin = 'http://tools-firecrawl-api:3002';
const cookieName = 'ce_tools_session';
const stateName = 'ce_tools_state';
const nextName = 'ce_tools_next';
const popupName = 'ce_tools_popup';
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
  ['/firecrawl','firecrawl'], ['/firecrawl/','firecrawl'],
  ['/hyperframes','hyperframes'], ['/hyperframes/','hyperframes'],
  ['/ffmpeg','ffmpeg'], ['/ffmpeg/','ffmpeg'],
  ['/google-maps-scraper','google-maps-scraper'], ['/google-maps-scraper/','google-maps-scraper'],
  ['/openreply','openreply'], ['/openreply/','openreply'],
  ['/scrapling','scrapling'], ['/scrapling/','scrapling'],
  ['/ai-video-captions','ai-video-captions'], ['/ai-video-captions/','ai-video-captions'],
  ['/google-maps-scraper/api/docs','api-docs'], ['/google-maps-scraper/api/docs/','api-docs'],
]);
function send(res,status,body,type='text/plain; charset=utf-8',headers={}) {
  res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',...headers}); res.end(body);
}
function cookies(req) { return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split(/=(.*)/s).slice(0,2)).filter(([k,v])=>k&&v!==undefined)); }
function session(req) { const token=cookies(req)[cookieName], value=sessions.get(token); if(!value||value.expires<=Date.now()){sessions.delete(token);return null;} return {token,...value}; }
function sameOriginRequest(req) {
 const site=String(req.headers['sec-fetch-site']||'').toLowerCase();
 if(site&&site!=='same-origin'&&site!=='none')return false;
 if(!req.headers.origin)return req.method==='GET';
 try{return new URL(req.headers.origin).host===(req.headers.host||'');}catch{return false;}
}
async function readJsonBody(req,maxBytes=64*1024*1024) {
 const chunks=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>maxBytes){req.resume();throw Object.assign(new Error('Crawl results exceed the 64 MB storage limit.'),{statusCode:413});}chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('Request body must be valid JSON.'),{statusCode:400});}
}
async function initializeFirecrawlWorkspaceDb() {
 if(!firecrawlWorkspaceDb)return;
 await firecrawlWorkspaceDb.query(`
  CREATE TABLE IF NOT EXISTS firecrawl_saved_crawls (
   id BIGSERIAL PRIMARY KEY,
   user_id BIGINT NOT NULL,
   firecrawl_job_id TEXT NOT NULL,
   workflow TEXT NOT NULL DEFAULT 'crawl',
   target TEXT NOT NULL,
   status TEXT NOT NULL DEFAULT 'completed',
   total INTEGER NOT NULL DEFAULT 0,
   completed INTEGER NOT NULL DEFAULT 0,
   page_count INTEGER NOT NULL DEFAULT 0,
   result JSONB NOT NULL,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
   UNIQUE (user_id, firecrawl_job_id)
  );
  CREATE INDEX IF NOT EXISTS firecrawl_saved_crawls_user_recent_idx ON firecrawl_saved_crawls(user_id, created_at DESC);
 `);
}
function isTerminalCrawlStatus(status) { return ['completed','failed','cancelled'].includes(String(status||'').toLowerCase()); }
function normalizeCrawlPages(pages) {
 const normalized=[];let bytes=0,truncated=false;
 for(const page of Array.isArray(pages)?pages:[]) {
  if(normalized.length>=1000){truncated=true;break;}
  const item={url:String(page?.url||page?.metadata?.sourceURL||'').slice(0,2048),metadata:page?.metadata&&typeof page.metadata==='object'?page.metadata:{},markdown:String(page?.markdown||'').slice(0,2_000_000),links:Array.isArray(page?.links)?page.links.slice(0,2000):[]};
  const itemBytes=Buffer.byteLength(JSON.stringify(item));
  if(bytes+itemBytes>48*1024*1024){truncated=true;break;}
  normalized.push(item);bytes+=itemBytes;
 }
 return {pages:normalized,truncated};
}
async function persistFirecrawlCrawl({userId,jobId,target,workflow='crawl',status='running',total=0,completed=0,pages=[]}) {
 if(!firecrawlWorkspaceDb)return;
 const normalized=normalizeCrawlPages(pages),safePages=normalized.pages,safeStatus=['running','queued','scraping','completed','failed','cancelled'].includes(String(status).toLowerCase())?String(status).toLowerCase():'running';
 const count=(value,fallback)=>Math.max(0,Math.min(100000,Number(value)||fallback));
 const normalizedWorkflow=['crawl','handover','audit'].includes(workflow)?workflow:'crawl';
 const result={status:safeStatus,total:count(total,safePages.length),completed:count(completed,safePages.length),data:safePages,...(normalized.truncated?{truncated:true}:{})};
 await firecrawlWorkspaceDb.query(`INSERT INTO firecrawl_saved_crawls(user_id,firecrawl_job_id,workflow,target,status,total,completed,page_count,result,created_at,updated_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW(),NOW())
  ON CONFLICT(user_id,firecrawl_job_id) DO UPDATE SET workflow=EXCLUDED.workflow,target=EXCLUDED.target,status=EXCLUDED.status,total=EXCLUDED.total,completed=EXCLUDED.completed,page_count=EXCLUDED.page_count,result=EXCLUDED.result,updated_at=NOW()`,
 [userId,jobId,normalizedWorkflow,target,safeStatus,result.total,result.completed,safePages.length,JSON.stringify(result)]);
}
async function fetchFirecrawlJson(path) {
 const response=await fetch(new URL(path,firecrawlInternalOrigin),{headers:{accept:'application/json'},signal:AbortSignal.timeout(30000)});
 const body=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(`Firecrawl status request returned ${response.status}`);
 return body;
}
async function monitorFirecrawlCrawl(job) {
 const key=`${job.userId}:${job.jobId}`;
 if(firecrawlMonitorJobs.has(key)||!firecrawlWorkspaceDb)return;
 firecrawlMonitorJobs.add(key);
 const started=Date.now();let lastTotal=-1,lastCompleted=-1,lastErrorLog=0;
 try {
  while(Date.now()-started<24*60*60*1000) {
   try {
   const current=await fetchFirecrawlJson(`/v2/crawl/${encodeURIComponent(job.jobId)}`);
   const status=String(current.status||'running').toLowerCase();
   if(isTerminalCrawlStatus(status)) {
    if(status==='completed') {
     let page=current;const pages=[];let pageReads=0;const basePath=`/v2/crawl/${encodeURIComponent(job.jobId)}`;
     while(page&&pageReads<200) {
      if(Array.isArray(page.data))pages.push(...page.data);
      pageReads++;
      if(!page.next)break;
      const next=new URL(page.next,firecrawlInternalOrigin);
      // Firecrawl may return an absolute next URL for its own public API host. Only
      // trust the crawl path and cursor; always fetch it through our private service.
      if(next.pathname!==basePath)throw new Error('Firecrawl returned an invalid pagination cursor');
      page=await fetchFirecrawlJson(`${next.pathname}${next.search}`);
     }
     if(page?.next)throw new Error('Firecrawl returned more than 200 result pages');
     await persistFirecrawlCrawl({...job,status,total:current.total,completed:current.completed,pages});
    } else await persistFirecrawlCrawl({...job,status,total:current.total,completed:current.completed,pages:[]});
    return;
   }
   const total=Number(current.total)||0,completed=Number(current.completed)||0;
   if(total!==lastTotal||completed!==lastCompleted) {
    await persistFirecrawlCrawl({...job,status,total,completed,pages:current.data||[]});
    lastTotal=total;lastCompleted=completed;
   }
   } catch(error) {
    if(Date.now()-lastErrorLog>60000) {
     console.error('[firecrawl-workspace] Crawl monitor will retry:',String(error?.message||'unknown error').slice(0,180));
     lastErrorLog=Date.now();
    }
    await new Promise(resolve=>setTimeout(resolve,15000));
    continue;
   }
   await new Promise(resolve=>setTimeout(resolve,5000));
  }
  console.error('[firecrawl-workspace] Crawl monitor reached its 24-hour limit.');
 } finally {firecrawlMonitorJobs.delete(key);}
}
async function resumeFirecrawlMonitors() {
 if(!firecrawlWorkspaceDb)return;
 const pending=await firecrawlWorkspaceDb.query("SELECT user_id,firecrawl_job_id AS job_id,target,workflow FROM firecrawl_saved_crawls WHERE status NOT IN ('completed','failed','cancelled') ORDER BY created_at DESC LIMIT 100");
 for(const row of pending.rows)void monitorFirecrawlCrawl({userId:row.user_id,jobId:row.job_id,target:row.target,workflow:row.workflow});
}
function firecrawlWorkspaceResponse(res,status,body) { return send(res,status,JSON.stringify(body),'application/json; charset=utf-8'); }
function cookie(name,value,age) {return `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`}
function esc(x) { return String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function page(slug,user,status) {
 const t=tools[slug]; const peer=slug==='hyperframes'?'ffmpeg':'hyperframes';
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#0B0B0B"><link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><title>${t.name} · Complex Elite Tools</title><link rel="stylesheet" href="/assets/tools.css"></head><body><main><header><a href="/" class="brand" aria-label="Complex Elite"><img src="/brand/complex-elite_horizontal_colour-reverse.svg" alt="Complex Elite" width="180"></a><form method="post" action="/auth/logout"><button>Sign out · ${esc(user.name)}</button></form></header><p class="eyebrow">PRIVATE TOOL RUNTIME</p><h1>${t.name}</h1><p class="lead">${t.purpose}</p><nav><a ${slug==='hyperframes'?'aria-current="page"':''} href="/hyperframes">HyperFrames</a><a ${slug==='ffmpeg'?'aria-current="page"':''} href="/ffmpeg">FFmpeg</a></nav><section><div class="state"><span class="dot ${status.ok?'good':'bad'}"></span><b>${status.ok?'Installed and responding':'Runtime check failed'}</b></div><dl><dt>Version</dt><dd>${esc(status.version)}</dd><dt>Build</dt><dd>${esc(status.detail)}</dd><dt>Upstream</dt><dd><a href="${t.source}" target="_blank" rel="noreferrer">${t.source}</a></dd><dt>Integration</dt><dd>Private status page · fixed health probe only</dd></dl><form method="get" action="/${slug}"><button class="primary">Refresh runtime check</button></form></section><aside>Staff sign-in is verified by clients.complexelite.com. This page does not provide shell access or accept arbitrary commands.</aside><footer>Complex Elite · Tools platform</footer></main></body></html>`;
}
function signInPage(next='/') {
 const safeNext=pages.has(next)?next:'/';
 const href=`/auth/login?next=${encodeURIComponent(safeNext)}`;
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#0B0B0B"><link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><title>Sign in · Complex Elite Tools</title><link rel="stylesheet" href="/assets/tools.css"><script src="/assets/signin.js" defer></script></head><body class="signin-page"><main class="signin-shell"><header class="signin-header"><a href="/" class="brand"><img src="/brand/complex-elite_horizontal_colour-reverse.svg" alt="Complex Elite Media Group" width="190"></a><span class="secure-label"><span aria-hidden="true">●</span> STAFF ACCESS</span></header><section class="signin-card"><div class="signin-copy"><p class="eyebrow">YOUR WORKSPACE, CONNECTED</p><h1>Tools that move<br><span>your work forward.</span></h1><p class="lead">Sign in once to open the private tools available to your Complex Elite account.</p><a class="signin-button" href="${esc(href)}" id="perfex-signin"><span>Continue with Complex Elite</span><span aria-hidden="true">→</span></a><p class="signin-note" id="signin-status" role="status" aria-live="polite"><span class="lock-icon" aria-hidden="true">◈</span> Secure staff sign-in powered by Perfex. Your password is never entered or stored here.</p></div><div class="signin-visual" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="orbit orbit-three"></div><div class="visual-core"><img src="/brand/complex-elite_icon_colour-reverse_500px.png" alt=""></div><div class="visual-chip chip-one">VIDEO</div><div class="visual-chip chip-two">AUTOMATION</div><div class="visual-chip chip-three">MEDIA</div></div></section><footer class="signin-footer"><span>Complex Elite Media Group</span><span>Private staff workspace · Staff accounts are managed in Perfex</span></footer></main></body></html>`;
}
function popupCompletePage(next='/') {
 const safeNext=pages.has(next)?next:'/';
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#0B0B0B"><link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><title>Signed in · Complex Elite Tools</title><link rel="stylesheet" href="/assets/tools.css"><script src="/assets/auth-callback.js" defer></script></head><body class="signin-page"><main class="callback-shell"><img class="callback-brand" src="/brand/complex-elite_icon_colour-reverse_500px.png" alt="Complex Elite"><p class="eyebrow">SECURE STAFF ACCESS</p><h1>Sign-in complete</h1><p class="lead" id="callback-status" role="status" aria-live="polite">Returning to your Tools page…</p><a class="signin-button" href="${esc(safeNext)}" id="return-to-tools">Return to Complex Elite Tools <span aria-hidden="true">→</span></a><p class="signin-note">If this window stays open, use the button above to continue.</p></main></body></html>`;
}
function catalogPage(user) {
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#0B0B0B"><link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><title>Complex Elite Tools</title><link rel="stylesheet" href="/assets/tools.css"></head><body><main><header><a href="/" class="brand" aria-label="Complex Elite Media Group"><img src="/brand/complex-elite_horizontal_colour-reverse.svg" alt="Complex Elite Media Group" width="180"></a><form method="post" action="/auth/logout"><button>Sign out · ${esc(user.name)}</button></form></header><p class="eyebrow">PRIVATE TOOL RUNTIME</p><h1>Tools</h1><p class="lead">Open an installed tool. Each tool has its own address and stays behind your Perfex staff sign-in.</p><section class="tool-list"><article><h2>Firecrawl</h2><p class="muted">Self-hosted web scraping, crawling, mapping, and search API. Protected by Perfex staff sign-in.</p><a class="tool-link" href="/firecrawl">Open Firecrawl workspace →</a><p class="muted"><small>tools.complexelite.com/firecrawl</small></p></article><article><h2>HyperFrames</h2><p class="muted">Create, preview, and render timeline-based video projects.</p><a class="tool-link" href="/hyperframes">Open HyperFrames →</a><p class="muted"><small>tools.complexelite.com/hyperframes</small></p></article><article><h2>FFmpeg</h2><p class="muted">Convert video and audio files using fixed, reviewed presets.</p><a class="tool-link" href="/ffmpeg">Open FFmpeg →</a><p class="muted"><small>tools.complexelite.com/ffmpeg</small></p></article><article><h2>Google Maps Scraper</h2><p class="muted">Search and export Google Maps business results from the Tools-hosted service. Protected by Perfex sign-in.</p><a class="tool-link" href="/google-maps-scraper">Open Google Maps Scraper →</a><p class="muted"><small><a href="https://github.com/complexelite/google-maps-scraper">GitHub source</a></small></p></article><article><h2>OpenReply</h2><p class="muted">Instagram comment-to-DM campaigns and inbox. Migrated to the Tools-hosted stack with its existing account data and provider configuration.</p><a class="tool-link" href="/openreply">Open OpenReply →</a><p class="muted"><small><a href="https://github.com/complexelite/openreply">GitHub source</a> · the app keeps its existing magic-link sign-in and provider callbacks.</small></p></article><article><h2>Scrapling</h2><p class="muted">Scraping library and MCP service for connected agents. MCP requests still require Scrapling’s bearer token.</p><a class="tool-link" href="/scrapling">View Scrapling connection →</a><p class="muted"><small><a href="https://github.com/complexelite/Scrapling">GitHub source</a></small></p></article><article><h2>AI Video Captions</h2><p class="muted">Generate animated subtitles with Whisper and FFmpeg. Uploads and results stay on the VPS with a 24-hour cleanup policy.</p><a class="tool-link" href="/ai-video-captions">Open AI Video Captions →</a><p class="muted"><small><a href="https://github.com/complexelite/ai-video-captions">GitHub source</a></small></p></article></section><aside>Only installed routes are opened here. Unknown paths return 404.</aside><footer>Complex Elite · Tools platform</footer></main></body></html>`;
}
async function firecrawlPage(user) {
 let ready=false;
 try { const response=await fetch('http://tools-firecrawl-api:3002/v0/health/readiness',{signal:AbortSignal.timeout(2500)}); ready=response.ok; } catch {}
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#0B0B0B"><link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><meta name="theme-color" content="#101725"><title>Firecrawl · Complex Elite Tools</title><link rel="stylesheet" href="/assets/firecrawl/app.css"><script type="module" src="/assets/firecrawl/app.js"></script></head><body><div id="root" data-api-ready="${ready?'true':'false'}" data-user-id="${Number(user.id)||0}"></div><noscript>Enable JavaScript to use the Firecrawl workspace.</noscript></body></html>`;
}
function ffmpegPage(user,status) {
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#0B0B0B"><link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><title>FFmpeg · Complex Elite Tools</title><link rel="stylesheet" href="/assets/tools.css"><script src="/assets/ffmpeg.js" defer></script></head><body><main><header><a href="/" class="brand" aria-label="Complex Elite"><img src="/brand/complex-elite_horizontal_colour-reverse.svg" alt="Complex Elite" width="180"></a><form method="post" action="/auth/logout"><button>Sign out · ${esc(user.name)}</button></form></header><p class="eyebrow">PRIVATE MEDIA TOOL</p><h1>FFmpeg</h1><p class="lead">Convert a video or audio file using the installed FFmpeg engine. Choose a preset, upload a file, then download the finished result.</p><nav><a href="/hyperframes">HyperFrames editor</a><a aria-current="page" href="/ffmpeg">FFmpeg converter</a></nav><section><div class="state"><span class="dot ${status.ok?'good':'bad'}"></span><b>${status.ok?'FFmpeg installed and responding':'FFmpeg runtime check failed'}</b></div><p class="muted">${esc(status.version)}</p><form id="convert-form"><label for="preset">Output format</label><select id="preset" name="preset"><option value="mp4">MP4 · MPEG-4 video, AAC audio</option><option value="m4a">M4A · AAC audio</option><option value="flac">FLAC · lossless audio</option><option value="wav">WAV · uncompressed audio</option></select><label for="media-file">Choose a media file</label><input id="media-file" type="file" accept="video/*,audio/*,.mkv,.mov,.m4v,.avi,.flac,.ogg,.aac" required><p class="muted">Maximum upload: 500 MB. Files are processed temporarily and removed after download or failure.</p><button class="primary" id="convert-button" type="submit">Convert file</button><div id="conversion-status" role="status" aria-live="polite"></div><progress id="conversion-progress" max="100" value="0" hidden></progress></form></section><aside>Conversion uses fixed, reviewed FFmpeg presets. The page does not accept shell commands or remote media URLs.</aside><footer>Complex Elite · Tools platform</footer></main></body></html>`;
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
async function proxyFirecrawl(req,res,upstreamPath,context={}) {
 const isCrawlStart=req.method==='POST'&&upstreamPath==='/v2/crawl'&&Number(context.userId)>0&&firecrawlWorkspaceDb;
 let crawlRequestBody=null, crawlTarget='', crawlWorkflow='crawl';
 if(isCrawlStart) {
  try {
   crawlRequestBody=await readJsonBody(req,1024*1024);
   let parsed;try{parsed=new URL(String(crawlRequestBody.url||''));}catch{}
   if(!parsed||!['http:','https:'].includes(parsed.protocol))return send(res,400,JSON.stringify({success:false,error:'A valid HTTP(S) URL is required to save this crawl.'}),'application/json');
   crawlTarget=parsed.toString();
   const requestedWorkflow=String(req.headers['x-ce-crawl-workflow']||'crawl');
   crawlWorkflow=['crawl','handover','audit'].includes(requestedWorkflow)?requestedWorkflow:'crawl';
  } catch(error) {return send(res,error.statusCode||400,JSON.stringify({success:false,error:error.message||'Invalid crawl request.'}),'application/json');}
 }
 const headers={...req.headers,host:'tools-firecrawl-api:3002','x-forwarded-host':req.headers.host||'tools.complexelite.com','x-forwarded-proto':'https','x-forwarded-prefix':'/firecrawl'};
 delete headers['x-ce-crawl-workflow'];
 if(isCrawlStart){delete headers['transfer-encoding'];delete headers['accept-encoding'];headers['content-type']='application/json';headers['content-length']=Buffer.byteLength(JSON.stringify(crawlRequestBody));}
 delete headers.cookie;
 const upstream=http.request({hostname:'tools-firecrawl-api',port:3002,path:upstreamPath,method:req.method,headers},response=>{
  if(!isCrawlStart){res.writeHead(response.statusCode||502,response.statusMessage,response.headers);response.pipe(res);return;}
  const chunks=[];let size=0;
  response.on('data',chunk=>{size+=chunk.length;if(size<=2*1024*1024)chunks.push(chunk);});
  response.on('end',async()=>{
   const body=Buffer.concat(chunks), responseHeaders={...response.headers};let data={};
   if(size<=2*1024*1024){try{data=JSON.parse(body.toString('utf8'));}catch{}}
   const jobId=String(data.id||'').trim(), jobStatus=String(data.status||'running').toLowerCase();
   if((response.statusCode||500)<300&&jobId&&jobId.length<=120) {
    const job={userId:Number(context.userId),jobId,target:crawlTarget,workflow:crawlWorkflow};
    try {
     await persistFirecrawlCrawl({...job,status:jobStatus,total:data.total,completed:data.completed,pages:data.status==='completed'?data.data:[]});
     responseHeaders['x-ce-crawl-storage']='saved';
    } catch(error) {
     responseHeaders['x-ce-crawl-storage']='retry-needed';
     console.error('[firecrawl-workspace] Could not save crawl at acceptance:',String(error?.message||'unknown error').slice(0,180));
    }
    void monitorFirecrawlCrawl(job);
   }
   delete responseHeaders['content-length'];res.writeHead(response.statusCode||502,response.statusMessage,responseHeaders);res.end(body);
  });
 });
 upstream.on('error',()=>{if(!res.headersSent)send(res,502,'Firecrawl is starting or unavailable. Retry shortly.');else res.destroy();});
 if(isCrawlStart)upstream.end(JSON.stringify(crawlRequestBody));else req.pipe(upstream);
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
 if((path==='/api/firecrawl/crawls'||/^\/api\/firecrawl\/crawls\/\d+$/.test(path))&&(req.method==='GET'||(path==='/api/firecrawl/crawls'&&req.method==='POST'))) {
  const s=session(req);if(!s)return firecrawlWorkspaceResponse(res,401,{error:'Perfex staff sign-in is required.'});
  if(!sameOriginRequest(req)){req.resume();return firecrawlWorkspaceResponse(res,403,{error:'Cross-origin request refused.'});}
  if(!firecrawlWorkspaceDb)return firecrawlWorkspaceResponse(res,503,{error:'Firecrawl result storage is not configured.'});
  try {
   if(req.method==='GET'&&path==='/api/firecrawl/crawls') {
    const rows=await firecrawlWorkspaceDb.query("SELECT id,firecrawl_job_id AS job_id,workflow,target,status,total,completed,page_count,COALESCE((result->>'truncated')::boolean,FALSE) AS truncated,created_at FROM firecrawl_saved_crawls WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",[s.user.id]);
    return firecrawlWorkspaceResponse(res,200,{crawls:rows.rows});
   }
   const detail=path.match(/^\/api\/firecrawl\/crawls\/(\d+)$/);
   if(req.method==='GET'&&detail) {
    const found=await firecrawlWorkspaceDb.query('SELECT id,firecrawl_job_id AS job_id,workflow,target,status,total,completed,page_count,result,created_at FROM firecrawl_saved_crawls WHERE id=$1 AND user_id=$2',[detail[1],s.user.id]);
    if(!found.rowCount)return firecrawlWorkspaceResponse(res,404,{error:'Saved crawl not found.'});
    return firecrawlWorkspaceResponse(res,200,{crawl:found.rows[0]});
   }
   const declared=Number(req.headers['content-length']||0);if(declared>64*1024*1024){req.resume();return firecrawlWorkspaceResponse(res,413,{error:'Crawl results exceed the 64 MB storage limit.'});}
   const body=await readJsonBody(req);
   const jobId=String(body.job_id||'').trim(),target=String(body.target||'').trim(),workflow=String(body.workflow||'crawl');
   let parsedTarget;try{parsedTarget=new URL(target);}catch{}
   if(!jobId||jobId.length>120||!parsedTarget||!['http:','https:'].includes(parsedTarget.protocol))return firecrawlWorkspaceResponse(res,400,{error:'A Firecrawl job ID and valid HTTP(S) target are required.'});
   if(!['crawl','handover','audit'].includes(workflow))return firecrawlWorkspaceResponse(res,400,{error:'Unsupported crawl workflow.'});
   const normalizedPages=normalizeCrawlPages(body.pages),pages=normalizedPages.pages;
   const total=Math.max(0,Math.min(100000,Number(body.total)||pages.length)),completed=Math.max(0,Math.min(100000,Number(body.completed)||pages.length));
   const result={status:'completed',total,completed,data:pages,...(normalizedPages.truncated?{truncated:true}:{})};
   const saved=await firecrawlWorkspaceDb.query(`INSERT INTO firecrawl_saved_crawls(user_id,firecrawl_job_id,workflow,target,status,total,completed,page_count,result,created_at,updated_at)
    VALUES($1,$2,$3,$4,'completed',$5,$6,$7,$8::jsonb,NOW(),NOW())
    ON CONFLICT(user_id,firecrawl_job_id) DO UPDATE SET workflow=EXCLUDED.workflow,target=EXCLUDED.target,status=EXCLUDED.status,total=EXCLUDED.total,completed=EXCLUDED.completed,page_count=EXCLUDED.page_count,result=EXCLUDED.result,updated_at=NOW()
    RETURNING id,firecrawl_job_id AS job_id,workflow,target,status,total,completed,page_count,created_at`,[s.user.id,jobId,workflow,parsedTarget.toString(),total,completed,pages.length,JSON.stringify(result)]);
   await firecrawlWorkspaceDb.query(`DELETE FROM firecrawl_saved_crawls WHERE user_id=$1 AND id IN (SELECT id FROM firecrawl_saved_crawls WHERE user_id=$1 ORDER BY created_at DESC OFFSET 100)`,[s.user.id]);
   return firecrawlWorkspaceResponse(res,201,{crawl:saved.rows[0]});
  } catch(error) {
   console.error('[firecrawl-workspace] Storage request failed:',JSON.stringify({status:error.statusCode||500,code:String(error.code||'').slice(0,32)||null}));
   return firecrawlWorkspaceResponse(res,error.statusCode||500,{error:error.statusCode?error.message:'Could not access Firecrawl crawl storage.'});
  }
 }
 if(path==='/login'&&req.method==='GET') {const requested=url.searchParams.get('next')||'/',next=pages.has(requested)?requested:'/';if(session(req))return send(res,303,'','text/plain; charset=utf-8',{Location:next});return send(res,200,signInPage(next),'text/html; charset=utf-8',{'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});}
 if(path==='/auth/login'&&req.method==='GET') {
   const requested=url.searchParams.get('next')||'/', next=pages.has(requested)?requested:'/';
   const state=crypto.randomBytes(32).toString('hex'), target=new URL(loginUrl); target.searchParams.set('state',state);
   const popup=url.searchParams.get('popup')==='1';
   return send(res,303,'','text/plain; charset=utf-8',{Location:target.toString(),'Set-Cookie':[cookie(stateName,state,300),cookie(nextName,encodeURIComponent(next),300),cookie(popupName,popup?'1':'',popup?300:0)]});
 }
 if(path==='/auth/perfex'&&req.method==='GET') {
   const code=url.searchParams.get('code')||'', state=url.searchParams.get('state')||'', saved=cookies(req)[stateName]||'';
   if(!secret||!/^[a-f0-9]{64}$/i.test(code)||!/^[a-f0-9]{64}$/i.test(state)||!/^[a-f0-9]{64}$/i.test(saved)||!crypto.timingSafeEqual(Buffer.from(state.toLowerCase()),Buffer.from(saved.toLowerCase()))) return send(res,400,'Invalid or expired Perfex sign-in handoff.');
   const timestamp=String(Math.floor(Date.now()/1000)), signature=crypto.createHmac('sha256',secret).update(`${timestamp}\n${code}`).digest('hex');
   try {
    const response=await fetch(exchangeUrl,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Studio-Timestamp':timestamp,'X-Studio-Signature':signature},body:new URLSearchParams({code,app:'tools'}),signal:AbortSignal.timeout(10000),redirect:'error'});
    const result=await response.json(); if(!response.ok||result.ok!==true||!result.user||!Number.isInteger(Number(result.user.id))) return send(res,401,'Perfex sign-in expired or could not be verified.');
    const token=crypto.randomBytes(32).toString('base64url'); sessions.set(token,{user:{id:Number(result.user.id),name:String(result.user.name||'Perfex user'),email:String(result.user.email||''),role:String(result.user.role||'staff')},expires:Date.now()+ttl});
    let next='/';try{next=decodeURIComponent(cookies(req)[nextName]||'/');}catch{}
    const popup=cookies(req)[popupName]==='1';
    const headers={'Set-Cookie':[cookie(cookieName,token,ttl/1000),cookie(stateName,'',0),cookie(nextName,'',0),cookie(popupName,'',0)]};
    if(popup)return send(res,200,popupCompletePage(next),'text/html; charset=utf-8',{...headers,'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'"});
    return send(res,303,'','text/plain; charset=utf-8',{...headers,Location:pages.has(next)?next:'/'});
   } catch {return send(res,502,'Perfex sign-in could not be reached. Retry shortly.');}
 }
 if(path==='/auth/logout'&&req.method==='POST') {const fetchSite=String(req.headers['sec-fetch-site']||'').toLowerCase();if(fetchSite&&fetchSite!=='same-origin')return send(res,403,'Request refused.');const s=session(req);if(s)sessions.delete(s.token);return send(res,303,'','text/plain; charset=utf-8',{Location:'https://clients.complexelite.com/studio/sso/logout','Set-Cookie':cookie(cookieName,'',0)});}
 if(path==='/auth/slo-logout'&&req.method==='GET') {const s=session(req);if(s)sessions.delete(s.token);return send(res,303,'','text/plain; charset=utf-8',{Location:'https://clients.complexelite.com/studio/sso/logout?step=2','Set-Cookie':cookie(cookieName,'',0)});}
 if(path==='/'&&req.method==='GET') {const s=session(req);if(!s)return send(res,302,'','text/plain; charset=utf-8',{Location:'/login'});return send(res,200,catalogPage(s.user),'text/html; charset=utf-8',{'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});}
 if((path==='/firecrawl'||path==='/firecrawl/')&&req.method==='GET') {const s=session(req);if(!s)return send(res,302,'','text/plain; charset=utf-8',{Location:`/login?next=${encodeURIComponent('/firecrawl')}`});return send(res,200,await firecrawlPage(s.user),'text/html; charset=utf-8',{'Content-Security-Policy':"default-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});}
 const firecrawlAsset=path.match(/^\/assets\/firecrawl\/(app\.js|app\.css)$/);
 if(firecrawlAsset) {if(!session(req))return send(res,302,'','text/plain; charset=utf-8',{Location:`/login?next=${encodeURIComponent('/firecrawl')}`});const fs=await import('node:fs/promises');const isCss=firecrawlAsset[1].endsWith('.css');return send(res,200,await fs.readFile(new URL(`../public/firecrawl/${firecrawlAsset[1]}`,import.meta.url)),isCss?'text/css; charset=utf-8':'text/javascript; charset=utf-8',{'Cache-Control':'private, max-age=300'});}
 const api=path.match(/^\/api\/v1\/runtime\/(hyperframes|ffmpeg)$/);
 if(api&&req.method==='GET') {if(!authenticatedApi(req))return send(res,401,JSON.stringify({ok:false,error:'Unauthorized'}),'application/json');return send(res,200,JSON.stringify(await probe(api[1])),'application/json');}
 if(path==='/api/ffmpeg/convert'&&req.method==='POST') {if(!session(req))return send(res,401,JSON.stringify({error:'Perfex sign-in is required.'}),'application/json');const origin=req.headers.origin;if(origin&&new URL(origin).host!==(req.headers.host||'')){req.resume();return send(res,403,JSON.stringify({error:'Cross-origin conversion requests are refused.'}),'application/json');}return convertMedia(req,res,url);}
 if(path.startsWith('/firecrawl/')) {
   if(!session(req)&&!authenticatedApi(req)){req.resume();return send(res,401,JSON.stringify({success:false,error:'Complex Elite Tools staff sign-in or a valid server signature is required.'}),'application/json');}
   if(req.headers.origin) {
     try { if(new URL(req.headers.origin).host!==(req.headers.host||'')){req.resume();return send(res,403,JSON.stringify({success:false,error:'Cross-origin Firecrawl requests are refused.'}),'application/json');} }
     catch {req.resume();return send(res,403,JSON.stringify({success:false,error:'Invalid request origin.'}),'application/json');}
   }
   const upstreamPath=path.slice('/firecrawl'.length)||'/';
   const crawlWorkflow=String(req.headers['x-ce-crawl-workflow']||'crawl');
   return proxyFirecrawl(req,res,upstreamPath+url.search,{userId:session(req)?.user.id,workflow:crawlWorkflow});
 }
 if(path==='/ai-video-captions'||path.startsWith('/ai-video-captions/')) {
   if(!session(req)) {req.resume();return send(res,302,'','text/plain; charset=utf-8',{Location:`/login?next=${encodeURIComponent('/ai-video-captions')}`});}
   return proxyAiCaptions(req,res,req.url||'/');
 }
 if(path==='/tools/openreply'||path.startsWith('/tools/openreply/')) {
   const publicPath=path.slice('/tools'.length)+url.search;
   return send(res,308,'','text/plain; charset=utf-8',{Location:publicPath});
 }
 if(path==='/openreply'||path.startsWith('/openreply/')) {
   if(!session(req)) {req.resume();return send(res,302,'','text/plain; charset=utf-8',{Location:`/login?next=${encodeURIComponent('/openreply')}`});}
   const suffix=path.slice(openReplyPublicPrefix.length)||'';
   const upstreamPath=`${openReplyInternalPrefix}${suffix}${url.search}`;
   return proxyOpenReply(req,res,upstreamPath);
 }
 if(path==='/scrapling'||path==='/scrapling/') {
   const s=session(req);if(!s)return send(res,302,'','text/plain; charset=utf-8',{Location:`/login?next=${encodeURIComponent('/scrapling')}`});
   return send(res,200,scraplingPage(s.user),'text/html; charset=utf-8',{'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});
 }
 if(path==='/scrapling/mcp') {
   if(!session(req)&&!/^Bearer\s+\S+$/i.test(String(req.headers.authorization||''))) {req.resume();return send(res,401,'Perfex staff sign-in or Scrapling bearer authentication is required.');}
   const upstreamPath=`/mcp${url.search}`;
   return proxyScrapling(req,res,upstreamPath);
 }
 const mapsPage=path==='/google-maps-scraper'||path==='/google-maps-scraper/';
 const legacyMapsPath=legacyGoogleMapsPath(path);
 if(legacyMapsPath)return send(res,308,'','text/plain; charset=utf-8',{Location:legacyMapsPath+url.search});
 const mapsAppPath=path==='/google-maps-scraper'||path.startsWith('/google-maps-scraper/');
 if(mapsAppPath) {
   if(!session(req)) {
     if(mapsPage||pages.get(path)==='api-docs')return send(res,302,'','text/plain; charset=utf-8',{Location:`/login?next=${encodeURIComponent(path)}`});
     req.resume();return send(res,401,'Perfex staff sign-in is required.','text/plain; charset=utf-8');
   }
   return proxyGoogleMaps(req,res,req.url||'/');
 }
 const slug=pages.get(path);
 if(slug==='hyperframes') {if(!session(req))return send(res,302,'','text/plain; charset=utf-8',{Location:`/login?next=${encodeURIComponent(path)}`});return send(res,302,'','text/plain; charset=utf-8',{Location:'/hyperframes/editor/#project/default'});}
 if(path==='/hyperframes/editor'||path==='/hyperframes/editor/') {if(!session(req))return send(res,302,'','text/plain; charset=utf-8',{Location:`/login?next=${encodeURIComponent('/hyperframes')}`});return proxyPreview(req,res,'/'+url.search);}
 if(slug==='ffmpeg') {const s=session(req);if(!s)return send(res,302,'','text/plain; charset=utf-8',{Location:`/login?next=${encodeURIComponent(path)}`});return send(res,200,ffmpegPage(s.user,await probe(slug)),'text/html; charset=utf-8',{'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});}
 const brandFiles=new Map([['/favicon.ico',['favicon.ico','image/vnd.microsoft.icon']],['/favicon.svg',['favicon.svg','image/svg+xml']],['/favicon-16x16.png',['favicon-16x16.png','image/png']],['/favicon-32x32.png',['favicon-32x32.png','image/png']],['/favicon-48x48.png',['favicon-48x48.png','image/png']],['/apple-touch-icon.png',['apple-touch-icon.png','image/png']],['/site.webmanifest',['site.webmanifest','application/manifest+json']],['/fonts/Montserrat-Variable.ttf',['fonts/Montserrat-Variable.ttf','font/ttf']],['/brand/complex-elite_horizontal_colour.svg',['brand/complex-elite_horizontal_colour.svg','image/svg+xml']],['/brand/complex-elite_horizontal_colour-reverse.svg',['brand/complex-elite_horizontal_colour-reverse.svg','image/svg+xml']],['/brand/complex-elite_icon_colour-reverse_500px.png',['brand/complex-elite_icon_colour-reverse_500px.png','image/png']]]);
 if(brandFiles.has(path)){const fs=await import('node:fs/promises');const [file,type]=brandFiles.get(path);return send(res,200,await fs.readFile(new URL(`../public/${file}`,import.meta.url)),type,{'Cache-Control':'public, max-age=86400'});}
 if(path==='/assets/tools.css') {const fs=await import('node:fs/promises');return send(res,200,await fs.readFile(new URL('../public/tools.css',import.meta.url)),'text/css; charset=utf-8');}
 if(path==='/assets/signin.js') {const fs=await import('node:fs/promises');return send(res,200,await fs.readFile(new URL('../public/signin.js',import.meta.url)),'text/javascript; charset=utf-8');}
 if(path==='/assets/auth-callback.js') {const fs=await import('node:fs/promises');return send(res,200,await fs.readFile(new URL('../public/auth-callback.js',import.meta.url)),'text/javascript; charset=utf-8');}
 if(path==='/assets/ffmpeg.js') {const fs=await import('node:fs/promises');return send(res,200,await fs.readFile(new URL('../public/ffmpeg.js',import.meta.url)),'text/javascript; charset=utf-8');}
 if(path.startsWith('/assets/')||path==='/favicon.svg') {if(!session(req))return send(res,302,'','text/plain; charset=utf-8',{Location:`/login?next=${encodeURIComponent('/hyperframes')}`});return proxyPreview(req,res,req.url||'/');}
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
if(firecrawlWorkspaceDb){await initializeFirecrawlWorkspaceDb();await resumeFirecrawlMonitors();}
server.listen(port,'0.0.0.0');
