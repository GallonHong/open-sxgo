import type { Database } from '../../db/src/adapter';

export type ReviewStage = 'initial' | 'independent' | 'escalation';
export type AssignmentStage = 'primary' | 'secondary' | 'escalation';
export type ReviewAction = 'approve' | 'reject' | 'return' | 'abstain';
export type ReviewCaseState =
  | 'open'
  | 'awaiting_independent_review'
  | 'approved_for_publication'
  | 'rejected'
  | 'returned'
  | 'blocked'
  | 'needs_escalation'
  | 'superseded';
export type BlockingIssueCode =
  | 'privacy_leak'
  | 'subject_mismatch'
  | 'source_fabrication'
  | 'phishing_link'
  | 'scope_mismatch'
  | 'unresolved_major_conflict';

export type ReviewAuthorization = Readonly<{
  principal_id: string;
  /** Canonical person identity. Independence is calculated from this value. */
  person_id: string;
  grant_id: string;
  capability:
    | 'case.prepare'
    | 'case.read_public_source'
    | 'case.submit_decision'
    | 'case.resolve_blocking';
  expires_at: string;
}>;

/** Identity service owns the backing table and returns this read-only view. */
export type CaseAssignment = Readonly<{
  assignment_id: string;
  case_id: string;
  case_revision: number;
  reviewer_person_id: string;
  /** Identity service vocabulary: primary maps to initial, secondary to independent. */
  stage: AssignmentStage;
  state: 'assigned' | 'active' | 'completed' | 'declined' | 'expired';
  expires_at: string;
}>;

export interface AssignmentProvider {
  find(input: {
    assignment_id: string;
    case_id: string;
    case_revision: number;
    person_id: string;
    stage?: AssignmentStage;
  }): Promise<CaseAssignment | null>;
  /**
   * Optional server-side queue lookup.  The API uses this to select the
   * caller's assignment from the session/person binding, so clients do not
   * have to type or forge an assignment id.
   */
  listForPerson?(input: {
    case_id?: string;
    case_revision?: number;
    person_id: string;
  }): Promise<readonly CaseAssignment[]>;
}

export type ReviewAuthorizationCheck = Readonly<{
  action: ReviewAuthorization['capability'];
  case_id: string;
  case_revision: number;
  person_id: string;
  principal_id: string;
  grant_id: string;
  assignment_id?: string;
}>;
export type ReviewAuthorizationChecker = (input: ReviewAuthorizationCheck) => Promise<void>;
export type CandidateValidator = (candidate: unknown) => void | Promise<void>;

export type ReviewWorkflowOptions = Readonly<{
  assignments: AssignmentProvider;
  authorize?: ReviewAuthorizationChecker;
  validate_candidate?: CandidateValidator;
  now?: () => Date;
}>;

export type CreateCaseInput = Readonly<{
  case_id: string;
  submission_id: string;
  candidate: unknown;
  source_preview_ids: readonly string[];
  reason: string;
  authorization: ReviewAuthorization & { capability: 'case.prepare' };
}>;

export type SubmitRevisionInput = Readonly<{
  case_id: string;
  expected_revision: number;
  candidate: unknown;
  source_preview_ids: readonly string[];
  reason: string;
  authorization: ReviewAuthorization;
  assignment_id: string;
}>;

export type BindPreviewInput = Readonly<{
  case_id: string;
  expected_revision: number;
  source_preview_ids: readonly string[];
  reason: string;
  authorization: ReviewAuthorization & { capability: 'case.prepare' };
}>;

export type RecordDecisionInput = Readonly<{
  case_id: string;
  revision: number;
  candidate_digest: string;
  action: ReviewAction;
  reason: string;
  blocking_issue_codes?: readonly BlockingIssueCode[];
  authorization: ReviewAuthorization;
  assignment_id: string;
}>;

export type ReviewCaseView = Readonly<{
  case_id: string;
  revision: number;
  state: ReviewCaseState;
  candidate_digest: string;
  candidate: unknown;
  source_preview_ids: readonly string[];
  decision_visibility: 'blind' | 'revealed';
  decisions: readonly {
    stage: ReviewStage;
    action: ReviewAction;
    reason: string;
    reviewer_person_id: string;
    created_at: string;
  }[];
}>;

export type PublicationStatus = Readonly<{
  case_id: string;
  revision: number;
  state: ReviewCaseState;
  candidate_digest: string;
  eligible: boolean;
  independent_approvals: number;
  open_blocking_issues: number;
  reason:
    | 'ready'
    | 'waiting_for_initial_review'
    | 'waiting_for_independent_review'
    | 'blocking_issue_unresolved'
    | 'review_disagreement'
    | 'rejected'
    | 'returned';
}>;

export type WorkflowDatabase = Database;
