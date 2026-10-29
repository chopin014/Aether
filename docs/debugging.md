# Debugging Aether desktop

## Renderer

Run the app using the [desktop development guide](desktop-ui.md).
Open the developer tools from the application menu to inspect the renderer, console, and network requests.
For a stale renderer, check whether `apps/desktop/webapp.asar` is taking precedence over the unpacked build.

## Main process

For a development build, pass `--inspect-brk` to Electron and attach a Node.js debugger through Chromium's
`chrome://inspect` page. The main-process source is in `apps/desktop/src`.

Production builds disable Node inspector arguments through Electron fuses. Reproduce the issue in a development
build or a separate inspection-enabled test copy; keep production fuse settings in distributed installers.
See [native debugging with gdb](gdb.md) for native crashes.
