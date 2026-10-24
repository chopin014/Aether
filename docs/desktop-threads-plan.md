<!--
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# Desktop thread interaction plan

## Objective and evidence

Bring Aether's thread discovery, creation and conversation navigation into the Discord desktop interaction model,
while keeping Element's Matrix thread engine, encryption, timelines, composer and read tracking.

The local reference gallery is in the parent preparation workspace, outside this repository. Its `threads-panel`
capture has a searchable browser below the channel header, a Create action and a centered empty state. The measured
browser is 480 CSS pixels wide at a 1280 by 720 CSS pixel viewport; the screenshot uses a device scale of 1.5.
Use CSS measurements, rather than physical screenshot pixels. The capture manifest and `docs/coverage.md` explicitly
identify populated thread and creation workflows as uncaptured. Do not describe those states as visually verified.
Private reference screenshots, account content and recovered assets must remain outside commits and public artifacts.

Supplement the capture with [Discord's thread documentation](https://support.discord.com/hc/en-us/articles/4403205878423-Threads-FAQ)
and the [Matrix threading specification](https://spec.matrix.org/latest/client-server-api/#threading).
Discord documents message-based creation, a channel thread browser, sidebar discovery and thread participation.
Matrix threads reference a root event through `m.thread`, inherit their room's access and support server pagination.

## Existing integration points

- `RoomHeader.tsx` already exposes a Threads button, currently opening `RightPanelPhases.ThreadPanel`.
- `ThreadPanel.tsx` already creates and fetches the room's all/participated thread timeline sets.
- `ThreadView.tsx` owns the thread timeline, real composer, uploads, drafts, event navigation and read receipts.
- `ShowThreadPayload` and the right-panel store carry the root and initial event into the existing thread view.
- `ThreadSummaryView` and its view models already expose reply counts, unread indicators and latest-reply previews.
- Existing thread Playwright tests exercise send/receive and rich timeline behavior against a homeserver.

## Implementation sequence

### 1. Searchable channel thread browser

For the desktop shell, make the channel's Threads button toggle a non-blocking anchored browser matching the captured
placement and proportions. Preserve the underlying channel and member panel. Add an accessible search field, Create
action, compact populated rows, useful empty/no-results/loading/error states and a retry action. Each row uses an
actual thread root, a safe root-derived label, latest activity, reply count and existing unread information.

Use a shared MVVM view and an application view model. Subscribe to SDK thread/timeline changes and dispose listeners.
Keep pagination and permission checks in the existing Matrix services. A search must not silently claim to search
unloaded history: paginate the supported list or clearly bound the result scope. Handle decrypted content, edits,
redactions, room switches and stale asynchronous responses. Do not duplicate message-rendering or crypto logic.

Escape/outside-click closes the browser and restores trigger focus. Opening a result dismisses the browser and opens
the existing thread conversation. Keep the upstream browser path for configurations without the desktop shell.

### 2. Thread conversation and navigation

Present the existing thread view as a Discord-style split conversation beside the channel: a thread icon/title,
parent-channel context, existing useful actions and an obvious Close action. Preserve the original event timeline,
message composer, attachments, editing, reactions, links and per-thread drafts. Use the root preview as a label when
there is no separate interoperable thread name. Show an inline reply summary beneath the root in the channel.

Make switching threads and closing/reopening preserve drafts and channel scroll position. Closing a conversation is
a local navigation action and must not claim to archive a shared thread. Restore the previously visible right-panel
content when appropriate, including the member list. Retain accessible focus return and permalink highlighting.
Adapt to a narrow viewport without making the composer or close/navigation controls unreachable.

Expose an indented active-thread entry beneath its parent channel if it fits the existing room-list model without
inventing rooms, unread counts or subscriptions. Treat this as a separate, testable navigation concern.

### 3. Starting a thread

Keep the existing message action, but give desktop users a recognizable Start Thread interaction which focuses the
real thread composer. Reopening an existing root must reuse the same Matrix thread, rather than making duplicates.

The browser's Create action must lead to a working creation flow. Prefer a real starter/root message and initial
thread reply, sent through Element's existing message pipeline. If a name is collected for a new starter, represent
it honestly as that normal Matrix root message, rather than unsynchronized local metadata or a fabricated room.
Inspect the composer interfaces before choosing the final adapter. Opening or cancelling the flow sends nothing.
Handle partial send failures and retries without duplicate root messages or replies; keep the draft on failure.
An existing message's content must not be rewritten merely to rename its thread.

### 4. Scope and compatibility

Implement the shared interaction model; do not claim exact feature parity where Matrix semantics differ.
Discord private threads, per-thread membership, rename, archive/lock, auto-archive and thread-specific slow mode
need explicit protocol/product mappings. Do not expose working-looking controls for unsupported operations, mutate
room membership to imitate joining a thread, or silently substitute muting for leaving. Preserve any real existing
Matrix notification/follow capabilities with accurate labels. Document remaining differences in the final report.

Keep all new presentation behind `feature_desktop_shell`. Preserve Aether's palette and existing Compound token,
portal, keyboard and reduced-motion behavior. Reuse the app's icon system and existing accessible components.

## Validation and delivery

Use isolated synthetic component fixtures and disposable homeservers; do not change the running user's account,
rooms, calls or profile. Require tests for browser discovery/filtering/pagination, creation/cancellation/failure,
real `m.thread` send/receive, duplicate prevention, draft isolation, room switching, redactions and navigation focus.
Run affected unit, type, lint, style and formatting checks, plus i18n generation for translated strings.

Add a desktop Playwright happy path: discover a real thread, open it, receive/send replies, close and reopen it,
and confirm thread relations and channel continuity. Cover plaintext and encrypted operation using existing fixtures
where supported. Review dark/light, Portuguese, long text and constrained viewport captures at matching CSS scale.
Separate the captured empty-state comparison from inferred populated layouts. Do not regenerate screenshot baselines
locally. Keep implementation split into coherent commits, then let the parent review and push each feature.

## Implementation status

The desktop shell now uses a non-modal browser anchored below the Threads button, right-aligned to it like the pins popover. Discovery reads the SDK's all/participated
thread sets, combines live thread updates, exposes server pagination, and searches only loaded roots and latest replies.
Loading, retry, empty and no-results states are explicit. Root labels follow edits, decryption and redaction. Escape and
outside clicks dismiss the browser and return focus to its trigger; changing rooms disposes the browser's listeners.

Browser creation posts a normal Matrix starter message and its first `m.thread` reply through `MatrixClient.sendMessage`.
The two initial fields are plain text; the resulting conversation uses Element's existing rich composer and upload path.
Opening or cancelling creation sends nothing. Creation drafts are retained per room for the current client session.
Stable SDK transaction IDs and failed-local-echo resend preserve the root across partial failures and prevent duplicate
messages on retry. Once sending starts, its content remains fixed while an uncertain send is retried.

Thread results, message actions, inline root summaries and permalinks continue into the existing `ThreadView`. Its desktop
header derives its label from the root and includes the parent channel, existing thread actions and Close. Closing restores
the previous right-panel state and visibility. Switching roots gives each composer its own existing thread draft. A currently
open thread appears beneath its actual parent channel; it does not create a room, participant roster or subscription.
Narrow screens present the same conversation over the channel area with reachable navigation and composer controls.
The existing thread-browser presentation remains in configurations without `feature_desktop_shell`.

### Protocol and evidence boundaries

- A starter is a real room message. There is no separate local-only name, and existing roots are never rewritten to rename
  a thread. Everyone with room access can read its threads.
- No private-thread, per-thread membership, rename, shared archive/lock, auto-archive or slow-mode controls are simulated.
  Close is local navigation. Existing Matrix notification and thread-link actions retain their actual meanings.
- The saved Discord evidence verifies only the empty browser's anchored 480 × approximately 449 CSS-pixel geometry and
  its title/search/Create structure. Populated rows, creation, the open conversation and the active-thread row are inferred
  adaptations tested against Matrix behavior. They are not claimed as captured Discord parity.
- The implementation retains Aether/Compound colors and typography and uses existing licensed Aether icons. Its empty
  illustration is composed from those icons; no Discord fonts, graphics or private reference content are shipped.
