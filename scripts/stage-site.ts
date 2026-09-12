import { cp, rm, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
await rm('dist/client', { recursive:true, force:true });
await cp('dist/web','dist/client',{recursive:true});
for(const app of ['intake','admin']) {
 await cp(`dist/${app}/assets`,'dist/client/assets',{recursive:true});
 await cp(`dist/${app}/index.html`,`dist/client/${app}.html`);
}
const assets:Record<string,{type:string;base64:string}>={};
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.jsonl':'application/x-ndjson','.sqlite':'application/vnd.sqlite3'};
async function walk(dir:string,prefix=''){for(const entry of await readdir(dir,{withFileTypes:true})){const relative=prefix+'/'+entry.name;if(entry.isDirectory())await walk(dir+'/'+entry.name,relative);else assets[relative]={type:mime[extname(entry.name)]??'application/octet-stream',base64:(await readFile(dir+'/'+entry.name)).toString('base64')};}}
await walk('dist/client');
await mkdir('.runtime/sites',{recursive:true});
await writeFile('.runtime/sites/assets.ts','export default '+JSON.stringify(assets));
await mkdir('dist/server',{recursive:true});
execFileSync('pnpm',['exec','esbuild','apps/site/src/worker.ts','--bundle','--format=esm','--platform=browser','--target=es2023','--external:node:*','--alias:virtual:site-assets='+resolve('.runtime/sites/assets.ts'),'--outfile=dist/server/index.js'],{stdio:'inherit'});
await mkdir('dist/.openai/drizzle/meta',{recursive:true});
await cp('.openai/hosting.json','dist/.openai/hosting.json');
const files=(await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort();
for(const file of files)await cp('migrations/'+file,'dist/.openai/drizzle/'+file);
await writeFile('dist/.openai/drizzle/meta/_journal.json',JSON.stringify({version:'7',dialect:'sqlite',entries:files.map((f,idx)=>({idx,version:'6',when:1789171200000+idx,tag:f.slice(0,-4),breakpoints:false}))}));
