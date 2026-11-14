# NOTICE

Mineradio 使用了以下第三方项目或服务。各项目版权归其原作者所有。

> **Copyleft 提示 / Copyleft notice**
>
> Mineradio 整体按 **GPL-3.0** 分发，但其中两个歌词样式模块源自 **AGPL-3.0** 项目
> [Folia](https://github.com/chthollyphile/folia-major)，这两个文件按 AGPL-3.0 提供，
> 依 **GPL-3.0 第 13 条**与其余部分组合。AGPL-3.0 全文见
> [`docs/licenses/AGPL-3.0.txt`](docs/licenses/AGPL-3.0.txt)，移植细节见
> [`docs/THIRD_PARTY_PORTS.md`](docs/THIRD_PARTY_PORTS.md)。
>
> Mineradio is distributed under **GPL-3.0**, except that two lyric-style modules
> derived from the **AGPL-3.0** project Folia are offered under AGPL-3.0 and are
> combined with the rest under GPL-3.0 section 13. Full AGPL-3.0 text:
> [`docs/licenses/AGPL-3.0.txt`](docs/licenses/AGPL-3.0.txt).

## Third-party Libraries

- Electron
- Three.js
- GSAP
- music-tempo
- NeteaseCloudMusicApi
- mpg123-decoder
- jieba dictionary (jieba, MIT): the Chinese word-segmentation dictionary under `public/vendor/jieba-dict.txt` is derived from the jieba project and trimmed to word/frequency pairs (POS tags removed).

## Community Contributions

- Cuefield AutoMix planner/runtime: adapted for experimental local testing from [SLYysl/cuefield-mineradio](https://github.com/SLYysl/cuefield-mineradio) at revision `c16f05a0bc731a49da7d42c135337fcac58f6dba` (GPL-3.0). The optional remote-feedback component from that repository is not included; Mineradio stores Cuefield ratings locally in the current user's data directory.
- Wallpaper Engine local-library detection and import UX: independently adapted from the approach used by [ww085213/Mineradio-LX-Music](https://github.com/ww085213/Mineradio-LX-Music) at commit `a5ef80a219709080700be5b1d00f1ea71a5a2576` (GPL-3.0). Mineradio only indexes local `project.json` metadata; it does not execute imported Web/Application projects or replace the user's existing background-media settings.
- Full-desktop main-window mode and home-dashboard information hierarchy: initially adapted from [ww085213/Mineradio-LX-Music](https://github.com/ww085213/Mineradio-LX-Music) at commit `82826df814c32853d99697c0ee60f749a2fcad79`, with the homepage refreshed against `812e2dc2e18bbc263e61dbd0206cb765e003d6e9` (GPL-3.0). Mineradio keeps its own provider, queue, playlist, listening-history, WorkerW validation, DPI, lifecycle, and cleanup implementations; see `docs/THIRD_PARTY_PORTS.md` in the corresponding source distribution.
- Qishui Passport Web QR authentication bridge: focused port from [Wx2yZx/Mineradio-Qishui-QR-Login](https://github.com/Wx2yZx/Mineradio-Qishui-QR-Login) at commit `aaadaab7d011714f94fbe45b382ba8dcc7cf17b9` (declared `GPL-3.0-only`). Only the official QR create/poll, security-signing host, session persistence, and second-verification path are integrated; Mineradio keeps its own catalogue, playlist, entitlement, and playback adapters. The bundled ByteDance/Qishui web security runtime resources remain the property of their respective rights holders and are used only to interoperate with the user's own official account session.

- Folia lyric-stage styles (「流光」 / 「商籁」): reimplemented for Mineradio's DOM + Canvas2D renderer from [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major) (reference snapshot `main` @ package.json `0.7.27`, upstream head `77d52a3168ab2608174d2e5ad6d51b7bc8befd11`), which is licensed **AGPL-3.0**. The visual language, the camera model (pivot tracking the sung word segment, pure `f(now)` sampling instead of springs) and the timing constants follow upstream. No upstream source file, shader, font or binary asset is copied, PixiJS/WebGL is not used, and the AGPL source tree is not redistributed here. The two derived files are `public/js/modules/02-visual/16-folia-classic-lyrics.js` and `public/js/modules/02-visual/18-folia-sonnet-lyrics.js`; they are offered under AGPL-3.0, and GPL-3.0 section 13 permits combining them with the rest of Mineradio.

## Third-party Services

Mineradio 可能与网易云音乐、QQ 音乐等第三方音乐服务进行用户自有账号相关的本地客户端交互。

Mineradio 不是任何音乐平台的官方客户端，也不隶属于网易云音乐、QQ 音乐或腾讯音乐娱乐集团。请用户自行遵守对应平台的服务协议、版权规则和会员权益规则。

## Original Design

Mineradio 名称、MR Logo、界面视觉设计、启动动画方向、粒子视觉体验和电影镜头系统的产品表达属于作者原创设计。

emily 作为 Mineradio 早期视觉底层想法与 `emily` 视觉预设改进方向的共创者和灵感来源之一，特此致谢。

感谢小天才e宝、应春日、锋将军、軌跡、林中、骊、风痕、花椰菜🥦在早期体验、测试反馈和发布准备中的帮助。
