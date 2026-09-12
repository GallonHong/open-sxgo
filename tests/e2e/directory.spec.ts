import { test, expect } from '@playwright/test';
test('社区页面明确演示阶段，不编造治理记录',async({page})=>{
  await page.goto('/community');
  await expect(page.getByRole('heading',{name:'参与共建'})).toBeVisible();
  await expect(page.getByText('建设阶段 · 独立治理尚未就绪')).toBeVisible();
  await page.getByRole('link',{name:'职责与授权',exact:true}).click();
  await expect(page.getByText('尚无已验证的公开治理记录。')).toBeVisible();
});
test('搜索、范围、未知项与消费开关', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.company-card')).toHaveCount(1);
  await page.getByLabel('搜索企业').fill('Apple');
  await expect(page.locator('.company-card')).toHaveCount(1);
  await page.getByLabel('所在城市').selectOption('北京');
  await expect(page.locator('.company-card')).toHaveCount(1);
  await page.getByRole('link', { name: '查看适用范围 →' }).click();
  await expect(page.getByText('加班报酬实际支付', { exact: true })).toBeVisible();
  await expect(page.getByText('暂无足够资料', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '找产品与服务', exact: true })).toHaveCount(0);
  await page.goto('/discover');
  await expect(page.getByRole('heading', { name:'找不到这个页面' })).toBeVisible();
});
test('周末筛选排除轮休，无结果不作负面结论', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: '周末双休', exact: true }).check();
  await expect(page.locator('.company-card')).toHaveCount(0);
  await page.getByLabel('搜索企业').fill('不存在的企业');
  await expect(page.getByText('未收录不代表企业不符合条件或违法。试试其他筛选。')).toBeVisible();
});
test('手机布局与数据下载', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.company-card')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto('/data');
  await expect(page.getByRole('link', { name: 'directory.sqlite ↓' })).toBeVisible();
});
test('离线更新失败使用已验证历史，不冒充当前推荐', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('.company-card')).toHaveCount(1);
  await page.route('**/public/**', (route) => route.abort());
  await page.reload();
  await expect(page.getByText('历史副本 /', { exact: false })).toBeVisible();
  await expect(page.locator('.company-card')).toHaveCount(1);
});
test('篡改首次下载则拒绝展示', async ({ page }) => {
  await page.route('**/public/releases/**/directory.json', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({ response, body: body.replace('苹果', '恶意') });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '暂时无法验证目录' })).toBeVisible();
  await expect(page.locator('.company-card')).toHaveCount(0);
});
test('投稿、回执补充、撤回，网址与外部请求无回执', async ({ page }) => {
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  await page.goto('http://127.0.0.1:5174/contribute');
  await page.getByLabel('完整企业名称').fill('浏览器测试示例有限公司');
  await page.getByLabel('城市', { exact: true }).fill('长沙');
  await page.getByLabel('岗位或场所范围').fill('研发岗位');
  await page.getByLabel('公开来源链接').fill('https://example.org/policy');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '提交推荐' }).click();
  await expect(page.getByRole('heading', { name: '谢谢你的推荐。' })).toBeVisible();
  const receipt = (await page.locator('.receipt').textContent())!;
  expect(receipt).toHaveLength(64);
  await page.getByRole('link', { name: '凭回执查看进度 →' }).click();
  await page.getByLabel('私密回执', { exact: true }).fill(receipt);
  await page.getByRole('button', { name: '查询进度' }).click();
  await expect(page.getByText('当前状态：submitted')).toBeVisible();
  await page.getByLabel('补充公开线索').fill('这是浏览器端测试的公开补充。');
  await page.getByRole('button', { name: '提交补充' }).click();
  await expect(page.getByText('这是浏览器端测试的公开补充。', { exact: false })).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: '撤回未发布投稿' }).click();
  await expect(page.getByText('当前状态：withdrawn')).toBeVisible();
  expect(urls.some((url) => url.includes(receipt))).toBe(false);
  expect(urls.some((url) => !url.startsWith('http://127.0.0.1:5174'))).toBe(false);
});
