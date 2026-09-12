import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { catalogueDataset } from './catalogue';
import { publishDemo } from '../packages/builder/src/index';
import { publicSchemas } from '../packages/protocol/src/public';
const out = resolve('.runtime/public');
await mkdir(out, { recursive: true });
// This directory contains generated public artifacts only. Never touch private state.
await rm(resolve(out, 'public'), { recursive: true, force: true });
const { root, manifest } = await publishDemo(catalogueDataset(), resolve(out, 'public'));
await mkdir('bootstrap', { recursive: true });
await writeFile('bootstrap/demo-root.json', JSON.stringify(root));
await mkdir(resolve(out, 'schemas'), { recursive: true });
await mkdir('schemas', { recursive: true });
for (const [name, schema] of Object.entries(publicSchemas)) {
  await writeFile(resolve(out, 'schemas', name + '.json'), JSON.stringify(schema, null, 2));
  await writeFile(resolve('schemas', name + '.schema.json'), JSON.stringify(schema, null, 2));
}
console.log(`已生成公开参考资料（测试签名） ${manifest.release_id}；演示密钥仅在本次进程内使用。`);
