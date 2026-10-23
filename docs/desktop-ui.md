<!--
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# Desktop UI development

Aether’s `ui/desktop-shell` branch implements the Discord-derived desktop presentation in Element's real Electron application. The application is named Aether. Linux and Windows are the first release targets; the icon and palette remain provisional. The research gallery and synthetic prototype live outside this repository; neither is the desktop client.

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

`config.desktop.json` enables `feature_desktop_shell`, selects the dark theme, and enables the embedded Element Call component. The feature remains disabled by default for other configurations. Rebuild after source changes before reopening the desktop app.

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

Implemented surfaces include a titlebar following the selected Matrix Space, the compact Space rail, a server-name menu, collapsible text/voice categories, channel symbols, an account dock spanning the rail and sidebar, grouped message metadata, left-side attachments, channel-header controls and a notification bell using actual Matrix push rules, the centered server welcome, a compact presence-grouped member panel, contacts Home, connected-call status and device controls, portal theme inheritance and the captured floating settings frame. Light and high-contrast themes retain their Compound colors.

The contacts page uses `m.direct` conversations as contacts. Online and All reflect actual SDK presence; Pending contains actual incoming room invitations; Blocked uses Matrix ignored-user account data. Accept joins the invited Matrix room, Ignore leaves it, and Unblock updates ignored users. Add Friend opens Element’s existing Matrix user lookup and direct-chat flow. This is an explicit compatibility mapping; it does not add a separate mutual-friend protocol or Discord’s relationship graph. Home keeps existing rooms reachable, including rooms outside Spaces.

Space categories are presentation-only projections of actual room types. They do not mutate Matrix tags, memberships or permissions. Existing custom sections remain available. Message rendering retains the original reply, encryption, context-menu, reaction, thread and receipt slots. Desktop calls retain the channel sidebar and connection dock rather than triggering Element’s automatic call collapse. The collapsed sidebar uses the actual resizer state; Playwright must set `lockLeftPanelWidth: false` when testing collapse.

## Reference-to-implementation status

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

Embedded Element Call microphone audio uses RNNoise speech filtering when **Settings → Voice & Video →
Noise suppression** is enabled (the default). The same switch bypasses the filter during an ongoing call.
The existing browser echo cancellation setting remains independent. Processing runs locally in a 48 kHz
AudioWorklet before LiveKit encodes and encrypts the microphone; it never requests a second microphone,
plays the microphone through the speakers, or filters screen-share audio. Device changes rebuild the
processor, and leaving the call releases its worklet, output track and audio context. Initialization or
worklet failures fall back to standard browser noise suppression.

REA inspection of Discord 1.0.166's installed `discord_voice/index.js` identified the separate
`discord_krisp` module and its `VoiceEngine.setKrispPath` integration. Discord documents this engine in
its [Krisp FAQ](https://support.discord.com/hc/en-us/articles/360040843952-Krisp-FAQ).
Aether uses the open-source [RNNoise Web Audio implementation](https://github.com/sapphi-red/web-noise-suppressor)
for the same background-noise use case. This does not establish equivalent filtering quality or isolation
of other people's voices. Disable noise suppression for music. The iframe and legacy call paths retain
their existing browser processing.

The browser regression measures at least 12 dB of attenuation on generated fan-like noise and checks
that disabling suppression restores the signal. The model provides little reduction for the tested
repeating, full-band white-noise signal; fan-noise results must not be read as a guarantee for all sounds.
The dependency patch adds a readiness handshake, so failed or stalled model initialization can fall back
before a silent processed track is published.

With embedded Element Call enabled, **Settings → Voice & Video → Microphone settings** includes input
gain (0–200%), automatic voice detection, and a manual threshold (-100–0 dB). Voice activation gates
the outgoing microphone on the audio thread, with a short hold to preserve pauses between syllables.
These controls also apply when RNNoise is disabled. The iframe and legacy call paths retain their
existing controls.

**Mic test** plays the processed microphone locally through the selected output, shows the input
level and detection threshold, and has an independent test playback volume. Use headphones to avoid
feedback. Starting a test requests microphone access; stopping it, closing settings, leaving the page,
or disconnecting the microphone releases the preview. Changing input devices or browser processing
settings restarts an active test. Device choices, gain, sensitivity and test playback volume are saved
on this device.

Voice-channel participants now appear directly below their channel: 24px round avatars, 32px rows,
40px avatar indentation from the channel sidebar edge, 8px avatar/name spacing and a subtle hover state.
The dimensions follow the captured Discord voice sidebar at its CSS scale. The real MatrixRTC user list
updates on join, leave and profile changes; multiple devices appear once. A profile row does not join the call.
While joined to a voice channel, a green ring and soft pulse follow each user's real, unmuted
microphone activity, including the local user. The main call avatars use that same signal in grid,
one-to-one and spotlight layouts. Multiple devices are combined into one sidebar speaking indicator.
The embedded Element Call bridge supplies this signal. The pinned dependency patch measures the existing
microphone tracks every 40ms, with a short release hold, so the sidebar does not wait for server speaker
updates. It reuses the call's tracks and falls back to its existing speech detection when Web Audio is
unavailable, without recording audio or publishing activity as Matrix room state. Activity clears
on mute, leave or disconnect. Reduced-motion users see a steady ring. Before joining, membership alone
does not reveal who is speaking, so no speaking rings or remote mute badges are fabricated.
Original Aether sound cues accompany successful microphone/deafen controls and real call connection changes.
Voice settings include a device-level switch for the cues. See [packaging and release work](aether-releases.md).
