<!--
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
-->

# Soundboard

The desktop shell exposes the same soundboard in the connected voice dock and the in-call toolbar, including
conversation calls. It is part of the existing desktop-shell labs feature. Both controls retain one shared model
for the call, so they never install duplicate playback listeners.

Both controls open the full searchable picker directly. Click a sound to play it for Aether participants in the call.
The side rail scrolls to a library, showing its Space or channel avatar. The small preview control on a tile plays
only on your device. Different sounds can overlap; clicking the same sound restarts it immediately on senders
and listeners. Each device controls its own soundboard volume, multiplied by its speaker volume. Deafen stops
soundboard playback immediately.
Frequently used tiles stay in the same order while the picker is open; rankings update when it reopens.
Volume and sound usage currently last for the lifetime of the call model.

## Libraries and uploads

The voice channel (or conversation room) has its own library. Every joined Space contributes its own library,
so its sounds can be used in any call. The currently selected Space appears immediately after Aether sounds.
Empty libraries are hidden from the rail and catalog but remain available as upload destinations when permitted.
Spaces you have left are not listed. Six original synthesized Aether sounds are bundled: Airhorn, Quack, Sad horn, Cricket, Golf clap, and Ba dum tss.

**Upload a sound** appears when your Matrix power level allows sending `io.aether.soundboard.sound` state in
at least one library. Choose the destination library, name, emoji using Aether's searchable emoji picker, and audio
file. Audio sources up to 20 MB and ten minutes are decoded locally. The waveform editor previews only the selected
section. Drag either edge to trim, drag the highlighted region to move it, or focus any of these controls and use
arrow keys (Shift for one-second steps). Select **Upload sound** to share the chosen section, at most ten seconds.
Export uses 24 kHz mono PCM WAV, keeping even a ten-second clip below the 512,000-byte playback limit. Cancelling
releases the local audio; closing the panel stops preview and retains the selection. Supported source formats
depend on the browser's audio decoder. An empty name uses the filename. Each sound has an independent UUID state key, preventing
concurrent uploads from replacing the whole library. Users with the same state permission can remove entries.
Homeserver media limits and policies still apply.

The edit action on a Space sound opens the same waveform editor with its existing name and emoji. Changes to
volume or selection are rendered into the saved audio; metadata-only edits retain the original media URL. Saving
uses the same Matrix state key, preserving the entry rather than duplicating it. Permission changes, removals,
and edits received while the editor is open are checked before saving. Cancelling changes nothing in the Space.

Audio is uploaded with the standard Matrix content repository API. Metadata is stored as custom state:

```json
{
    "type": "io.aether.soundboard.sound",
    "state_key": "<sound UUID>",
    "content": {
        "name": "Hello",
        "emoji": "👋",
        "url": "mxc://example.org/audio-id",
        "duration_ms": 1500
    }
}
```

An empty content object removes the current entry. This does not delete media from the homeserver or redact
previous versions. Matrix state events are not end-to-end encrypted. These uploads are also unencrypted;
library membership is not a media-access control boundary. Do not use this library for confidential recordings.

## Playback and compatibility

Clicking starts local playback immediately. While alone, no playback signal is sent. With listeners present,
the embedded call component sends a reliable LiveKit data packet in parallel, using the call's existing
end-to-end encryption keys in encrypted calls. This avoids Matrix message rate limits during rapid playback.
Packets contain `io.aether.soundboard.play`, a unique ID, timestamp, `library_id`, and `sound_id`. Custom requests
also include the validated sound metadata and Matrix media reference so listeners outside the source Space
can play the clip. Playing a custom sound shares that reference with the call. Call packets are transient;
they are not stored in Matrix history. A failed transmission is reported even though the sender has already
heard the sound. Playback, transmission, uploads, and removal report separate errors.

Older call embeddings without data transport fall back to a custom Matrix room event. The SDK encrypts that
request in encrypted rooms. Failed sound requests are removed from the pending queue. A fresh sound blocked
behind failed chat messages is sent through the SDK retry path without retrying or deleting those messages.
These fallback events remain subject to homeserver message rate limits and persist in Matrix history, but are
hidden from Aether's chat timeline and never replayed from pagination or history.

Receivers require a live event newer than the model's creation and no older than ten seconds, an active local
call, a sender in that call's participant list, and either a sound from an available library or valid shared
custom-sound metadata. They deduplicate event IDs without imposing a cooldown on consecutive sounds. Both senders and listeners preload
up to 24 likely sounds during the call, fetching at most two uploaded clips at a time. Uploaded audio uses
authenticated Matrix media endpoints and is validated for size and duration before caching. Playback reuses
prepared audio and its output device, rather than downloading and decoding the same sound on each click. Deafen and leave stop playback;
disposing the call cancels preparation and releases cached media.

Prepared sounds can play as soon as a request arrives. Network delivery, device buffering, and
a first play before preloading finishes can still add latency; clients are not sample-synchronized.

No homeserver changes are required. Matrix supplies storage and call membership; it does not standardize a
Discord-compatible soundboard. Other clients need to implement the soundboard protocol to hear sounds. Audio is
not injected into the microphone or LiveKit stream, and playback is not sample-synchronized. Personal account
libraries, persistent popularity rankings, and entrance sounds are not implemented.

Voice activity uses an inset avatar ring in the channel list, call stage, and account dock. Microphone speech is green;
active soundboard playback takes priority and uses blue, including sounds played while the microphone is muted.
Previewing a sound does not publish avatar activity. The blue state starts when audio playback starts and clears on
end, failure, stop, deafen, or disconnect; overlapping clips keep the sender active until their final clip stops.

The ring follows the captured Discord renderer's avatar behavior (study asset `web.35f1b2f06b0104fe.js`, modules
556525 and 778712): a two-pixel inset ring, a one-pixel background separator, a 50 ms shadow transition, and
soundboard color precedence. The captured browser voice detector (module 113634) samples every 20 ms and combines
a ten-frame speech history with ten silent frames, retaining activity for roughly 400 ms. Aether uses a 400 ms
release window with its existing microphone detector; native Discord detection and volume-driven ring thickness
are not established by this implementation. Muting or losing the microphone clears speech immediately.
