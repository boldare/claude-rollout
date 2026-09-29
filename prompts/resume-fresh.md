You are taking over PR {{id}} ("{{title}}") in the rollout `{{rollout}}` for {{github}}. A previous implementer session could not be resumed. Its work, if any, is in this worktree and possibly already pushed to `{{branch}}` (PR: {{pr}}).

Reason you were started: **{{reason}}**.

{{note}}

Start by inspecting the state (`git status`, `git log origin/{{base}}..HEAD`, `gh pr list --head {{branch}}`), then continue with the protocol below.

---

{{implement}}
