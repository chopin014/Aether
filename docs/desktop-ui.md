<!--
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# Desktop UI development

Aether’s `ui/desktop-shell` branch implements the Discord-derived desktop presentation in Element's real Electron application. The application is named Aether. Linux and Windows are the first release targets; the icon and core palette follow the Aether brand manual v1.1, while the rest of the visual design is provisional. The research gallery and synthetic prototype live outside this repository; neither is the desktop client.

## Launch the actual application

From the monorepo root, using Node 22.18 or newer and the pinned pnpm 12.14.0:

```sh
pnpm install
pnpm exec nx run element-web:build --output-style=static
pnpm exec nx run-many -t build:ts,build:res -p element-desktop --output-style=static
```

If Electron's executable has not been downloaded, run `node apps/desktop/node_modules/electron/install.js`. The desktop host needs its renderer at `apps/desktop/webapp`; create `ln -s ../web/webapp apps/desktop/webapp` only when that path does not already exist.

```sh
cd apps/desktop
env -u ELECTRON_RUN_AS_NODE pnpm exec electron . --config config.desktop.json
```

This loads the locally built renderer through `vector://`, retaining Element's preload, isolation, native window controls and IPC. Sign in with a Matrix account. Discord credentials cannot authenticate a Matrix account.

`config.desktop.json` enables `feature_desktop_shell`, selects the dark theme, and enables the embedded Element Call component. The feature remains disabled by default for other configurations.

## Preview changes without packaging

Electron loads `apps/desktop/webapp.asar` before `apps/desktop/webapp`. If an archive exists from an earlier build,
move it outside the checkout before previewing changes; otherwise Electron keeps showing that archived renderer.
For example, run `mv -i apps/desktop/webapp.asar /tmp/aether-webapp.asar` from the root when the archive exists.
Ensure `apps/desktop/webapp` is a symlink to `../web/webapp`, rather than a copy from an earlier packaged build.

Start the renderer watcher in one terminal:

```sh
cd apps/web
pnpm start
```

Once webpack finishes compiling, run these commands from the monorepo root in another terminal:

```sh
cp apps/desktop/config.desktop.json apps/web/webapp/config.json
pnpm exec nx run-many -t build:ts,build:res -p element-desktop
cd apps/desktop
env -u ELECTRON_RUN_AS_NODE pnpm exec electron . --config config.desktop.json --profile dev
```

The `dev` profile is separate from the installed app and needs its own sign-in. To use the installed app's account,
quit that app first and omit `--profile dev`; both builds must not use the same profile simultaneously.
Keep the watcher running; it writes renderer changes to the shared `webapp` folder. Press Ctrl+R in Electron after
compilation to load them.
For changes to the Electron host, including window controls and tray behaviour, rerun the `build:ts,build:res`
command and restart Electron. AppImage or installer packaging is only needed to test the distribution itself.

## Matrix and calling

The implementation uses the existing SpacePanel, room-list view models, RoomView, timeline, composer, account model, settings actions and resizer. Direct messages retain profile avatars; ordinary rooms use channel symbols and MatrixRTC rooms use voice symbols. Room IDs, encryption, unread state, drafts, permissions and membership continue to come from Element and the Matrix SDK.

Voice-room creation uses `RoomType.UnstableCall`. With `element_call.use_exclusively`, legacy video-room creation requests are normalized to MatrixRTC and call discovery does not fall back to Jitsi. Selecting a desktop call room uses the voice-only intent and skips the initial lobby. Leaving returns to the lobby. The dock controls the microphone through `ElementCallHandle.setDeviceMute` and playback through Element Call’s `window.controls.setAudioEnabled` host API. Deafen mutes both playback and microphone; undeafen restores the prior microphone state. Device preferences persist locally. Existing upstream Jitsi implementation files remain for configurations without this policy; they are not the desktop product's call engine.

Element Call needs a homeserver with a supported MatrixRTC transport and its associated calling services. The desktop client does not supply those server components.

## Real-backend checks and local review

Run a renderer server on port 8080, with `config.json` available, before the tests. The usual `pnpm start` works; an existing production build can be served with `pnpm exec serve -p 8080 -L ./webapp` from `apps/web`.

