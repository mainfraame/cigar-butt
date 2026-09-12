---
description: Style-audit changed files against STYLEGUIDE.md and the hard rules (read-only)
argument-hint: '[commit ref | file paths] (default: uncommitted + staged diff)'
---

Run an independent style audit using the `style-auditor` agent.

Scope: $ARGUMENTS

If the scope above is empty, audit the uncommitted + staged diff. If it names a
commit ref (e.g. `HEAD~1`, a sha, or `main..HEAD`), audit that range. If it
names file paths, audit exactly those files.

Launch the `style-auditor` agent with that scope and wait for it — do not audit
inline yourself, since the point is a second opinion from an agent that did not
write the code. Relay its findings verbatim, grouped by file, plus its summary
line.

The audit is **read-only**: report violations, do not fix them. It does not run
`pnpm lint`, `format`, `typecheck` or the tests — those are the author's to run
via `pnpm check`, and two of them mutate the working tree. If the user wants the
findings applied, that's a separate follow-up they ask for.

Findings against a hard rule in `CLAUDE.md` — decimal.js arithmetic, the
`undefined`-vs-`false` distinction, undated figures, disqualifiers running after
valuation, net-cash on a financial, a leaked credential — are correctness bugs
rather than style nits. Call those out first in your relay.
