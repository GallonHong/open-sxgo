import { Miniflare } from 'miniflare';
import { readFile,readdir } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
const mf=new Miniflare({modules:[{type:'ESModule',path:'dist/server/index.js'}],compatibilityDate:'2026-07-30',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{BETTER_AUTH_SECRET:crypto.randomUUID()+crypto.randomUUID(),MODE:'production',INTAKE_ENABLED:'true',ADMIN_ORIGIN:'http://localhost',INTAKE_ORIGIN:'http://localhost'}});
try {
 const db=await mf.getD1Database('DB');
 for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort()) { const sql=await readFile('migrations/'+file,'utf8'); for(const stmt of sql.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(stmt).run(); }
 const health=await mf.dispatchFetch('http://localhost/health');assert.equal(health.status,200);assert.equal((await health.json() as any).database,'ready');
 const data={legal_name:'后端验收测试有限公司',city:'北京',scope:'测试岗位',employment_type:'full_time_employee',conditions:[{dimension:'rest_schedule',value:'unknown',description:'验证提交存储'}],source_urls:['https://example.org/policy'],source_type:'company'};
 const post=(path:string,body:unknown,receipt?:string)=>mf.dispatchFetch('http://localhost/private/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json','Origin':'http://localhost','Idempotency-Key':crypto.randomUUID(),...(receipt?{'X-WFD-Receipt':receipt}:{})},body:JSON.stringify(body)});
 const submitted=await post('submissions',data); const value=await submitted.json() as any;assert.equal(submitted.status,201,JSON.stringify(value));assert.match(value.receipt,/^[a-f0-9]{64}$/);
 const status=await post('submissions/status',{},value.receipt);assert.equal(status.status,200,await status.text());
 const page=await mf.dispatchFetch('http://localhost/contribute');assert.equal(page.status,200);assert.match(page.headers.get('Cache-Control')??'',/no-store/);
 assert.ok([401,403].includes((await mf.dispatchFetch('http://localhost/admin/v1/cases')).status));
 console.log('Sites Worker: D1 migrations, persisted submission, receipt read, private UI and unauthorized rejection passed');
}finally{await mf.dispose()}
