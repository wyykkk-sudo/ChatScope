# Third party software and references

ChatScope application and independently implemented Windows reader: MIT; see LICENSE.

## Distributed components

- Marked 18.1.1: MIT, https://github.com/markedjs/marked ; license supplied in app web/vendor/Marked-LICENSE.md. The original UMD browser bundle is distributed unchanged.
- DOMPurify 3.4.17: dual Apache-2.0 / MPL-2.0; distributed under Apache-2.0, https://github.com/cure53/DOMPurify ; license supplied in app web/vendor/DOMPurify-LICENSE.txt. The original browser bundle is distributed unchanged.
- ChatLab CLI 0.37.5: AGPL-3.0, https://github.com/ChatLab/ChatLab . Corresponding release tag: `v0.37.5`, revision `7b791785b7f72f3cee04728b0ddd2ab69c0b47d7`; supplied in ChatScope-source.zip as chatlab-upstream. Original AGPL license copied to licenses/ChatLab-AGPL-3.0.txt. Official npm package is distributed unchanged, running as a separate local process. Source archive includes upstream build configuration and scripts.
- Electron 39.2.7: MIT and bundled Chromium third party licenses; see LICENSE.electron.txt and LICENSES.chromium.html in the portable folder, https://github.com/electron/electron .
- Node.js 24.16.0: MIT and bundled third party licenses; see licenses/Node-LICENSE.txt, https://nodejs.org/ .
- Python 3.12, SQLCipher / sqlcipher3 0.6.3, psutil 7.2.2, zstandard 0.25.0, pefile 2024.8.26, PyInstaller 6.22.3 and dependencies: original license files supplied in licenses/python-components and/or reader/_internal. PyInstaller's bootloader exception permits distribution of the bundled reader. Python reader requirements and build instructions are included in the source archive.
- Production npm dependency licenses remain in resources/chatscope-runtime/node_modules. Their exact resolved versions are recorded in the runtime package-lock.json.

## Research references

The independently written reader was informed by published database schemas and WCDB cache / SQLCipher validation techniques from https://github.com/raclen/wechat-suite (MIT) and https://github.com/LifeArchiveProject/WeChatDataAnalysis . No native WeFlow / EchoTrace binary is included. Neither project is required to be installed by the user.

EchoTrace and WeFlow were evaluated as possible integration sources: https://github.com/ycccccccy/echotrace and https://github.com/hicccc77/WeFlow . Their private/missing native components are not part of this distribution.

## Windows installer

The EXE installer uses Inno Setup 7.1.0. Its original license is included in docs/Inno-Setup-LICENSE.txt and installed under licenses/Inno-Setup-LICENSE.txt. The installer wraps the unchanged v0.1.1 application payload; scripts are supplied in the repository and in ChatScope-installer-source.zip.
