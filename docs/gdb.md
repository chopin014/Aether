# Native debugging with gdb

For a native crash on Linux, use the Aether executable and Electron debug symbols matching the affected build.
Check the Electron version in `apps/desktop/package.json` at the build's source revision.

1. Download the corresponding `electron-v<version>-linux-x64-debug.zip` from
   [Electron releases](https://github.com/electron/electron/releases), matching your architecture.
2. Extract the debug files beside the executable in an unpacked Aether build. Keep `electron.debug`
   alongside the renamed `aether` executable.
3. Run `gdb --args /path/to/aether`, or `gdb /path/to/aether /path/to/core` to inspect a core dump.

Use the exact executable and symbols for the crash being investigated.
Core dumps can contain account data and message contents; do not attach them to public issues.
For JavaScript issues, start with the [debugging guide](debugging.md).