```sh
cd apps/web
ELEMENT_DESKTOP_SMOKE=1 pnpm exec playwright test playwright/e2e/desktop --project=Chrome --reporter=line
```

The suite uses isolated Synapse, LiveKit and JWT-service fixtures. It covers plaintext and encrypted send/receive, drafts, account menus, settings, keyboard search, sidebar collapse, the native Electron preload, and two-member voice rooms with received audio and no Jitsi requests. Docker and installed Playwright Chromium are required. Native Electron checks also require a desktop display.

For an interactive review with temporary local Matrix users and a populated space:

```sh
ELEMENT_DESKTOP_SMOKE=1 ELEMENT_DESKTOP_REVIEW=1 pnpm exec playwright test playwright/e2e/desktop/native-desktop.spec.ts --project=Chrome --reporter=line
```

Close the Electron window to finish the review and release the test services. The review has a 30-minute limit. These are real Matrix rooms on an isolated test server, not the synthetic prototype or a production account. Do not store important data in this temporary session.

## Presentation and backend mappings

Implemented surfaces include window controls drawn over the app in place of the system title bar on Linux and Windows, a Discord-sized Space rail, a server-name menu, collapsible text/voice categories, channel symbols, an account dock spanning the rail and sidebar, grouped message metadata, left-side attachments, channel-header controls and a notification bell using actual Matrix push rules, the centered server welcome, a compact presence-grouped member panel, contacts Home, connected-call status and device controls, portal theme inheritance and the captured floating settings frame. Light and high-contrast themes retain their Compound colors.

The contacts page uses `m.direct` conversations as contacts. Online and All reflect actual SDK presence; Pending contains actual incoming room invitations; Blocked uses Matrix ignored-user account data. Accept joins the invited Matrix room, Ignore leaves it, and Unblock updates ignored users. Add Friend opens Element’s existing Matrix user lookup and direct-chat flow. This is an explicit compatibility mapping; it does not add a separate mutual-friend protocol or Discord’s relationship graph. Home keeps existing rooms reachable, including rooms outside Spaces.

Space categories are presentation-only projections of actual room types. They do not mutate Matrix tags, memberships or permissions. Existing custom sections remain available. Message rendering retains the original reply, encryption, context-menu, reaction, thread and receipt slots. Desktop calls retain the channel sidebar and connection dock rather than triggering Element’s automatic call collapse. The collapsed sidebar uses the actual resizer state; Playwright must set `lockLeftPanelWidth: false` when testing collapse.

## Reference-to-implementation status

The [desktop UX map](desktop-ux-map.md) compares the 99-state Discord study with current
Element owners, defines the popover/panel/settings interaction model and orders the remaining
UX work. Sync architecture and new backend services are outside this phase.

The account profile menu offers Online (automatic), Away and Appear offline using the existing
Matrix presence APIs. The account dock always shows the selected status badge and reveals the
Matrix ID on hover or keyboard focus. Requested status stays separate from received presence;
missing data for other members is neutral rather than Offline. See [presence behavior and limits](presence.md).

The desktop header pin button opens an anchored, nonmodal message browser without replacing
members or changing the active channel. Cards retain Element's authenticated message and attachment
rendering, original-event jumps, live edits and permission-checked unpin actions. Loading, unavailable
messages and failed requests have explicit states and retry actions. Escape, outside click and the
header button dismiss the browser; explicit dismissal returns focus to the button. Other pin entry
points and the non-desktop shell retain the existing card.

The acceptance target is the captured Discord desktop interface and its interactions, not a recolored Element. These statuses distinguish working integration from finished visual parity.

