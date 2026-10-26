# 模型耗时基线

`scripts/benchmark-models.mjs` 重复运行现有 `model_smoke`，把计时行汇总为 JSON。它是**模型冒烟计时**，不是麦克风或系统音频端到端测试，不衡量首字延迟、实时流式体验、识别准确率或翻译质量。

## 运行

先准备当前代码构建的 `model_smoke`、已解包的模型目录和 16 kHz 单声道 PCM16 WAV。脚本不构建程序、不下载或替换模型、不下载样本；缺失或不完整的输入会明确失败。样本上限与冒烟程序一致，为 32 MiB。

```sh
cargo build --locked --manifest-path src-tauri/Cargo.toml --example model_smoke
node scripts/benchmark-models.mjs \
  --executable src-tauri/target/debug/examples/model_smoke \
  --models-root /absolute/path/to/models \
  --wav .cache/release-smoke/2.wav \
  --runs 3 > .cache/model-benchmark.json
```

Windows 需要把可执行文件路径改为 `model_smoke.exe`。使用已有 release 构建时可指向 `src-tauri/target/release/examples/model_smoke`；比较结果应使用相同构建模式。`--runs` 可设置为 1–100，默认 3。每轮默认 120 秒超时，可通过 `--timeout-ms` 设置 1–3600000 毫秒；超时先发送 SIGTERM，1 秒后仍未退出则发送 SIGKILL，结束时清理定时器。已有公开样本 `.cache/release-smoke/2.wav` 的来源和固定指纹见 `scripts/fetch-smoke-fixture.mjs`，基线脚本只读取已有文件。

标准输出只包含最终 JSON，适合重定向保存。运行失败时标准错误说明失败轮次或缺失输入，并以非零状态退出，不发布部分运行的统计结果。子进程的完整日志、音频和转写/翻译正文均不输出，也不写入报告；路径会记录在报告中。

## 报告含义

- `environment`：平台、架构、操作系统版本、CPU 和内存元信息。
- `executable`：实际使用的二进制路径、大小、修改时间，便于区分构建。
- `sample`：样本路径、大小、修改时间和内容 SHA-256。
- `models`：模型根目录、catalog SHA-256，以及当前冒烟程序使用的 builtin ASR 和 base 双向 MT 所需文件的路径、大小、修改时间。未读取或哈希权重全文；这些元信息不能证明模型内容完全相同。
- `runs`：每轮的 ASR 初始化/关闭/总耗时，双向 NMT 初始化（含预热）/单句推理/关闭/总耗时，冒烟总耗时与外部进程墙钟耗时，单位均为毫秒。
- `summary`：每个指标的 p50、p95；使用 nearest-rank（排序后第 `ceil(p × N)` 项）。默认 3 次时 p95 就是最大值，不能据此宣称稳定的总体尾延迟。

每轮启动独立进程，初始化每轮都会执行，但脚本不会清理操作系统文件缓存，不能称为严格的冷启动测试。ASR 会尽快投喂整个 WAV，NMT 每个方向仅推理冒烟程序内置的一句。模型计时包含其所在冒烟步骤的校验和日志开销；外部 `processWallMs` 还包含进程启动等开销，不含本脚本的预检与报告生成。

比较前后版本时固定硬件、电源模式、构建模式、样本 SHA-256、模型内容及其他系统负载，并保留完整 JSON。小样本差异只用于发现回归线索；确认变化后再增加运行次数，不把单次结果当作发布质量结论。

## 2026-10-26 首次本机记录

代码基线为 `df9b33c` 上的体验批次 A 工作区，使用当前源码构建的 debug `model_smoke`，macOS arm64、Apple M5 Pro、64 GiB 内存，连续独立进程运行 3 次。完整本地报告保存在被忽略的 `.cache/experience-baseline/model-smoke.json`。

样本 SHA-256：`20805bcc696b9b65f3357a2508a419d4f33b81006d47e1312e219b0fad934d1d`；模型 catalog SHA-256：`cacc1ca9c791f08c57d53679bdf222bbe53b453253e879f3532e5d3dfd8a2614`。

| 指标 | p50（ms） | p95（ms） |
| --- | --- | --- |
| ASR 初始化 | 282 | 290 |
| 英→中 NMT 初始化，含预热 | 358 | 376 |
| 英→中固定单句推理 | 40 | 42 |
| 中→英 NMT 初始化，含预热 | 374 | 387 |
| 中→英固定单句推理 | 72 | 76 |
| 整个模型冒烟流程 | 1286 | 1347 |
| 外部进程墙钟耗时 | 1369.318 | 2893.013 |

这份记录用于后续同条件比较，没有前后版本对照，不能证明体验已经提速。3 次样本的 p95 是最大值；进程墙钟耗时还受系统调度、进程启动和文件缓存影响。真实语音到字幕显示、断句等待与质量评测尚需另行建立。

## 脚本回归

```sh
node --test scripts/benchmark-models.test.mjs
```

测试使用合成文件和注入的冒烟日志，不下载或加载真实模型；另有真实子进程测试参数传递与失败日志隔离。
