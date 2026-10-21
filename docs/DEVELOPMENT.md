# Build and verify on Windows x64

The source zip contains this directory as `app/`, an unmodified ChatLab source tree as `chatlab-upstream/`, and scripts under `scripts/`. Its contents are source and generated test examples only; no runtime user databases or credentials are included.

Use Node.js 24.16.0, Python 3.12 and Windows x64. To recreate the supplied staging layout, copy `app/` to `work/chatscope-src`, `chatlab-upstream/` to `work/chatlab-upstream`, and scripts into `work/` within a clean project folder. Create an `outputs/` folder.

1. Install runtime and packaging dependencies:

   `npm install --prefix work/runtime electron@39.2.7 @electron/asar@4.3.1 chatlab-cli@0.37.5`

   `npm install --prefix work/ship-runtime --omit=dev chatlab-cli@0.37.5`

   Copy the Node executable to `work/runtime/node.exe`. If Electron's installer fails, `scripts/unpack_electron.py` verifies the cached archive against the official npm checksum and extracts it.

2. Install reader dependencies to an isolated folder:

   `python -m pip install --target work/python-libs -r work/chatscope-src/requirements-reader.txt`

   Markdown browser bundles are already included in `app/web/vendor`. To refresh the pinned versions: `npm install --prefix work/markdown-runtime --save-exact marked@18.1.1 dompurify@3.4.17`, then copy marked/lib/marked.umd.js and dompurify/dist/purify.min.js to web/vendor, preserving their original licenses. The application loads these local files only.

3. In PowerShell set `$env:PYTHONPATH=(Resolve-Path work/python-libs).Path` and build:

   `python -m PyInstaller --noconfirm --onedir --name ChatScopeReader --distpath work/reader-build --workpath work/pyinstaller --specpath work --paths work/python-libs --collect-all sqlcipher3 --collect-all zstandard --collect-all psutil --hidden-import pefile work/chatscope-src/reader.py`

4. Run `python work/test_reader.py`, then `node work/test_engine.cjs`. These tests use generated encrypted fixtures and a local mock model, and never call a cloud model.

5. Run `node work/package.cjs`, then `python work/finalize_package.py`. Add original Node.js and Python runtime licenses to `outputs/ChatScope/licenses` before final packaging. Lock files provided under `locks/` record exact npm versions of the delivered build.

6. `work/qa_ui.cjs` is an Electron UI test with fictional records and a mock model. Run it with the installed Electron binary. `work/test_portable.cjs` additionally checks a running same-user WeChat installation's metadata only; this live test is optional and is not part of the synthetic tests.

The original ChatLab backend is not modified. For its source build instructions, see the supplied upstream README and apps/cli/package.json. ChatScope uses the official published CLI binary as a separate local process.

## v0.2.0 export and provider checks

From this repository run `scripts/test_chat_export.py`, then `scripts/test_export_providers.cjs` with `CHATSCOPE_TEST_WORK` pointing to your build work directory (containing runtime/node.exe and the installed ChatLab CLI). The Python test needs the reader requirements on PYTHONPATH. Fixtures cover encrypted media/resource databases, selected-chat isolation, local attachment copies, size limits, native reader dispatch, real ChatLab re-import and Claude/OpenAI protocol roundtrips against local mock servers. No cloud keys are required.

The release is staged in work/portable-020 to keep any running outputs/ChatScope installation separate. The installer test uses an isolated destination, upgrades from v0.1.2, checks settings/data preservation, exercises the installed UI and uninstalls while preserving its synthetic data.
