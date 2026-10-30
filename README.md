<p align="center">
  <strong>English</strong> &nbsp;|&nbsp; <a href="README.zh-CN.md">简体中文</a>
</p>

<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="128" height="128" alt="AudioScript">

<h1>AudioScript</h1>

<p>Listen to your system audio and turn foreign podcasts, videos, and meetings into live bilingual subtitles: source text plus translation. Recognition and translation run entirely on your machine, with 29+ languages supported. On macOS 26+, system translation is also available.</p>

<p>
  <a href="https://zyg0733.github.io/AudioScript/">官网</a> ·
  <a href="https://github.com/zyg0733/AudioScript/releases/latest">下载</a>
</p>

<p>
  <img src="https://img.shields.io/badge/macOS-14.2%2B-111111?style=flat-square&logo=apple&logoColor=white" alt="macOS 14.2+">
  <img src="https://img.shields.io/badge/Windows-10%2B-111111?style=flat-square&logo=windows&logoColor=white" alt="Windows 10+">
  <img src="https://img.shields.io/badge/Ubuntu-24-111111?style=flat-square&logo=ubuntu&logoColor=white" alt="Ubuntu 24">
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-555555?style=flat-square" alt="MIT"></a>
</p>

</div>

本仓库是 [Nico / niyongsheng 的 AudioScript](https://github.com/niyongsheng/AudioScript) 的 fork，由 [zyg0733](https://github.com/zyg0733) 继续维护，保留原项目 MIT 许可和作者署名。当前下载与更新仅来自本仓库。

<br>

https://github.com/user-attachments/assets/b1f88a82-b3fe-4721-8736-af6a9e4d828e

## Features

- **Capture**: system audio / microphone / both mixed.
- **Background**: tray-resident, closing the window does not quit, single instance, launch at login.
- **Recognition**: bundled Zipformer streaming bilingual recognition; optional X-ASR, Nemotron 3.5, and Qwen3-ASR.
- **Translation**: bundled Opus-MT en ↔ zh; optional LMT-60 and NLLB-200.
- **Overlay**: bilingual source and translation; adjustable font size, opacity, line count, and a colorful flowing border.
- **Internationalization**: zh-CN / zh-TW / en / ja / ko / fr / de / es / pt-BR / ru / it / id / ar.

## Privacy

* 语音识别与转译全部在本机完成，离线可用。
* 匿名使用统计默认关闭。仅在构建时配置维护者自己的 Aptabase App Key 后，用户才能在「通用 → 隐私」中主动开启；未配置的构建不加载统计插件。
* 自动更新仅连接本仓库 Releases，并验证本仓库公钥。普通本地构建未配置公钥时禁用更新，可从上方下载入口手动安装。

## Build

```bash
pnpm install          # deps + ASR model and Silero VAD (≈ 59 MB)
pnpm fetch:mt         # fetch models
pnpm tauri dev        # dev mode
pnpm tauri build      # package
```


## 维护与原作者

- 当前 fork 的问题反馈与发布：[zyg0733/AudioScript](https://github.com/zyg0733/AudioScript)。
- fork 构建、签名与上游同步：[维护说明](docs/FORK_MAINTENANCE.md)。
- 后续开发：[阶段迭代计划](docs/IMPLEMENTATION_PLAN.md)。
- 原项目作者 Nico：X [@niyongsheng](https://x.com/niyongsheng)，E‑mail niyongsheng@Outlook.com。
- [赞助原作者 Nico](https://ifdian.net/a/nico2026)：此入口属于原作者。

## License

- [MIT](LICENSE)  

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) Apache-2.0, [X-ASR](https://huggingface.co/GilgameshWind/X-ASR-zh-en) Apache-2.0, [Nemotron 3.5 ASR](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b) OpenMDW-1.1 (optional), [Qwen3-ASR](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) Apache-2.0, [Silero VAD](https://github.com/snakers4/silero-vad) MIT, [CTranslate2](https://github.com/OpenNMT/CTranslate2) MIT, [opus-mt](https://github.com/Helsinki-NLP), [LMT-60](https://huggingface.co/NiuTrans/LMT-60-0.6B) Apache-2.0 (optional), [NLLB-200](https://huggingface.co/facebook/nllb-200-distilled-600M) CC-BY-NC-4.0 (optional), [translation-rs](https://github.com/doom-fish/translation-rs) MIT OR Apache-2.0, [flexaudio](https://crates.io/crates/flexaudio) MIT, [tauri-nspanel](https://github.com/ahkohd/tauri-nspanel) MIT OR Apache-2.0

[![Star History Chart](https://api.star-history.com/svg?repos=niyongsheng/AudioScript&type=Date)](https://star-history.com/#niyongsheng/AudioScript&Date)
