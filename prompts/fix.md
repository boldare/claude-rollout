Message from the rollout driver about PR {{id}} ("{{title}}"), reason: **{{reason}}**.

{{note}}

Current PR: {{pr}}. Current PR head on GitHub: {{head}}.

Continue with the same protocol you were given at the start of this session (the brief is in your first message): fix what is needed, verify locally (step 3), commit and push to `{{branch}}` only, wait for CI on the new head (step 6), run the self-check (step 7) and finish with a fresh structured report: READY with the new `headSha`, or BLOCKED.

Writing rules for this rollout, for the whole PR (also parts you are not asked about): comments only where they explain why or a non-obvious constraint, never restating code or narrating the change. Short prose. No semicolons in comments, docs, the changeset or the PR text: a period and a new sentence instead.
