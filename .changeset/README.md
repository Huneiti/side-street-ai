# Changesets

Every change that alters what a package does carries a changeset — a short note saying which
packages changed, how much (`patch` / `minor` / `major`), and what a consumer should know. Run:

```bash
pnpm changeset
```

Releases are cut from these notes, so the changelog is written by the people who made the
changes rather than reconstructed from commit subjects afterwards. Versions are never bumped by
hand; see [`docs/releasing.md`](../docs/releasing.md).

Docs-only, CI, and internal-refactor changes need no changeset.
