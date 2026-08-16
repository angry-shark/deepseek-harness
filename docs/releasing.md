# Releasing npm packages

English | [中文](releasing.zh.md)

How `@deepseek-ai/dsh-*` packages reach npm. The dsh family — every package under `packages/` plus the `apps/` entries — publishes on one shared version from the [`Release (dsh)`](../.github/workflows/release.yml) workflow. The rationale for the release sequences is the [npm-release-sequences Agent Note](../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md).

## Two publish paths

| Trigger | Pack (build tarballs) | Distribution |
|---|---|---|
| push to `dev-tui` | automatically | attached to a GitHub Release (install the `.tgz` by URL) |
| push to `master` | automatically | none |
| pull request | automatically (pack verification) | none |
| manual dispatch from a `dsh-v*` tag | yes | npm (the complete family) |

The `dev-tui` path never touches npm: its push creates a prerelease tagged `dsh-dev-<commit>`, attaches every tarball, and you install a package by its release URL — `npm install https://github.com/<owner>/deepseek-harness/releases/download/dsh-dev-<commit>/deepseek-ai-dsh-tui-0.1.0-rc.5.tgz`. The tarball declares its own package name, so the URL install works without any registry scope access. The npm path consumes exactly the bytes the `pack` job produced; `release:publish` decides per package: a version the registry lacks is published, a published tarball with identical integrity is skipped, and a differing tarball at an existing version fails the run. A prerelease version (one containing `-`) publishes under the `next` dist-tag, never `latest`.

## First-time setup (one time)

- For the npm path: add the publish token — Settings → Environments → `npm-publish` → Environment secrets → `NPM_TOKEN` (or the repository-level Actions secret of the same name; the environment one wins). The token account needs read-write access to the `@deepseek-ai` scope and must be an automation-class token so CI needs no interactive two-factor step. The GitHub Release path needs no token: the workflow's own `contents: write` permission attaches the tarballs.
- If the `npm-publish` environment has required reviewers, a manual npm publish pauses for approval in the Actions run. The `dev-tui` Release attachment does not use that environment.
- A package enters the family as soon as it lives under `packages/`, is not `private`, and its version matches the family's single version. `pnpm run release:verify --family dsh` reports the member count and the version.

## Development loop (build to GitHub, install by URL)

```sh
# edit, commit, push — pack runs and a GitHub Release carries every tarball
git push origin dev-tui
```

Watch `Actions → Release (dsh)` for the run, then open the `dsh-dev-<commit>` release under the repository's Releases page and copy a package's `.tgz` link. The two packages this change ships are `@deepseek-ai/dsh-tui` and `@deepseek-ai/dsh-tui-app`; their tarballs are `deepseek-ai-dsh-tui-<version>.tgz` and `deepseek-ai-dsh-tui-app-<version>.tgz`.

## Formal release (the whole family)

```sh
pnpm run release:dsh          # bump every member to one new version (committed)
git push origin dev-tui       # optional: publish the new version as missing via the dev path
git tag dsh-v<version>        # the tag the manual dispatch publishes from
git push origin dsh-v<version>
```

Then GitHub → Actions → Release (dsh) → Run workflow on the tag → check `publish`. The verify step requires the `dsh-v*` tag on this path; the `npm-publish` environment approves the write.

## The two paths share one safety posture

The tag gate stays load-bearing for the npm path only. `dev-tui` pushes and pull requests never reach the registry; the `dev-tui` push builds and attaches tarballs to a prerelease, and `master` pushes build nothing distributable. Publication never rebuilds: it uploads the artifact the `pack` job verified, so a PR proves the whole publish set still packs before anything can ship.
