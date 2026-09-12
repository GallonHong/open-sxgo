import { describe,it,expect } from 'vitest';
import { catalogueDataset } from '../scripts/catalogue';
import { validateDataset,eligible,validClaim } from '../packages/domain/src/index';
describe('public reference catalogue',()=>{
 it('contains one real scoped entity and no fictional promotional records',()=>{const d=validateDataset(catalogueDataset());expect(d.companies).toHaveLength(1);expect(d.companies[0].aliases).toContain('Apple');expect(d.products).toEqual([]);expect(d.links).toEqual([]);expect(JSON.stringify(d)).not.toMatch(/example\.com|co_demo_|木序/)});
 it('does not turn an identity source into verified labour conditions',()=>{const d=catalogueDataset();const s=d.companies[0].scopes[0];expect(eligible(s)).toBe(false);expect(s.claims.every(c=>c.value===null&&!validClaim(c)&&c.source_ids.length===0)).toBe(true);expect(d.decisions).toEqual([])});
 it('keeps regional reports and recruitment context outside verified claims',()=>{const d=validateDataset(catalogueDataset());expect(d.sources.length).toBeGreaterThan(1);expect(new Set(d.sources.map(s=>s.source_family)).size).toBe(1);for(const source of d.sources){expect(source.supported_claim_ids).toEqual([]);expect(source.applicability).toBeTruthy();expect(source.related_company_ids).toEqual(['co_apple_beijing']);}expect(eligible(d.companies[0].scopes[0])).toBe(false)});
 it('rejects a source linked to an absent company',()=>{const d=catalogueDataset();d.sources[0].related_company_ids=['co_missing'];expect(()=>validateDataset(d)).toThrow('SOURCE_COMPANY_NOT_FOUND')});
});
