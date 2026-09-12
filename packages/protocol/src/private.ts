import { z } from 'zod';
import { id, text, httpsURL, companySchema, datasetSchema } from './public';
export const submissionSchema = z
  .strictObject({
    legal_name: text,
    city: text,
    scope: text,
    employment_type: z.enum(['full_time_employee', 'other', 'unknown']),
    conditions: z
      .array(
        z.strictObject({
          dimension: text,
          value: z.enum(['known', 'unknown']),
          description: z.string().max(300),
        }),
      )
      .min(1)
      .max(15),
    source_type: z.enum(['company', 'recruitment', 'report', 'personal_lead', 'business']),
    source_urls: z.array(httpsURL).max(10),
    notes: z.string().max(500).default(''),
  })
  .refine(
    (v) => v.source_type === 'personal_lead' || v.source_urls.length > 0,
    '公开资料投稿需要来源链接',
  );
export const reportSchema = z.strictObject({
  record_id: id.nullable(),
  kind: z.enum(['change', 'privacy', 'impersonation', 'link', 'appeal']),
  message: text,
  source_urls: z.array(httpsURL).max(10),
});
export const proposalSchema = z.strictObject({
  submission_id: id,
  company: companySchema,
  public_data: datasetSchema,
  expected_revision: z.number().int().nonnegative(),
  reason: text,
});
export type SubmissionInput = z.infer<typeof submissionSchema>;
export type Principal = {
  user_id: string;
  session_id?: string;
  person_id: string;
  roles: string[];
  company_ids: string[];
  conflicts: string[];
  verified: boolean;
  two_factor: boolean;
};
export type ProposalInput = z.infer<typeof proposalSchema>;
export const states = [
  'submitted',
  'triaged',
  'in_review',
  'second_review',
  'needs_info',
  'out_of_scope',
  'rejected',
  'returned',
  'approved_for_publication',
  'published',
  'withdrawn',
] as const;
