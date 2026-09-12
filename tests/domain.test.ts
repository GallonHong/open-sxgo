import { describe, it, expect } from 'vitest';
import { fixtureDataset } from '../scripts/fixtures';
import { validateDataset, eligible, usableLink, restMatch } from '../packages/domain/src/index';
import { datasetSchema, httpsURL } from '../packages/protocol/src/public';
import { search } from '../packages/search/src/index';
const now = new Date('2026-09-12T08:00:00Z');
describe('范围、证据与公开边界', () => {
  it('AC-001 同名企业保持独立主体', () =>
    expect(search(fixtureDataset(now).companies, { q: '木序' }, now)).toHaveLength(2));
  it('AC-003 只匹配所选岗位', () =>
    expect(search(fixtureDataset(now).companies, { job: '研发岗位' }, now)).toHaveLength(1));
  it('AC-004 轮休不匹配周末双休', () => {
    const s = fixtureDataset(now).companies[5].scopes[0];
    expect(restMatch(s, 'weekend', now)).toBe(false);
    expect(restMatch(s, 'two_days', now)).toBe(true);
  });
  it('AC-006 官网制度不会升级为实践', () =>
    expect(fixtureDataset(now).companies[0].scopes[0].claims[0].evidence_status).toBe(
      'source_checked',
    ));
  it('AC-007 转载不构成独立实践证据', () => {
    const d = fixtureDataset(now);
    d.companies[0].scopes[0].claims[0].evidence_status = 'practice_corroborated';
    d.companies[0].scopes[0].claims[0].valid_until = '2026-10-01';
    expect(() => validateDataset(d, now)).toThrow('PRACTICE_NOT_INDEPENDENT');
  });
  it('AC-011 未知字段不被补齐', () => {
    const d = fixtureDataset(now);
    expect(d.companies[0].scopes[0].claims[2].value).toBeNull();
    d.companies[0].scopes[0].claims[2].value = '已支付';
    expect(() => datasetSchema.parse(d)).toThrow();
  });
  it('AC-012 特殊工时不授予组合资格', () => {
    const s = fixtureDataset(now).companies[0].scopes[0];
    s.work_time_regime = 'special_regime_pending_review';
    expect(eligible(s, now)).toBe(false);
  });
  it('AC-013 未生效规则拒绝当前结论', () => {
    const d = fixtureDataset(now);
    d.rules[0].effective_from = '2026-09-20';
    expect(() => validateDataset(d, now)).toThrow('RULE_NOT_EFFECTIVE');
  });
  it('AC-014 超期后退出推荐', () =>
    expect(search(fixtureDataset(now).companies, {}, new Date('2027-09-12'))).toHaveLength(0));
  it('AC-015 暂停范围不再显示正向资格', () => {
    const d = fixtureDataset(now);
    d.companies[0].scopes[0].listing_state = 'suppressed';
    expect(eligible(d.companies[0].scopes[0], now)).toBe(false);
  });
  it('AC-022 拒绝私密字段', () =>
    expect(() =>
      datasetSchema.parse({ ...fixtureDataset(now), receipt_token: 'private' }),
    ).toThrow());
  it('AC-022 拒绝自由文本隐私诱饵', () => {
    const d = fixtureDataset(now);
    d.companies[0].scopes[0].limitations.push('WFD_PRIVATE_CANARY');
    expect(() => validateDataset(d, now)).toThrow('PRIVACY_BLOCKED');
  });
  it('AC-022 拒绝公开手机号', () => {
    const d = fixtureDataset(now);
    d.companies[0].scopes[0].limitations.push('员工联系电话 13812345678');
    expect(() => validateDataset(d, now)).toThrow('PRIVACY_BLOCKED');
  });
  it('AC-025 经营主体不匹配拒绝', () => {
    const d = fixtureDataset(now);
    d.links[1].seller_company_id = 'co_demo_1';
    expect(() => validateDataset(d, now)).toThrow('SELLER_MISMATCH');
  });
  it('AC-029 缺少广告标签不可推广', () => {
    const d = fixtureDataset(now);
    d.links[1].ad_label = '';
    expect(usableLink(d.links[1], d, now, true)).toBe(false);
  });
  it('AC-055 推荐暂停即使链接安全也停止推广', () => {
    const d = fixtureDataset(now);
    d.companies[0].scopes[0].listing_state = 'suppressed';
    expect(usableLink(d.links[1], d, now, true)).toBe(false);
  });
  it.each([
    'http://example.org',
    'https://user:password@example.org',
    'https://example.org?token=secret',
    'https://localhost/x',
    'javascript:alert(1)',
  ])('不安全来源 %s 被拒绝', (url) => expect(httpsURL.safeParse(url).success).toBe(false));
  it('引用缺失与重复 ID 均阻断发布', () => {
    const d = fixtureDataset(now);
    d.sources = [];
    expect(() => validateDataset(d, now)).toThrow('MISSING_SOURCE');
    const duplicate = fixtureDataset(now);
    duplicate.companies.push(duplicate.companies[0]);
    expect(() => validateDataset(duplicate, now)).toThrow('DUPLICATE_ID');
  });
});
