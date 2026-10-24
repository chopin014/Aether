<!--
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# Desktop global shortcuts

The desktop shell exposes only `configure` and an unsubscribable action-event listener through the preload.
The main process validates the entire configuration, checks the owning window and main frame, and checks
`feature_desktop_shell`. Raw keyboard events never cross IPC. Renderer navigation (except same-document or
subframe navigation), crashes, window closure, screen lock, suspend, quit, disabling and backend failure release
active holds before unregistering. Changing window focus keeps global holds active.

Windows and Linux X11 use the optional `uiohook-napi` Node-API prebuild to observe press and release. Electron
`globalShortcut` reserves each configured chord and reports conflicts; its press callback is never used to
simulate a hold. Only configured chords are reserved. Native loading/start failures report unsupported. The
existing electron-builder native-dependency step handles the prebuild, and `**/*.node` is unpacked from ASAR.
Available prebuild targets include Windows x64 and Linux x64/arm64; other targets can report unsupported.

Wayland exclusively uses `org.freedesktop.portal.GlobalShortcuts` through the maintained pure JavaScript
`@homebridge/dbus-native` transport. It registers its dedicated D-Bus connection with the packaged desktop entry
identity (`desktopName`, `aether.desktop` in Aether builds) using the host Registry when available. The compositor
can request permission and change the preferred trigger. Registration reports only IDs confirmed by the portal.
Only the portal owner's authenticated `Activated` and `Deactivated` signals drive holds. Permission cancellation,
unsupported compositor portals and session/bus loss never fall back to observing XWayland. A permission request
expires after two minutes or closes immediately when its configuration is disabled/disposed.

Modifier-only bindings report unsupported because these backends cannot reliably reserve them. Native codes
are physical KeyboardEvent codes; portal preferred triggers use XKB symbols and the compositor owns the final
layout and trigger choice. A portal binding change resets the session and releases active holds.

Run from `apps/desktop`:

```sh
pnpm test:unit run src/global-shortcuts src/build-config.test.ts src/aether-packaging.test.ts
pnpm lint:types:src
```

Verification on 2026-10-24 used Electron 44.9.0 with a temporary profile and two disposable HTML windows.
With the shortcut owner hidden/unfocused and the separate synthetic input window focused, the native X11
backend reserved Control+Shift+KeyV and observed both edges injected with `xdotool keydown` / `keyup`. This
host runs GNOME Wayland, so this exercises X11 through XWayland; a standalone Xorg session and Windows still
require platform verification. An F24 synthetic injection did not produce hook events on this host; the ordinary
KeyV binding did. No real account or existing application process was used.

A separate real session-bus smoke used a temporary `io.aether.ShortcutSmoke445740.desktop` identity, successfully
registered with the host Registry, created a session and received a successful BindShortcuts response confirming
push-to-talk. It then disconnected and removed its desktop file. The permission dialog was not visually inspected,
and compositor Activated/Deactivated with physical Wayland input remain manual checks. Unit tests cover portal
signal authentication, both edges, permission denial, session closure, owner loss and registration changes.

Primary references:

- [GlobalShortcuts portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html)
- [Host Registry](https://github.com/flatpak/xdg-desktop-portal/blob/main/data/org.freedesktop.host.portal.Registry.xml)
- [XDG trigger syntax](https://specifications.freedesktop.org/shortcuts/latest/)
- [uiohook-napi](https://github.com/SnosMe/uiohook-napi)
