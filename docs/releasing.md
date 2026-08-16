# Releasing npm packages

English | [中文](releasing.zh.md)

How `@deepseek-ai/dsh-*` packages reach consumers. The dsh family — every package under `packages/` plus the `apps/` entries — packs on one shared version from the [`Release (dsh)`](../.github/workflows/release.yml) workflow. The rationale for the release sequences is the [npm-release-sequences Agent Note](../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md).

## The dev loop installs the CLI from a GitHub Release

| Trigger | Pack (build tarballs) | Distribution |
|---|---|---|
| push to `dev-tui` | automatically | attached to a GitHub Release (install the `.tgz` by URL) |
| push to `master` | automatically | none |
| pull request | automatically (pack verification) | none |
| manual dispatch from a `dsh-v*` tag | yes | npm (the complete family) |

The `dev-tui` path never touches npm: its push creates a prerelease tagged `dsh-dev-<commit>` and attaches every tarball. The `dsh` CLI tarball is self-contained for its shipped profiles — the interactive terminal front door lives inside the package itself (`@deepseek-ai/dsh/tui`), and every remaining dependency (`@deepseek-ai/*` service packages, `@earendil-works/pi-tui`) resolves from the npm registry. So one command installs the whole CLI from a release URL:

```sh
npm install -g https://github.com/<owner>/deepseek-harness/releases/download/dsh-dev-<commit>/deepseek-ai-dsh-0.1.0-rc.5.tgz
dsh --profile tui
```

The npm path consumes exactly the bytes the `pack` job produced; `release:publish` decides per package: a version the registry lacks is published, a published tarball with identical integrity is skipped, and a differing tarball at an existing version fails the run. A prerelease version (one containing `-`) publishes under the `next` dist-tag, never `latest`.

## First-time setup (one time)

- The GitHub Release path needs no secret: the workflow's own `contents: write` permission attaches the tarballs. The npm path needs `NPM_TOKEN` under the `npm-publish` environment (Settings → Environments → `npm-publish` → Environment secrets), from an account that can write the `@deepseek-ai` scope.
- If the `npm-publish` environment has required reviewers, a manual npm publish pauses for approval in the Actions run. The `dev-tui` Release attachment does not use that environment.
- A package enters the family as soon as it lives under `packages/`, is not `private`, and its version matches the family's single version. `pnpm run release:verify --family dsh` reports the member count and the version.

## Development loop (build to GitHub, install by URL)

```sh
# edit, commit, push — pack runs and a GitHub Release carries every tarball
git push origin dev-tui
```

Watch `Actions → Release (dsh)` for the run, then open the `dsh-dev-<commit>` release under the repository's Releases page and copy the `deepseek-ai-dsh-<version>.tgz` link. Installing it as above gives a `dsh` binary whose `tui` profile boots the interactive terminal front door.

## Formal release (the whole family to npm)

```sh
pnpm run release:dsh          # bump every member to one new version (committed)
git tag dsh-v<version>        # the tag the manual dispatch publishes from
git push origin dsh-v<version>
```

Then GitHub → Actions → Release (dsh) → Run workflow on the tag → check `publish`. The verify step requires the `dsh-v*` tag on this path; the `npm-publish` environment approves the write.

## Safety posture

The tag gate stays load-bearing for the npm path. `dev-tui` pushes and pull requests never reach the registry; the `dev-tui` push builds and attaches tarballs to a prerelease, and `master` pushes build nothing distributable. Publication never rebuilds: it uploads the artifact the `pack` job verified, so a PR proves the whole publish set still packs before anything can ship.
