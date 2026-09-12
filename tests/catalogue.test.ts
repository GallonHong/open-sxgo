import { describe,it,expect } from 'vitest';
import { catalogueDataset } from '../scripts/catalogue';
import { validateDataset,eligible,validClaim } from '../packages/domain/src/index';
describe('public reference catalogue',()=>{
 it('contains one real scoped entity and no fictional promotional records',()=>{const d=validateDataset(catalogueDataset());expect(d.companies).toHaveLength(1);expect(d.companies[0].aliases).toContain('Apple');expect(d.products).toEqual([]);expect(d.links).toEqual([]);expect(JSON.stringify(d)).not.toMatch(/example\.com|co_demo_|木序/)});
 it('does not turn an identity source into verified labour conditions',()=>{const d=catalogueDataset();const s=d.companies[0].scopes[0];expect(eligible(s)).toBe(false);expect(s.claims.every(c=>c.value===null&&!validClaim(c)&&c.source_ids.length===0)).toBe(true);expect(d.decisions).toEqual([])});
});
