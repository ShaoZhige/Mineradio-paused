# Third-party ports

## Cuefield AutoMix transition planner/runtime

- Upstream: `SLYysl/cuefield-mineradio`
- Reference revision: `c16f05a0bc731a49da7d42c135337fcac58f6dba`
- License: GNU GPL v3 (`GPL-3.0`)
- Port refresh date: 2026-08-01

Mineradio integrates the upstream cache-only transition planner, structure and
boundary evidence, recipe routing, preparation de-duplication, bounded bridge
and source-loop helpers, and advanced B-deck timeline actions. The runtime is
adapted to Mineradio's modular script loader, provider-aware beat-map cache,
existing AudioContext ownership transfer, finite source fallback, and the
already approved album-gapless crossmix path.

AutoMix remains opt-in and stops while disabled, paused, manually seeking, or
when album-gapless owns the next deck. Unsupported WebAudio actions degrade to
the volume-only/equal-power path instead of blocking normal queue advance. The
upstream optional remote-feedback service, monolithic Mineradio UI, private
audio URLs, account credentials, and raw local beat-map data are not included
or transmitted; ratings remain in the current user's local data directory.

## Mineradio-LX-Music desktop/home reference

- Upstream: `ww085213/Mineradio-LX-Music`
- Initial reference revision: `82826df814c32853d99697c0ee60f749a2fcad79`
- Homepage refresh revision: `812e2dc2e18bbc263e61dbd0206cb765e003d6e9`
- License: GNU GPL v3 (`GPL-3.0-only`)
- Port dates: 2026-07-18 (initial), 2026-07-19 (homepage refresh)

Mineradio's full desktop mode adapts the upstream idea of moving the existing
Electron main-window HWND between the Windows WorkerW desktop layer and an
interactive top-level window. The native attach/detach code in this project was
rewritten around the optimized edition's fail-closed WorkerW discovery, DPI
conversion, structured acknowledgements, serialized lifecycle, and cleanup
requirements.

The home dashboard adapts the upstream information hierarchy (continue,
library, daily recommendations, recent playback, today's listening, next up,
discovery, and radio entry points). Its data adapters use this project's current
multi-provider discovery, playlist, search, playback queue, and listen-history
state. Upstream LX-only server routes and the legacy standalone wallpaper
overlay were not copied.

The 2026-07-19 refresh additionally adapts the three-song "For You" strip,
stable cover-image swaps, in-place quick-card updates, daily-review hover
feedback, and compact-height scrolling/settings behavior. These features remain
implemented against Mineradio's existing provider, weather-radio, local-library,
queue, and playback modules rather than the upstream LX/local-only data model.

The combined application remains distributed under the repository's GNU GPL v3
license. Preserve this notice and the corresponding source when redistributing
modified builds.

## Qishui Passport Web QR authentication

- Upstream: `Wx2yZx/Mineradio-Qishui-QR-Login`
- Reference revision: `aaadaab7d011714f94fbe45b382ba8dcc7cf17b9`
- Declared license: `GPL-3.0-only`
- Port date: 2026-07-30

Mineradio ports only the official Passport Web QR authentication boundary:
an isolated hidden Electron security host, the Qishui web signing bootstrap,
QR creation and polling, account-session cookie persistence, and the official
second-verification UI when the service requests it. The upstream whole-project
installer was not run, and no application files were wholesale replaced.

The QR bridge feeds the authenticated cookie into Mineradio's existing
`server/qishui-api.js` provider. Search, playlists, likes, comments, entitlement checks,
and audio playback remain Mineradio implementations. Legacy token/manual-cookie
login controls and local SodaMusic cookie discovery are not exposed by the
current login UI.

The web security runtime resources under `server/qishui-auth-v6/` are retained
byte-for-byte for protocol compatibility and remain the property of their
respective rights holders. They are loaded only inside the isolated authentication
partition for the user's own official login session.

## LX Music custom source host (upstream PR #129)

- Upstream: `XxHuberrr/Mineradio-paused` PR #129, `lidonghaofirst:feat/lx-custom-source`
- Reference revision: `981768627aec574d5794a056587db71f26983318`
- Base revision: `6b130103f759e5dcd1e133700071c8216b8fa5a6`
- License: GNU GPL v3 (`GPL-3.0-only`)
- Port date: 2026-10-03

Mineradio implements the public LX Music Desktop 2.0.0 custom-source host so existing
`.js` source scripts run unmodified inside a dedicated, sandboxed Electron renderer.
The port keeps the upstream `CustomSourceStore` / `LxSourceRuntime` / `CustomSourceManager`
decomposition, the metadata limits, the quality-intersection rules, the request/response
validation, the `updateAlert` single-shot rule, and the redaction rules.

Adaptations to this project:

- `music-info.js` maps only `netease` and `qq`, because this project has five providers
  while the public LX contract only exposes `wy` and `tx` search sources.
