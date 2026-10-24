# AudioScript fork 维护

当前维护仓库为 [zyg0733/AudioScript](https://github.com/zyg0733/AudioScript)，基于 [Nico 的原项目](https://github.com/niyongsheng/AudioScript)。保留 AudioScript 品牌、原作者署名和原 MIT LICENSE。应用中的赞助入口明确属于原作者 Nico。

## 应用身份与链接

应用标识为 `io.github.zyg0733.audioscript`。本 fork 与上游使用独立配置、模型和日志目录；旧安装的数据不自动迁移，也不会被删除。需要迁移时先备份原目录，再核对偏好格式与模型完整性。不要直接更改回上游标识来共用数据。

根目录 `project.json` 是仓库、网站、更新和原作者链接的来源，后端 `app_info` 将其提供给界面，系统浏览器只允许打开已知项目与模型许可链接。修改维护仓库时，同步核对 `tauri.conf.json`、模型 catalog 和静态网站；项目单测检查更新配置一致性。

官网与下载入口只指向本 fork。GitHub Pages 是否可用取决于仓库 Settings → Pages 中是否已选择 GitHub Actions；首次 fork 发布前下载页可能尚无安装包。

## 自动更新与发布

首个自有版本为 `0.2.11`。没有自有签名密钥时，先手动触发 **Build & Release**，选择 `installers-only`。该模式清空构建公钥、关闭更新工件，不创建公开 Release；三个平台均解包校验架构、版本、模型文件 SHA-256，并从包内资源执行官方语音样本识别与双向翻译。每个平台输出校验报告与安装包 SHA-256 清单，验证通过才上传工件。

手动安装包发布应直接使用上述验证通过的同一次运行工件，先创建 draft Release 并上传五种安装包、汇总校验和及验证报告，确认标签指向构建提交、文件名与官网映射一致后再公开为 latest。不要重新编译后替换已验证的工件，也不要发布空的 `latest.json`。此流程只提供手动下载安装；不会宣称自动更新已可用。

本 fork 不信任原项目公钥，也不向原项目请求更新。普通本地构建默认不生成更新工件；未设置 `TAURI_UPDATER_PUBLIC_KEY` 时不注册更新插件，设置页显示原因，后端拒绝安装更新。公钥必须在构建时提供，只改运行时环境不会启用已构建的应用。

发布前在本仓库 Settings → Secrets and variables → Actions 配置：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Variable | `TAURI_UPDATER_PUBLIC_KEY` | 维护者为本 fork 管理的 Tauri 公钥文件完整内容；该文件内容本身是 base64 字符串 |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | 与公钥配对的本 fork 私钥，按 Tauri 官方方式保存 |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码；无密码的密钥可为空 |
| Variable，可选 | `AUDIOSCRIPT_APTABASE_APP_KEY` | 维护者自己的 Aptabase App Key |

不要把私钥写入源码、日志、生成的配置、issue 或聊天。密钥由维护者保管；本工作流不生成密钥，也不打印密钥。更新签名与 macOS/Windows 安装包的平台代码签名是两件事，发布前仍需对应平台验收。

`scripts/configure-release.mjs` 只把公钥和本项目 endpoint 写入被忽略的 `.cache/tauri-release.conf.json`。`v*` tag 发布缺公钥或签名 Secret 会在构建前失败；手动 workflow 缺配置可验证普通安装包，但不生成或上传更新工件。配置公钥但未配置私钥的手动构建可检查既有签名版本，仍不生成更新包。配置错误的公钥格式会直接失败。签名是否配对由构建签名和实际更新验收确认。

配置自有密钥后，手动选择 `signed-updater` 验证签名工件；`v*` tag 推送仍强制要求自有密钥，不能用 `installers-only` 绕过。此签名发布路径汇总各平台签名到 `latest.json`，仅上传到本仓库 Releases。发布后用上一版本安装包验证：检查更新、签名校验、安装、重启和配置保留；没有通过这条流程前不要宣布自动更新可用。

首个带更新公钥的版本为 `0.2.12`。已公开的 `0.2.11` 在编译时关闭了更新插件，补上传 `latest.json` 或修改仓库变量都不能改变已安装程序；用户必须手动安装首个带公钥的新版，此后才可使用其更新功能。不得覆盖 `v0.2.11` 的既有安装包，或重新运行该标签旧版工作流来补签名。

密钥由维护者生成和备份，代理遵守 `CLAUDE.md` 对私钥的约束；不能把私钥或密码粘贴到聊天。维护者可以在自己的终端按官方 CLI 交互生成密码保护的密钥，再将文件直接通过标准输入提交到本仓库：

```bash
pnpm tauri signer generate -w "$HOME/.tauri/AudioScript/updater.key"
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo zyg0733/AudioScript < "$HOME/.tauri/AudioScript/updater.key"
gh variable set TAURI_UPDATER_PUBLIC_KEY --repo zyg0733/AudioScript < "$HOME/.tauri/AudioScript/updater.key.pub"
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo zyg0733/AudioScript
```

最后一个命令交互输入所设置的密钥密码。私钥文件及密码必须另行安全备份，不进入源码、日志或发布附件。已经存在自有公钥或私钥时，应使用原配对密钥；不得自动轮换已受客户端信任的更新公钥。

签名 CI 会先签随机挑战文件并通过独立 `minisign` 验证公私钥及密码，再构建安装包。每个平台对实际更新包验证完整签名和签名内的版本，并要求篡改包、错误公钥、错误清单版本三个反例全部被拒绝。`requireSignedVersion` 在客户端强制签名版本与清单版本一致。所有原有解包、模型文件、真实 ASR/翻译和启动预算检查继续执行。

`signed-updater` 手动运行也会汇总八个平台别名，完整验签五个唯一更新包，核对安装器和报告，产出 `verified-release` 工件，但不公开发布。标签发布则从这一已验证工件创建草稿，逐个比对 GitHub 上传摘要，再公开；同名公开版本或草稿均拒绝覆盖。标签、package、Cargo 两处、Tauri 配置及官网版本必须一致。

本地需要验证签名构建时，在受控环境中设置上述环境变量，运行 `node scripts/configure-release.mjs --require-updater`，然后运行 `pnpm tauri build --config .cache/tauri-release.conf.json`。不要通过命令行参数传私钥。

官方参考：[Tauri 更新与签名说明](https://v2.tauri.app/plugin/updater/)、[更新插件公钥配置](https://docs.rs/tauri-plugin-updater/2.14.0/tauri_plugin_updater/struct.Builder.html#method.pubkey)。

## 匿名统计

默认偏好为关闭。只有构建时提供维护者自己的 `AUDIOSCRIPT_APTABASE_APP_KEY` 才注册插件，用户仍需主动开启。无 App Key 时主窗口显示不可开启，后端也拒绝启用请求；已有偏好中的开启状态不会绕过该限制。禁止沿用原项目 App Key。

统计只包含事件名、枚举与时长分档，不含音频、转写内容、设备名称或路径。关闭后停止入队新事件。无统计配置的构建不加载插件，识别和翻译可离线工作。

## 模型与上游同步

通用 ASR 模型仍从 k2-fsa/sherpa-onnx 获取，翻译模型仍来自 Helsinki-NLP。模型来源与软件更新来源分别维护。`mt-big` 的未来资源地址属于本 fork，但仍标记 `downloadable: false`；构建模型、填好 SHA256/体积、确认双方向目录安装与加载后才能开放，不得只修改开关。

上游同步使用独立分支和 pull request：先审查上游差异，再选取修复，运行类型检查、静态检查、Rust 单测与相关平台验证。合并时重点检查本 fork 的应用标识、发布 endpoint、公钥、统计默认值、作者说明和模型目录，避免重新引入上游运行配置。

## 回归检查

首次仅安装前端检查依赖可运行 `pnpm install --frozen-lockfile --ignore-scripts`，无需下载识别和翻译模型。常规检查：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:scripts
pnpm verify:project
pnpm verify:models
pnpm build:frontend
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
cargo test --locked --manifest-path src-tauri/Cargo.toml --example updater_verify
node scripts/verify-release-version.mjs
```

Rust 测试仍需下载锁定的 crates 和原生推理库，但回归测试不依赖真实麦克风、系统权限或模型权重。生成类型必须使用 typeshare-cli 1.13.4：运行 `pnpm gen:types` 后检查 `src/shared/types.ts` 的差异，禁止手工维护该文件。

`.github/workflows/check.yml` 在 PR 和 main 分支更新时运行上述检查，并验证两个 HTML 入口及生成类型。提交前完成相关回归；真实音频设备断开、权限撤销、完整模型加载和签名更新安装仍需在打包应用中验收。GitHub 上的检查只有提交工作流后才会运行。
