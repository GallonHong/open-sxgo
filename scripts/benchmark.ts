import { gzipSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { fixtureDataset } from './fixtures';
import { search } from '../packages/search/src/index';
const sample = fixtureDataset().companies;
const companies = Array.from({ length: 100000 }, (_, i) => {
  const c = structuredClone(sample[i % sample.length]);
  c.company_id = 'co_bench_' + i;
  c.legal_name = c.legal_name + '（示例主体 ' + i + '）';
  return c;
});
const sizes = { full_index_gzip_bytes: gzipSync(JSON.stringify({ companies })).length };
const times: number[] = [];
for (let i = 0; i < 20; i++) {
  const start = performance.now();
  search(companies, { city: ['长沙', '苏州', '杭州', '深圳'][i % 4], q: i % 2 ? '木序' : '' });
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
const result = {
  records: companies.length,
  ...sizes,
  p95_ms: times[Math.ceil(times.length * 0.95) - 1],
  environment: process.version + ' ' + process.platform + ' ' + process.arch,
  measured_at: new Date().toISOString(),
};
await mkdir('.runtime/reports', { recursive: true });
await writeFile('.runtime/reports/benchmark.json', JSON.stringify(result, null, 2));
console.log(result);
