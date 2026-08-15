# 发布 npm 包

[English](releasing.md) | 中文

`@deepseek-ai/dsh-*` 包如何到达 npm。dsh 发布族——`packages/` 下每个包加上 `apps/` 下的条目——以同一个共享版本从 [`Release (dsh)`](../.github/workflows/release.yml) 工作流发布。发布序列的理由见 [npm-release-sequences Agent Note](../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)。

## 两条发布路径

| 触发 | 打包（构建 tarball） | 发布到 npm |
|---|---|---|
| 推送 `dev-tui` | 自动 | 仅 registry 缺失的版本 |
| 推送 `master` | 自动 | 否 |
| 拉取请求 | 自动（打包验证） | 否 |
| 从 `dsh-v*` tag 手动触发 | 是 | 整个发布族 |

两条路径都精确使用 `pack` job 产出的字节；`release:publish` 按包决定：registry 缺失的版本发布，已发布且完整性一致的 tarball 跳过，已存在版本上内容不同的 tarball 使运行失败。预发布版本（含 `-`）以 `next` dist-tag 发布，绝不抢占 `latest`。

## 首次设置（一次性）

- 添加发布 token：Settings → Environments → `npm-publish` → Environment secrets → `NPM_TOKEN`（或同名的仓库级 Actions secret；环境级优先）。token 账号需要对 `@deepseek-ai` scope 有读写权限，且必须是 automation 类 token，这样 CI 无需交互式两步验证。
- 如果 `npm-publish` 环境设有必需审批人，则每次发布——包括自动的 `dev-tui` 路径——都会在 Actions 运行中等待审批。这正是有意保留的人工闸门。
- 只要包位于 `packages/` 下、非 `private`，且版本与发布族的单一版本一致，就自动进入发布族。`pnpm run release:verify --family dsh` 会报告成员数和版本。

## 开发循环（发布 registry 缺失的内容）

```sh
# edit, commit, push — pack runs and publishes every registry-missing version
git push origin dev-tui
```

在 `Actions → Release (dsh)` 观察运行。`dev-tui` 推送以发布模式运行发布 verify 门禁（包可发布、版本单一），并通过 `RELEASE_ALLOW_BRANCH_PUBLISH` 绕过 `dsh-v*` tag 校验，然后发布。新包是常见情况：首次 `dev-tui` 推送会在当前家族版本下发布它们；在版本移动之前，后续推送不再发布任何内容。

## 正式发布（整个发布族）

```sh
pnpm run release:dsh          # bump every member to one new version (committed)
git push origin dev-tui       # optional: publish the new version as missing via the dev path
git tag dsh-v<version>        # the tag the manual dispatch publishes from
git push origin dsh-v<version>
```

然后在 GitHub → Actions → Release (dsh) 上，选择该 tag 运行工作流并勾选 `publish`。此路径的 verify 步骤要求 `dsh-v*` tag；`npm-publish` 环境批准写入。

## 两条路径共享同一安全姿态

除显式选择加入的 `dev-tui` 推送（`RELEASE_ALLOW_BRANCH_PUBLISH`，仅由该推送事件设置）外，tag 门禁对每条发布路径都是承重的。`master` 推送和拉取请求永远不会到达 registry。发布从不重新构建：它上传 `pack` job 已验证的产物，因此 PR 在发布任何东西之前就证明整个发布集仍可打包。
