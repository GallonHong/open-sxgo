/** Versioned demo policy. Production changes require recorded legal/operational review. */
export const retentionPolicy = {
  version: 'retention-demo-v1',
  closedSubmissionDays: 90,
  abuseCounterHours: 24,
  adArchiveYears: 3,
  adArchiveEnabled: false,
} as const;
