import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {legacyGoogleMapsPath} from '../src/google-maps-routes.mjs';

test('legacy routes match scraper paths without capturing other tools',()=>{
 for(const path of ['/api/docs','/static/css/main.css','/api/v1/jobs/id/download','/jobs','/scrape','/view'])
  assert.equal(legacyGoogleMapsPath(path),'/google-maps-scraper'+path);
 for(const path of ['/api/v1/runtime/ffmpeg','/static-other','/download-other','/api/v1/other','/google-maps-scraper/api/docs'])
  assert.equal(legacyGoogleMapsPath(path),null);
});

test('gateway preserves methods, queries and protected namespaced routes',async()=>{
 const serverURL=new URL('../src/server.mjs',import.meta.url);
 const source=(await readFile(serverURL,'utf8'))
  .replace("'./google-maps-routes.mjs'",JSON.stringify(new URL('../src/google-maps-routes.mjs',import.meta.url).href))
  .replace('await startPreview();','')
  .replace("server.listen(port,'0.0.0.0');","server.listen(0,'127.0.0.1',()=>console.log(server.address().port));");
 const child=spawn(process.execPath,['--input-type=module'],{stdio:['pipe','pipe','inherit']});
 child.stdin.end(source);
 try {
  const [chunk]=await once(child.stdout,'data');
  const base='http://127.0.0.1:'+String(chunk).trim();
  for(const [method,path] of [['GET','/api/docs'],['GET','/static/css/main.css'],['POST','/scrape'],['DELETE','/api/v1/jobs/id'],['GET','/download?id=abc&page=2']]) {
   const r=await fetch(base+path,{method,redirect:'manual'});
   assert.equal(r.status,308);
   assert.equal(r.headers.get('location'),'/google-maps-scraper'+path);
  }
  const docs=await fetch(base+'/google-maps-scraper/api/docs',{redirect:'manual'});
  assert.equal(docs.status,302);
  assert.equal(docs.headers.get('location'),'/login?next=%2Fgoogle-maps-scraper%2Fapi%2Fdocs');
  const login=await (await fetch(base+docs.headers.get('location'))).text();
  assert.ok(login.includes('/auth/login?next=%2Fgoogle-maps-scraper%2Fapi%2Fdocs'));
  for(const path of ['/google-maps-scraper/api/v1/jobs','/api/v1/runtime/ffmpeg'])
   assert.equal((await fetch(base+path,{redirect:'manual'})).status,401);
 }finally{child.kill();await once(child,'exit')}
});
