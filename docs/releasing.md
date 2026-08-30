# Releasing

Versions are never bumped by hand. Every release is cut from changesets — short notes written
by the person who made the change, saying which packages moved and what a consumer should know.
The changelog is therefore written while the change is fresh, rather than reconstructed from
commit subjects months later.

## While you work

A change that alters what a package does carries a changeset:

```bash
pnpm changeset
```

Pick the packages, pick `patch` / `minor` / `major`, write the note for **a consumer**, not for
a reviewer: what changed for someone using the package, and what they have to do about it. The
file lands in `.changeset/` and is reviewed with the code.

Docs-only, CI, and internal-refactor changes need no changeset. `@side-street/web` is the app,
not a package — it is ignored by the release tooling.

## Cutting a release

```bash
git switch -c release/vX.Y.Z
pnpm changeset:version   # applies every pending changeset: versions + CHANGELOGs
pnpm install --frozen-lockfile
pnpm build && pnpm test
```

Review the generated `CHANGELOG.md` files as you would any other public-facing text, then open
the PR. Squash-merge it as usual — the version bump is a normal, reviewed change.

Then, from `main`:

```bash
git tag -s vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
pnpm release                       # build, then publish to npm
gh release create vX.Y.Z --notes-from-tag
```

`pnpm release` publishes exactly the packages whose versions moved.

## Why this is manual

Publishing needs an npm token, and signed tags need a signing key. A workflow holding both is
worth setting up when releases are frequent enough that the ceremony costs more than the
credentials do; for now a documented sequence someone runs deliberately beats CI configuration
nobody has executed. When it changes, `changesets/action` opens the version PR and publishes on
merge — the notes above are already in the shape it expects.

## Versioning

[Semver](https://semver.org), with the pre-1.0 caveat that a **minor** may change the wire
protocol or a package API. `docs/protocol.md` is the versioned source of truth for the wire
format; breaking protocol changes need an RFC issue before implementation, per PLAN.md §6.