| Captured surface                | Current implementation                                                                                | Still required                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Server text and members         | Real Space navigation, channel categories, message layout, composer, member groups and header actions | Exact typography, menus, system messages, hover states and all populated timeline variants |
| Friends / Home                  | Real conversations, presence, incoming room invites and ignored users                                 | Exact reference layout, profile cards and explicit mutual-friend semantics if added        |
| Voice connection dock           | Real Element Call join, persistent audio, mic/deafen controls and disconnect                          | Exact participant rows, device menus and connection diagnostics                            |
| Voice stage                     | Working two-person audio-only Element Call                                                            | Replace the remaining Element Call presentation with the captured stage layout             |
| Settings                        | Captured modal frame, real existing settings and security controls                                    | Reorganize and implement each captured page's content and navigation                       |
| Server/channel administration   | Existing Matrix settings remain available                                                             | Captured layouts and explicit mappings for Discord-specific roles and permissions          |
| Threads, pins, search and media | Existing Element actions and rendering retained                                                       | Captured panels, result layouts, menus and populated/error-state coverage                  |
| Profiles and pickers            | Existing functional Matrix surfaces retained                                                          | Captured profile cards, editors, emoji/sticker layouts and interaction coverage            |
| Authentication and recovery     | Existing Element flows retained                                                                       | Reference capture, visual implementation and real account validation                       |

No surface is marked as having complete Discord parity. Completion requires side-by-side review at the captured viewport, keyboard/focus checks and real Matrix state transitions; passing functional tests alone does not establish visual equivalence.

## Remaining parity

Full visual and interaction parity is unfinished. Profiles, threads, search results, media, detailed settings content, channel/server creation and administration, picker content and call-stage presentation still need the captured design applied and reviewed. Authentication, recovery, verification and error states need separate visual coverage. Matrix-specific permissions and privacy controls must retain their actual semantics; Discord roles, friends, forums and paid features are not interchangeable backend objects.

This is a development build, not a signed release. Branding, app identity, updates, packaging and Windows/macOS validation remain open.

## Aether voice additions

Voice-channel participants now appear directly below their channel: 24px round avatars, 32px rows,
40px avatar indentation from the channel sidebar edge, 8px avatar/name spacing and a subtle hover state.
The dimensions follow the captured Discord voice sidebar at its CSS scale. The real MatrixRTC user list
updates on join, leave and profile changes; multiple devices appear once. A profile row does not join the call.
Speaking rings follow actual local and remote microphone activity while connected to an embedded Element Call.
The sidebar observes existing tracks without changing capture, gain, or noise processing; muted and departed users
clear their ring. Reduced motion keeps a steady ring. Remote mute badges are not inferred from room membership.
Original Aether sound cues accompany successful microphone/deafen controls and real call connection changes.
Voice settings include a device-level switch for the cues. See [packaging and release work](aether-releases.md).

## Server and channel presentation

Opening a server lands in its last channel, or its first text channel on a first visit. Text channels open with the
member list on the right until the user closes it; that choice is kept per channel. Direct messages, voice channels
and Spaces keep Element's closed default.

An occupied voice channel shows a filled speaker icon and how long people have been in it, counted from the oldest
MatrixRTC membership still in the call. A channel's Matrix room avatar is its custom icon in the channel list and
header, and its topic sits beside its name in the header. Edit channel, in a channel's menu, opens the room settings
where the name, topic and icon are changed; it is offered to users who may rename the room. The Text Channels and
Voice Channels categories carry a "+" that creates a channel of that kind in the Space for users who may add rooms.

Messages and the composer use 15px text, with 20px between one sender's group and the next. Conversations use 42px
rows, channels 34px rows with 2px gaps, and members 48px rows. Loading uses an Aether orbit spinner, and timeline
files, audio and voice messages appear as Aether media cards.

## Window and server rail

On Linux and Windows the desktop shell has no system title bar: Electron draws the window controls over the top
right of the header row (`titleBarOverlay`, 48px). The header row moves the window, and the room header, contacts
header and member list keep the controls' corner clear. The overlay uses Aether's dark header colours in every theme.
macOS keeps Element's own title bar.

The server rail is 72px wide with 48px icons that round from circles into squares when hovered or selected. A pill at
the rail's edge marks unread (8px), hovered (20px) and selected (40px) servers; mention counts stay as a badge.
A divider separates Home from the user's Spaces.

## Muted and deafened participants

Muted and deafened icons beside voice participants are grey, in the channel icons' column; red is kept for actions
taken by others. Each device announces its deafen both as a LiveKit attribute and as a LiveKit data message, repeated
every 10 seconds while deafened, because the attribute needs a JWT service that lets participants update their own
metadata (`lk-jwt-service` since July 2026). The local user's own row follows this device directly.

