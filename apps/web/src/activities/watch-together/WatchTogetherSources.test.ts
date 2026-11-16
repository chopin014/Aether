/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";

import {
    fetchMetadata,
    parsePlayableLink,
    PlayableLinkRefusedError,
    sourceUrl,
    thumbnailUrl,
} from "./WatchTogetherSources";

describe("parsePlayableLink", () => {
    it.each([
        ["https://www.youtube.com/watch?v=aqz-KE-bpKQ", "aqz-KE-bpKQ", undefined],
        ["https://youtube.com/watch?v=aqz-KE-bpKQ&list=PL123&index=2", "aqz-KE-bpKQ", undefined],
        ["https://m.youtube.com/watch?v=aqz-KE-bpKQ&t=90", "aqz-KE-bpKQ", 90],
        ["https://music.youtube.com/watch?v=aqz-KE-bpKQ", "aqz-KE-bpKQ", undefined],
        ["https://youtu.be/aqz-KE-bpKQ?t=1m30s", "aqz-KE-bpKQ", 90],
        ["https://www.youtube.com/shorts/aqz-KE-bpKQ", "aqz-KE-bpKQ", undefined],
        ["https://www.youtube.com/live/aqz-KE-bpKQ?t=1h2m3s", "aqz-KE-bpKQ", 3723],
        ["https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?start=30", "aqz-KE-bpKQ", 30],
        ["youtu.be/aqz-KE-bpKQ", "aqz-KE-bpKQ", undefined],
        ["  https://youtu.be/aqz-KE-bpKQ  ", "aqz-KE-bpKQ", undefined],
    ])("reads %s", (text, ref, start) => {
        expect(parsePlayableLink(text)).toEqual({ source: "youtube", ref, ...(start ? { start } : {}) });
    });

    it("accepts https links to media files and drops their fragment", () => {
        expect(parsePlayableLink("https://cdn.example.org/music/Song%20One.MP3#t=5")).toEqual({
            source: "media",
            ref: "https://cdn.example.org/music/Song%20One.MP3",
        });
        expect(parsePlayableLink("https://example.org/clip.webm?sig=abc")?.source).toBe("media");
    });

    it.each([
        "",
        "hello world",
        "check this https://youtu.be/aqz-KE-bpKQ",
        "https://www.youtube.com/watch?v=short",
        "https://www.youtube.com/channel/UC123",
        "https://example.org/page.html",
        "http://example.org/song.mp3",
        "ftp://example.org/song.mp3",
        "javascript:alert(1)",
        "https://evil.example/youtube.com/watch?v=aqz-KE-bpKQ",
    ])("refuses %j", (text) => {
        expect(parsePlayableLink(text)).toBeUndefined();
    });

    it("treats any other https page as a website only where websites can be opened", () => {
        expect(parsePlayableLink("https://archive.org/details/BigBuckBunny_124")).toBeUndefined();
        expect(parsePlayableLink("https://archive.org/details/BigBuckBunny_124", { sites: true })).toEqual({
            source: "site",
            ref: "https://archive.org/details/BigBuckBunny_124",
        });
        expect(parsePlayableLink("https://youtu.be/aqz-KE-bpKQ", { sites: true })?.source).toBe("youtube");
        expect(parsePlayableLink("hello", { sites: true })).toBeUndefined();
        expect(parsePlayableLink("http://insecure.example/video", { sites: true })).toBeUndefined();
    });

    it("names a website after its domain", async () => {
        await expect(fetchMetadata({ source: "site", ref: "https://www.archive.org/x" }, vi.fn())).resolves.toEqual({
            title: "archive.org",
        });
    });

    it("gives YouTube thumbnails and source links", () => {
        expect(thumbnailUrl({ source: "youtube", ref: "aqz-KE-bpKQ" })).toBe(
            "https://i.ytimg.com/vi/aqz-KE-bpKQ/mqdefault.jpg",
        );
        expect(thumbnailUrl({ source: "media", ref: "https://example.org/a.mp4" })).toBeUndefined();
        expect(sourceUrl({ source: "youtube", ref: "aqz-KE-bpKQ" })).toBe(
            "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
        );
    });
});

describe("fetchMetadata", () => {
    const youtube = { source: "youtube" as const, ref: "aqz-KE-bpKQ" };
    const respond = (status: number, body: unknown = {}): typeof fetch =>
        vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

    it("reads a YouTube title and channel without credentials", async () => {
        const fetchFn = respond(200, { title: "Big Buck Bunny", author_name: "Blender" });
        await expect(fetchMetadata(youtube, fetchFn)).resolves.toEqual({ title: "Big Buck Bunny", channel: "Blender" });
        const [url, init] = vi.mocked(fetchFn).mock.calls[0];
        expect(url).toBe(
            "https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Daqz-KE-bpKQ",
        );
        expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    });

    it("refuses videos whose owner turned off embedding", async () => {
        await expect(fetchMetadata(youtube, respond(401))).rejects.toEqual(
            new PlayableLinkRefusedError("not_embeddable"),
        );
        await expect(fetchMetadata(youtube, respond(404))).rejects.toMatchObject({ reason: "not_found" });
    });

    it("carries on without a title when the lookup fails", async () => {
        await expect(fetchMetadata(youtube, vi.fn().mockRejectedValue(new TypeError("offline")))).resolves.toEqual({});
        await expect(fetchMetadata(youtube, respond(500))).resolves.toEqual({});
    });

    it("names a media file after its file name and site, without fetching it", async () => {
        const fetchFn = vi.fn();
        await expect(
            fetchMetadata({ source: "media", ref: "https://cdn.example.org/a/My%20Song.mp3" }, fetchFn),
        ).resolves.toEqual({ title: "My Song", channel: "cdn.example.org" });
        expect(fetchFn).not.toHaveBeenCalled();
    });
});
