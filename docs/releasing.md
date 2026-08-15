# Releasing npm packages

English | [中文](releasing.zh.md)

How `@deepseek-ai/dsh-*` packages reach npm. The dsh family — every package under `packages/` plus the `apps/` entries — publishes on one shared version from the [`Release (dsh)`](../.github/workflows/release.yml) workflow. The rationale for the release sequences is the [npm-release-sequences Agent Note](../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md).

## Two publish paths

| Trigger | Pack (build tarballs) | Publish to npm |
|---|---|---|
| push to `dev-tui` | automatically | registry-missing versions only |
| push to `master` | automatically | no |
| pull request | automatically (pack verification) | no |
| manual dispatch from a `dsh-v*` tag | yes | the complete family |

Both paths consume exactly the bytes the `pack` job produced; `release:publish` decides per package: a version the registry lacks is published, a published tarball with identical integrity is skipped, and a differing tarball at an existing version fails the run. A prerelease version (one containing `-`) publishes under the `next` dist-tag, never `latest`.

## First-time setup (one time)

- Add the publish token: Settings → Environments → `npm-publish` → Environment secrets → `NPM_TOKEN` (or the repository-level Actions secret of the same name; the environment one wins). The token account needs read-write access to the `@deepseek-ai` scope and must be an automation-class token so CI needs no interactive two-factor step.
- If the `npm-publish` environment has required reviewers, every publish — including the automatic `dev-tui` path — pauses for approval in the Actions run. That is the deliberate human gate.
- A package enters the family as soon as it lives under `packages/`, is not `private`, and its version matches the family's single version. `pnpm run release:verify --family dsh` reports the member count and the version.

## Development loop (publish what the registry lacks)

```sh
# edit, commit, push — pack runs and publishes every registry-missing version
git push origin dev-tui
```

Watch `Actions → Release (dsh)` for the run. The `dev-tui` push runs the publishing verify gates (publishable packages, single version) with the `dsh-v*` tag check bypassed through `RELEASE_ALLOW_BRANCH_PUBLISH`, then publishes. New packages are the common case: the first `dev-tui` push publishes them at the current family version; later pushes publish nothing until the version moves.

## Formal release (the whole family)

```sh
pnpm run release:dsh          # bump every member to one new version (committed)
git push origin dev-tui       # optional: publish the new version as missing via the dev path
git tag dsh-v<version>        # the tag the manual dispatch publishes from
git push origin dsh-v<version>
```

Then GitHub → Actions → Release (dsh) → Run workflow on the tag → check `publish`. The verify step requires the `dsh-v*` tag on this path; the `npm-publish` environment approves the write.

## The two paths share one safety posture

The tag gate stays load-bearing for every publish path except the explicitly opted-in `dev-tui` push (`RELEASE_ALLOW_BRANCH_PUBLISH`, set only by that push event). `master` pushes and pull requests never reach the registry. Publication never rebuilds: it uploads the artifact the `pack` job verified, so a PR proves the whole publish set still packs before anything can ship.