## Channel menu and topic

Clicking a channel's name in the header opens an anchored menu beneath it, and right-clicking a channel in the room
list (or using its "more options" button) opens the same entries at the pointer. Both render one
`ChannelMenuContent`, driven by one `ChannelMenuViewModel`, so they cannot differ. The header dropdown adds the
channel icon and name, the topic, an Edit topic entry for people who may change it, and a line each for encryption and
history visibility that open the room settings' Security tab.

The entries follow the captured Discord order and are shown only when they apply:

| Group  | Entry                                                 | Matrix behaviour                                                                               |
| ------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Read   | Mark as read                                          | Room list item action; disabled when nothing is unread                                         |
| Tags   | Favourite                                             | Toggles the `m.favourite` tag                                                                  |
| Share  | Invite to channel, Copy link                          | Existing invite dialog and room permalink copy; hidden without invite rights                   |
| Notify | Mute channel / Unmute, Notification settings          | The room's push setting; Discord's mute durations have no Matrix equivalent                    |
| Manage | Edit channel, Create text channel                     | Room settings dialog; the create-room flow, only inside the active Space and with add rights   |
| Matrix | Files, Polls, Extensions, Export chat, Report channel | `FocusMessageSearch` with `has:file`; poll history, export and report dialogs; Extensions card |
| Leave  | Leave channel                                         | The existing leave confirmation                                                                |

People, Threads and Pinned messages are not repeated: they have header icons. Discord's Duplicate, Move to and Pin to
top have no Matrix equivalent and are omitted. Voice channels omit the entries that need a timeline.

The topic beside the name is a button that opens a small dialog with the whole topic and, for people who may change
it, an Edit topic button that opens the room settings. In a direct message the name opens the profile popout of the
other person, as in Discord, and the menu does not exist. Discord's "show user profile" toggle, a persistent profile
column in a DM header, is a follow-up: the popout and `DesktopProfileViewModel` are anchored to the click that opened
them and would need a column variant first.

`Ctrl+.`, Element's room info shortcut, opens the channel menu (or a direct message's profile) in the desktop shell.
The `RoomSummary` right-panel card is refused by the right panel store under the flag, so neither a header click, a
stored panel state nor a history "back" step can show it.

## Right panel audit

With `feature_desktop_shell` on, every `RightPanelPhases` entry has one of these outcomes:

| Phase                | Desktop shell                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `MemberList`         | Stays in the right column: it is content, opened by the header members icon, `Ctrl+.` no longer toggles it.                       |
| `MemberInfo`         | Replaced by the profile popout (`Action.ViewUser`). Only the popout's "moderate" hand-off still lands on this card, for kick/ban. |
| `ThreePidMemberInfo` | Stays: an invitation by email address has no profile to show.                                                                     |
| `FilePanel`          | Replaced: the channel menu's Files searches `has:file` and the search results own the display. Not reachable from the header.     |
| `NotificationPanel`  | Not reachable (the header bell is the channel notification menu). Follow-up: a Discord Inbox popover with Mentions/Unreads tabs.  |
| `EncryptionPanel`    | Stays: device verification is a multi-step flow started from a toast or a person, and needs the column.                           |
| `RoomSummary`        | Removed: the channel menu covers every action. The store refuses it, and it is dropped from history roots and stored state.       |
| `Widget`             | Stays: a widget is content.                                                                                                       |
| `PinnedMessages`     | Replaced by the pins popover; other entry points keep the card.                                                                   |
| `Timeline`           | Stays: the chat beside a video room is content.                                                                                   |
| `Extensions`         | Stays as a card, opened by the channel menu's Extensions.                                                                         |
| `DocumentViewer`     | Stays: a document is content.                                                                                                     |
| `ThreadView`         | Stays: the split conversation is content.                                                                                         |
| `ThreadPanel`        | Replaced by the thread popover.                                                                                                   |

The space and home summaries (`SpaceRoomView`, `HomePage`) are pages, not right-panel phases, and are unchanged.
