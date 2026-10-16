# Third-party software

This repository contains original application code under the MIT License. Dependencies are installed from npm; their original licenses and notices remain applicable.

| Dependency | Purpose | License |
| --- | --- | --- |
| `@decartai/sdk` | Realtime Decart integration | MIT |
| `esbuild` | Browser bundle build | MIT |
| `playwright` | Development browser checks | Apache-2.0 |
| `electron` | Desktop runtime; incorporates Chromium and Node.js | MIT and bundled third-party notices |
| `electron-builder` | Development installer tooling | MIT |

The web source requires an externally installed ffprobe. Windows desktop distributions include an unmodified BtbN LGPL shared FFmpeg build's ffprobe and shared libraries. See [FFprobe notices](desktop/FFPROBE-NOTICES.txt) for the pinned source revision, build recipes and binary checksum. The LGPL v3 and incorporated GPL v3 texts are bundled beside the binary. That binary is invoked as a separate process; the application's original code remains MIT.

Electron distributions include their original LICENSE and LICENSES.chromium.html; retain these when redistributing. Third-party dependencies keep their own license files. Decart model weights and cloud service are not distributed by this project.