- Resolution results carry `handled`, and `customSourcePolicy` respects it: platforms a
  script does not declare are handed back to the built-in resolver instead of failing.
  Upstream treated "script does not cover this platform" as ownership, which would have
  made Kugou, Qishui and Spotify tracks unplayable whenever a script was active.
- The host, the `/api/custom-source/resolve` route, the preload bridge and the renderer
  module were rewired against this project's modular `public/js/modules/**` loader and
  its existing provider fallback, album-gapless and quality-cap machinery.
- The custom-source result is excluded from the platform runtime quality cap and from the
  platform downgrade notice, and the QQ compatibility-quality retry no longer runs while a
  script owns the track.
- UI copy goes through this project's i18n dictionaries (zh_cn / en_us / ja_jp / ru_ru) instead of
  hardcoded strings, and failure codes stay machine-readable on the backend.
- The upstream change that quit the application on main-window close was not taken: this
  project already implements tray-resident close behavior through its own `closeBehavior`
  and `window-all-closed` paths.

No third-party source script ships with this project. Imported scripts live under the
user's Electron `userData` directory and are excluded from Git and the installer.

## Highway Drive and Niu Lai Dream visual presets

- Upstream: `XxHuberrr/Mineradio-paused` pull request #434, author `CyberFork` / Cyberforker
- Merged-in revision: not merged upstream; taken from the PR head as-is
- License: GNU GPL v3 (`GPL-3.0`), same as the project this repository forks
- Planetary textures: Solar System Scope / INOVE, CC BY 4.0, resampled to 1024 px;
  attribution ships as `public/assets/highway-planets/LICENSE.txt`
- Port date: 2026-10-27

Both presets are self-contained IIFE modules living at `public/` root next to the existing
`sonic-*-preset.js` files, registered through `index-loader.js`, and driven from the main
render loop. They draw their own bounded Three.js scenery instead of extending the shader
preset series, so they do not take part in the `9..12` authored-particle branches.

Only the visual half of PR #434 was taken. That PR also threads a third-party music API
provider through the login, search, playback, quality and backend layers; none of it is
included here.

Preset indices follow this repository's own numbering, which already reaches 12: the
upstream PR assumed the series stopped at 8 and used 9 and 10, which would have silently
reinterpreted existing saved presets. Highway Drive is 13 and Niu Lai Dream is 14.

## Edifier Halo PixelBar lyric and lighting sync

- Upstream: `XxHuberrr/Mineradio-paused` pull request #433, author not stated in the PR body
- Merged-in revision: not merged upstream; taken from the PR head, then reworked for this tree
- License: GNU GPL v3 (`GPL-3.0`), same as the project this repository forks
- Port date: 2026-10-27

Device: EDIFIER / 花再 Halo PixelBar over USB HID, `VID 0x2D99` / `PID 0xA106`,
control interface `usagePage 0xFF14` / `usage 1`, fixed 64-byte reports.

Packet layouts were not published by the vendor. Three community projects were used as the
reference: `HaloLyricSync` and `HaloPixelToolBox` for the `2E AA EC E8` text frame and the
`0xEF` scene model, `Seraph310/halo-pixelbar-mcp` (`PROTOCOL_NOTES`) for the `2E AA ED`
command frame, and `traceless929/PixelBar` for the spectrum and clock styles. Because no
simulator exists, every frame is pinned as a byte vector in
`tests/halo-pixelbar-protocol.test.js` — that test is the wire specification.

What was changed from the PR when porting:

- `node-hid` is a normal production dependency. `build.npmRebuild` is set to `false`, unlike
  the PR which also pinned `electronDist` and dropped `toolsets.winCodeSign` — those two were
  not taken. The rebuild has to be off because `@electron/rebuild` (via `node-abi`) cannot
  resolve an ABI for Electron 45 and aborts the whole build; rebuilding is unnecessary anyway,
  since node-hid ships N-API v4 prebuilds that load unchanged under Electron.
- The HID writer is a separate plain-Node child process (`desktop/halo-hid-server.js`),
  unpacked out of `app.asar` together with `node-hid` and `pkg-prebuilds` (the loader
  node-hid uses to find its binary); the main process only frames and forwards. Writing from
  inside the Electron process was measured to fail with `0x3E5`. A packaging mistake here is
  silent at build time and fatal at runtime, so `tests/halo-pixelbar-protocol.test.js` asserts
  the asar-unpacked path resolution and the packed tree is checked by running the child out of
  `dist/win-unpacked`.
- HID initialisation is lazy. Constructing the module only reads `halo-sync.json`; the child
  process is spawned on the first `connect()`, and startup auto-connect additionally
  requires a `lastDeviceSeen` flag written after a real device was found. Users without the
  speaker never pay for a resident process.
- Every IPC channel checks `isTrustedMainWindowIpc` before touching hardware state.
- The panel copy is wired through the four-language dictionary instead of hardcoded
  Chinese, and the popover sits in the titlebar rather than inside the DIY console, whose
  workspace rebuild would delete an injected panel.
