# Railroad — Iron Dynasty — DOMECS exemplar

A real-time railroad tycoon management sim. Built on the DOMECS engine
(`@domecs/*`), consumed from the sibling `../domecs` checkout via `file:` deps —
clone this repo alongside `domecs`.

## Recording findings

Record every deficiency where the fault actually lives:

- **This app's own deficiencies** — bugs, missing features, UX/DX gaps in *this*
  codebase → **`FINDINGS.md`** at the root of this repo.
- **DOMECS engine deficiencies** — anything wrong with or missing from `@domecs/*`
  (API, DX, docs, performance, or an engine/renderer bug surfaced here) →
  **`../domecs/doc/FINDINGS_railroad.md`** in the engine repo. One file per app,
  so engine maintainers triage all app-surfaced findings together; the curated
  cross-app synthesis in `../domecs/FINDINGS.md` draws from these.

When in doubt, fix-location decides: if the fix would land in `@domecs/*`, it is
an engine finding.

## Conventions (inherited)

- Red/green TDD — a task is not done until tests pass. Don't skip tests or commit
  code that fails them.
- Pull context from Reqall before a task; upsert Reqall records after.
- `git commit` after changes.
