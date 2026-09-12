import { z } from 'zod';

// Member and assessment responses expose workflow results, never storage rows or raw references.
const workflowResult = z.object({
  id: z.string(),
  status: z.string(),
  version: z.number().int(),
  domain: z.string().optional(),
  work_type: z.string().optional(),
  materiality: z.string().optional(),
  challenge_expires_at: z.string().nullable().optional(),
  target_role: z.string().optional(),
  decision_reason: z.string().nullable().optional(),
  valid_until: z.string().nullable().optional(),
  subject_type: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  replayed: z.boolean().optional(),
});
export const resultView = (input: unknown) => workflowResult.parse(input);
