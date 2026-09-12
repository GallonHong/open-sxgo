# Static source processor boundary

This directory records the admission policy for the separately deployed P0
source processor. The application gateway does not run a source fetcher when
this boundary is absent: `createNodeStaticProcessor` reports
`SAFE_PROCESSOR_UNAVAILABLE`, and the queue remains failed rather than claiming
that a local process is isolated.

The processor receives only an opaque `ProcessorTask` (`task_id`, `source_id`,
and `policy_version`). A broker inside the isolated service resolves the target
for that task. It must not receive a Principal, session cookie, grant secret,
database credential, signer key, cloud admin token, Docker socket, host mount,
or host network access. The egress proxy or microVM admission layer must
enforce the values in `runtime-policy.json` and return an attestation consumed
by the processor. A Docker container alone is not the production isolation
boundary.

P0 accepts only an explicitly allowed public domain and static HTML, plain text,
or JSON. Dynamic rendering, unknown domains, login flows, binary downloads,
attachments, and reviewer navigation are disabled. DNS A and AAAA answers are
all checked for public addresses before connecting to one verified address;
each redirect repeats policy and DNS checks. The source task limits are 30 s,
10 MiB per response, 30 MiB per task, 100 requests, three redirects, and one
retry. The original purchase link checker is a separate path with its own 10 s
and 2 MiB response limit.

The image or host is not eligible for production until an operator can show,
on the deployed runtime, a fresh isolation and egress attestation, empty
credential/mount inventories, and a failed probe when those checks are absent.
Tests may inject an in-memory `SourceProcessor`; that fixture is not a
production substitute.
