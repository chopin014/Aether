<!--
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# Presence in the account profile

Open the account avatar/name and its requested-status submenu to choose **Online (automatic)**,
**Away**, or **Appear offline**. Online becomes Away after three minutes without activity;
activity on this client does not override manual Away or Appear offline. The choice is stored
locally for the homeserver, account and device. Logging out disposes its listeners and timers;
a new device starts with the automatic setting.

The requested choice is separate from the presence most recently received from the server.
A successful request does not fabricate a presence event or a green self indicator. The dock
shows a presence dot only after receiving presence. Failed requests keep the requested choice
and show an explicit retry action; activity does not repeatedly retry them.

Matrix supports `online`, `unavailable` and `offline` in both presence requests and sync.
The controller sets the sync parameter and sends a presence PUT for manual changes. It preserves
the last received legacy presence status message when available; custom profile status is separate.
See the [Matrix presence specification](https://spec.matrix.org/latest/client-server-api/#presence).

## Availability and limits

`enable_presence_by_hs_url` can explicitly disable controls for a homeserver. Guest accounts and
low-bandwidth sessions also cannot send presence through these controls. The sample web config
disables presence for the two matrix.org base URLs; the desktop config does not copy these entries.
This change does not invent a homeserver capability from a missing event or from a list of offline users.

Matrix does not provide reliable presence-capability discovery. Some servers omit presence or accept
requests without broadcasting an update; other devices and server idle policies can affect the aggregated
status. The submenu explains this and shows **Status unknown** until presence is actually received.
There are no per-member requests or presence polling.

The SDK initializes a User's presence to offline without a received event. We require `events.presence`
before treating that value as observed. The first actual offline event can leave the value unchanged, so
views also listen for `User.lastPresenceTs`. With no received presence, the desktop roster retains roles
and a neutral member section. Mixed lists have a separate **Status unknown** section; genuinely received
offline users remain Offline, even when every received status is offline. Contacts and profiles use the
same distinction. Displayed member presence does not derive from calls, messages or local activity.
