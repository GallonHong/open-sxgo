import type { Company } from '../../protocol/src/public';
import { eligible, restMatch, validClaim } from '../../domain/src/index';
export type Filters = {
  q?: string;
  city?: string;
  industry?: string;
  job?: string;
  rest?: string;
  evidence?: string;
  recent?: boolean;
  history?: boolean;
};
export function search(companies: Company[], filters: Filters, now = new Date()) {
  const q = filters.q?.trim().normalize('NFKC').toLocaleLowerCase() ?? '';
  return companies
    .map((c) => ({
      ...c,
      scopes: c.scopes.filter(
        (s) =>
          (filters.history || eligible(s, now)) &&
          (!filters.city || s.city === filters.city) &&
          (!filters.job || s.job_group === filters.job) &&
          (!filters.rest || restMatch(s, filters.rest, now)) &&
          (!filters.evidence ||
            s.claims.some((x) => validClaim(x, now) && x.evidence_status === filters.evidence)) &&
          (!filters.recent ||
            s.claims.some(
              (x) => x.checked_on && Date.parse(x.checked_on) >= now.getTime() - 180 * 86400000,
            )),
      ),
    }))
    .filter(
      (c) =>
        c.scopes.length &&
        (!filters.industry || c.industry === filters.industry) &&
        (!q ||
          [c.legal_name, ...c.aliases, ...c.scopes.map((s) => s.city)].some((v) =>
            v.normalize('NFKC').toLowerCase().includes(q),
          )),
    )
    .sort(
      (a, b) =>
        Number(b.legal_name === q) - Number(a.legal_name === q) ||
        latest(b).localeCompare(latest(a)) ||
        a.company_id.localeCompare(b.company_id),
    );
}
function latest(c: Company) {
  return (
    c.scopes
      .flatMap((s) => s.claims.map((x) => x.checked_on ?? ''))
      .sort()
      .at(-1) ?? ''
  );
}
