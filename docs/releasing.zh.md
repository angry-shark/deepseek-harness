# 发布 npm 包

[English](releasing.md) | 中文

`@deepseek-ai/dsh-*` 包如何到达用户。dsh 发布族——`packages/` 下每个包加上 `apps/` 下的条目——以同一个共享版本从 [`Release (dsh)`](../.github/workflows/release.yml) 工作流打包。发布序列的理由见 [npm-release-sequences Agent Note](../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)。

## 开发循环从 GitHub Release 安装 CLI

| 触发 | 打包（构建 tarball） | 分发 |
|---|---|---|
| 推送 `dev-tui` | 自动 | 挂到 GitHub Release（用 URL 安装 `.tgz`） |
| 推送 `master` | 自动 | 无 |
| 拉取请求 | 自动（打包验证） | 无 |
| 从 `dsh-v*` tag 手动触发 | 是 | npm（整个发布族） |

`dev-tui` 路径绝不接触 npm：其推送创建标签为 `dsh-dev-<commit>` 的预发布，附上每个 tarball。`dsh` CLI 的 tarball 对其随附的 profile 是自包含的——交互式终端前端门面就住在包本身（`@deepseek-ai/dsh/tui`），其余每个依赖（`@deepseek-ai/*` 服务包、`@earendil-works/pi-tui`）都能从 npm registry 解析。因此一条命令即可从 Release URL 安装整个 CLI：

```sh
npm install -g https://github.com/<owner>/deepseek-harness/releases/download/dsh-dev-<commit>/deepseek-ai-dsh-0.1.0-rc.5.tgz
dsh --profile tui
```

npm 路径精确使用 `pack` job 产出的字节；`release:publish` 按包决定：registry 缺失的版本发布，已发布且完整性一致的 tarball 跳过，已存在版本上内容不同的 tarball 使运行失败。预发布版本（含 `-`）以 `next` dist-tag 发布，绝不抢占 `latest`。

## 首次设置（一次性）

- GitHub Release 路径不需要 secret：工作流自身的 `contents: write` 权限即可附加 tarball。npm 路径需要 `npm-publish` 环境（Settings → Environments → `npm-publish` → Environment secrets）下的 `NPM_TOKEN`，来自能写 `@deepseek-ai` scope 的账号。
- 如果 `npm-publish` 环境设有必需审批人，手动 npm 发布会在 Actions 运行中等待审批。`dev-tui` 的 Release 附件不使用该环境。
- 只要包位于 `packages/` 下、非 `private`，且版本与发布族的单一版本一致，就自动进入发布族。`pnpm run release:verify --family dsh` 会报告成员数和版本。

## 开发循环（构建到 GitHub，按 URL 安装）

```sh
# edit, commit, push — pack runs and a GitHub Release carries every tarball
git push origin dev-tui
```

在 `Actions → Release (dsh)` 观察运行，然后在仓库的 Releases 页面打开 `dsh-dev-<commit>` 预发布，复制 `deepseek-ai-dsh-<version>.tgz` 链接。按上面方式安装后得到一个 `dsh` 二进制，其 `tui` profile 会启动交互式终端前端门面。

## 正式发布（整个发布族到 npm）

```sh
pnpm run release:dsh          # bump every member to one new version (committed)
git tag dsh-v<version>        # the tag the manual dispatch publishes from
git push origin dsh-v<version>
```

然后在 GitHub → Actions → Release (dsh) 上，选择该 tag 运行工作流并勾选 `publish`。此路径的 verify 步骤要求 `dsh-v*` tag；`npm-publish` 环境批准写入。

## 安全姿态

tag 门禁仅对 npm 路径承重。`dev-tui` 推送和拉取请求永远不会到达 registry；`dev-tui` 推送构建并附加 tarball 到预发布，`master` 推送不构建任何可分发的产物。发布从不重新构建：它上传 `pack` job 已验证的产物，因此 PR 在发布任何东西之前就证明整个发布集仍可打包。
