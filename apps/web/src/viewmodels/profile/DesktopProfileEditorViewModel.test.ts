// @vitest-environment jsdom
/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixError, TypedEventEmitter, type MatrixClient } from "matrix-js-sdk/src/matrix";

import { DesktopProfileEditorViewModel } from "./DesktopProfileEditorViewModel";
import { BANNER_FIELD, BIO_FIELD_MSC4440, RICH_PROFILE_FIELD, STATUS_FIELD } from "../../profile/richProfile";
import { RichProfileStore } from "../../profile/RichProfileStore";
import { editImage, frameImage } from "../../components/views/dialogs/ImageCropDialog";

vi.mock("../../customisations/Media", () => ({
    mediaFromMxc: (mxc: string) => ({
        srcHttp: `http://media/${mxc}`,
        getThumbnailOfSourceHttp: () => `http://thumb/${mxc}`,
    }),
}));

vi.mock("../../components/views/dialogs/ImageCropDialog", () => ({
    editImage: vi.fn(async (file: File) => file),
    frameImage: vi.fn(async (file: File) => ({ file })),
}));

const ME = "@me:example.org";

function makeClient(profile: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): MatrixClient {
    return Object.assign(new TypedEventEmitter<string, any>(), {
        getSafeUserId: () => ME,
        getUserId: () => ME,
        doesServerSupportExtendedProfiles: vi.fn().mockResolvedValue(true),
        getCapabilities: vi.fn().mockResolvedValue({}),
        getCachedCapabilities: vi.fn().mockReturnValue(undefined),
        getExtendedProfile: vi.fn().mockResolvedValue(profile),
        getExtendedProfileProperty: vi.fn(async (_: string, key: string) =>
            key === STATUS_FIELD ? { text: "x" } : undefined,
        ),
        setExtendedProfileProperty: vi.fn().mockResolvedValue(undefined),
        deleteExtendedProfileProperty: vi.fn().mockResolvedValue(undefined),
        setDisplayName: vi.fn().mockResolvedValue(undefined),
        setAvatarUrl: vi.fn().mockResolvedValue(undefined),
        uploadContent: vi.fn().mockResolvedValue({ content_uri: "mxc://example.org/uploaded" }),
        store: { getUserProfile: vi.fn().mockResolvedValue(undefined), storeUserProfiles: vi.fn() },
        getRooms: () => [],
        getIgnoredUsers: () => [],
        getAccountData: () => undefined,
        getCrypto: () => undefined,
        ...overrides,
    }) as unknown as MatrixClient;
}

async function ready(client: MatrixClient): Promise<DesktopProfileEditorViewModel> {
    const vm = new DesktopProfileEditorViewModel({ client });
    await vi.waitFor(() => expect(vm.getSnapshot().state).not.toBe("loading"));
    return vm;
}

describe("DesktopProfileEditorViewModel", () => {
    beforeEach(() => {
        URL.createObjectURL = vi.fn(() => "blob:preview");
        URL.revokeObjectURL = vi.fn();
        window.localStorage.clear();
    });

    describe("showing a cached profile", () => {
        function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
            let resolve!: (value: T) => void;
            const promise = new Promise<T>((r) => (resolve = r));
            return { promise, resolve };
        }

        it("is ready at once from the last known profile, then follows the server", async () => {
            const read = deferred<Record<string, unknown>>();
            const client = makeClient({}, { getExtendedProfile: vi.fn(() => read.promise) });
            RichProfileStore.forClient(client).set(ME, { displayname: "Old" });

            const vm = new DesktopProfileEditorViewModel({ client });
            expect(vm.getSnapshot()).toMatchObject({ state: "ready", dirty: false });
            expect(vm.getSnapshot().draft.displayName).toBe("Old");

            read.resolve({ displayname: "New" });
            await vi.waitFor(() => expect(vm.getSnapshot().draft.displayName).toBe("New"));
            expect(vm.getSnapshot().dirty).toBe(false);
        });

        it("keeps what the person typed while the fresh profile was on its way", async () => {
            const read = deferred<Record<string, unknown>>();
            const client = makeClient({}, { getExtendedProfile: vi.fn(() => read.promise) });
            RichProfileStore.forClient(client).set(ME, { displayname: "Old", [BIO_FIELD_MSC4440]: "a" });

            const vm = new DesktopProfileEditorViewModel({ client });
            vm.update({ displayName: "Typed" });
            read.resolve({ displayname: "Elsewhere", [BIO_FIELD_MSC4440]: { "m.text": [{ body: "b" }] } });

            await vi.waitFor(() => expect(vm.getSnapshot().draft.bio).toBe("b"));
            expect(vm.getSnapshot().draft.displayName).toBe("Typed");
            expect(vm.getSnapshot().dirty).toBe(true);
        });

        it("waits for the fresh profile before saving, so it never writes from a stale copy", async () => {
            const read = deferred<Record<string, unknown>>();
            const client = makeClient({}, { getExtendedProfile: vi.fn(() => read.promise) });
            RichProfileStore.forClient(client).set(ME, { displayname: "Old" });

            const vm = new DesktopProfileEditorViewModel({ client });
            vm.update({ displayName: "Typed" });
            const saving = vm.save();
            await Promise.resolve();
            expect(client.setDisplayName).not.toHaveBeenCalled();

            read.resolve({ displayname: "Old" });
            await saving;
            expect(client.setDisplayName).toHaveBeenCalledWith("Typed");
        });

        it("keeps a nameplate image chosen while the fresh profile was on its way", async () => {
            const read = deferred<Record<string, unknown>>();
            const client = makeClient({}, { getExtendedProfile: vi.fn(() => read.promise) });
            RichProfileStore.forClient(client).set(ME, {
                [RICH_PROFILE_FIELD]: { nameplate: { mxc: "mxc://example.org/old-plate" } },
            });

            const vm = new DesktopProfileEditorViewModel({ client });
            await vm.chooseNameplateImage(new File(["x"], "plate.png", { type: "image/png" }));
            read.resolve({});
            await vi.waitFor(() => expect(client.getExtendedProfile).toHaveBeenCalled());
            await Promise.resolve();
            expect(vm.getSnapshot().draft.hasNameplateImage).toBe(true);

            await vm.save();
            expect(client.uploadContent).toHaveBeenCalled();
            expect(client.setExtendedProfileProperty).toHaveBeenCalledWith(
                RICH_PROFILE_FIELD,
                expect.objectContaining({ nameplate: { mxc: "mxc://example.org/uploaded" } }),
            );
        });

        it("merges an edited link with links added on another device", async () => {
            const read = deferred<Record<string, unknown>>();
            const client = makeClient({}, { getExtendedProfile: vi.fn(() => read.promise) });
            const a = { label: "A", url: "https://a.example.org/" };
            const b = { label: "B", url: "https://b.example.org/" };
            RichProfileStore.forClient(client).set(ME, { [RICH_PROFILE_FIELD]: { links: [a] } });

            const vm = new DesktopProfileEditorViewModel({ client });
            vm.updateLink(vm.getSnapshot().draft.links[0].id, { label: "A, renamed" });
            read.resolve({ [RICH_PROFILE_FIELD]: { links: [a, b] } });

            await vi.waitFor(() => expect(vm.getSnapshot().draft.links).toHaveLength(2));
            expect(vm.getSnapshot().draft.links.map(({ label, url }) => ({ label, url }))).toEqual([
                { label: "A, renamed", url: a.url },
                b,
            ]);
        });

        it("leaves the name alone when the fresh read shows the server now manages it", async () => {
            const read = deferred<Record<string, unknown>>();
            const client = makeClient(
                {},
                {
                    getExtendedProfile: vi.fn(() => read.promise),
                    getCapabilities: vi
                        .fn()
                        .mockResolvedValue({ "m.profile_fields": { enabled: true, disallowed: ["displayname"] } }),
                },
            );
            RichProfileStore.forClient(client).set(ME, { displayname: "Old" });

            const vm = new DesktopProfileEditorViewModel({ client });
            vm.update({ displayName: "Typed", bio: "New bio" });
            read.resolve({ displayname: "Old" });
            await vm.save();

            expect(client.setDisplayName).not.toHaveBeenCalled();
            expect(client.setExtendedProfileProperty).toHaveBeenCalled();
            expect(vm.getSnapshot().error).toBeUndefined();
        });

        it("stays usable when the fresh read fails, and reads again before saving", async () => {
            const getExtendedProfile = vi
                .fn()
                .mockRejectedValueOnce(new Error("offline"))
                .mockResolvedValue({ displayname: "Old" });
            const client = makeClient({}, { getExtendedProfile });
            RichProfileStore.forClient(client).set(ME, { displayname: "Old" });

            const vm = new DesktopProfileEditorViewModel({ client });
            await vi.waitFor(() => expect(getExtendedProfile).toHaveBeenCalledTimes(1));
            await Promise.resolve();
            expect(vm.getSnapshot().state).toBe("ready");

            vm.update({ displayName: "Typed" });
            await vm.save();
            expect(getExtendedProfile).toHaveBeenCalledTimes(2);
            expect(client.setDisplayName).toHaveBeenCalledWith("Typed");
        });
    });

    describe("loading", () => {
        it("reports a server without custom profile fields", async () => {
            const vm = await ready(
                makeClient({}, { doesServerSupportExtendedProfiles: vi.fn().mockResolvedValue(false) }),
            );
            expect(vm.getSnapshot().state).toBe("unsupported");
        });

        it.each([
            [{ "m.profile_fields": { enabled: false } }],
            [{ "m.profile_fields": { enabled: true, allowed: ["displayname"] } }],
            [{ "m.profile_fields": { enabled: true, disallowed: [RICH_PROFILE_FIELD] } }],
        ])("is read-only when the server says so: %j", async (capabilities) => {
            const vm = await ready(makeClient({}, { getCapabilities: vi.fn().mockResolvedValue(capabilities) }));
            expect(vm.getSnapshot().state).toBe("read_only");
        });

        it("respects servers that manage the name or avatar", async () => {
            const vm = await ready(
                makeClient(
                    {},
                    {
                        getCapabilities: vi
                            .fn()
                            .mockResolvedValue({ "m.profile_fields": { enabled: true, disallowed: ["displayname"] } }),
                    },
                ),
            );
            expect(vm.getSnapshot()).toMatchObject({ state: "ready", canSetDisplayName: false, canSetAvatar: true });
        });

        it("fills the draft from what is stored, and starts clean", async () => {
            const vm = await ready(
                makeClient({
                    displayname: "Me",
                    [BANNER_FIELD]: "mxc://example.org/b",
                    [BIO_FIELD_MSC4440]: { "m.text": [{ body: "Hello" }] },
                    [RICH_PROFILE_FIELD]: { decoration: "halo", links: [{ label: "x", url: "https://example.org/" }] },
                }),
            );
            const snapshot = vm.getSnapshot();
            expect(snapshot.draft).toMatchObject({ displayName: "Me", bio: "Hello", decoration: "halo" });
            expect(snapshot.draft.links).toHaveLength(1);
            expect(snapshot.hasBanner).toBe(true);
            expect(snapshot.preview.appearance?.bannerUrl).toBe("http://thumb/mxc://example.org/b");
            expect(snapshot.dirty).toBe(false);
        });
    });

    describe("editing", () => {
        it("shows changes in the preview without saving anything", async () => {
            const client = makeClient({ displayname: "Me" });
            const vm = await ready(client);
            vm.update({ bio: "New", decoration: "orbit", theme: { primary: "#000000", accent: "#111111" } });
            const { preview, dirty } = vm.getSnapshot();
            expect(preview.bio).toBe("New");
            expect(preview.appearance).toMatchObject({ decoration: "orbit", theme: { primary: "#000000" } });
            expect(dirty).toBe(true);
            expect(client.setExtendedProfileProperty).not.toHaveBeenCalled();
        });

        it("is clean again once a change is undone", async () => {
            const vm = await ready(makeClient({ displayname: "Me" }));
            vm.update({ bio: "New" });
            expect(vm.getSnapshot().dirty).toBe(true);
            vm.update({ bio: "" });
            expect(vm.getSnapshot().dirty).toBe(false);
        });

        it("reset discards the draft and any chosen images", async () => {
            const vm = await ready(makeClient({ displayname: "Me" }));
            vm.update({ bio: "New" });
            await vm.chooseBanner(new File(["x"], "b.png", { type: "image/png" }));
            vm.reset();
            expect(vm.getSnapshot()).toMatchObject({ dirty: false, hasBanner: false, draft: { bio: "" } });
            expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
        });

        it("previews a chosen image straight away and uploads nothing yet", async () => {
            const client = makeClient({});
            const vm = await ready(client);
            await vm.chooseBanner(new File(["x"], "b.png", { type: "image/png" }));
            expect(vm.getSnapshot().preview.appearance?.bannerUrl).toBe("blob:preview");
            expect(client.uploadContent).not.toHaveBeenCalled();
        });

        it.each([
            [new File(["x"], "evil.svg", { type: "image/svg+xml" }), /PNG, JPEG/],
            [new File(["x"], "notes.txt", { type: "text/plain" }), /PNG, JPEG/],
        ])("refuses an unsuitable file", async (file, message) => {
            const vm = await ready(makeClient({}));
            await vm.chooseBanner(file);
            expect(vm.getSnapshot().error).toMatch(message);
            expect(vm.getSnapshot().hasBanner).toBe(false);
        });

        it("refuses an image that is too large", async () => {
            const vm = await ready(makeClient({}));
            const huge = new File(["x"], "b.png", { type: "image/png" });
            Object.defineProperty(huge, "size", { value: 11 * 1024 * 1024 });
            await vm.chooseAvatar(huge);
            expect(vm.getSnapshot().error).toMatch(/10 MB/);
        });

        it("lets the person frame an avatar and a banner before using them", async () => {
            const vm = await ready(makeClient({}));
            const avatar = new File(["x"], "a.png", { type: "image/png" });
            const banner = new File(["x"], "b.png", { type: "image/png" });
            await vm.chooseAvatar(avatar);
            await vm.chooseBanner(banner);
            expect(editImage).toHaveBeenCalledWith(avatar, "avatar");
            expect(frameImage).toHaveBeenCalledWith(banner, "banner");
            expect(vm.getSnapshot()).toMatchObject({ hasAvatar: true, hasBanner: true });
        });

        it("keeps the old image when the person cancels framing", async () => {
            const vm = await ready(makeClient({}));
            vi.mocked(editImage).mockResolvedValueOnce(undefined);
            await vm.chooseAvatar(new File(["x"], "a.png", { type: "image/png" }));
            expect(vm.getSnapshot()).toMatchObject({ hasAvatar: false, error: undefined });
        });

        it("refuses an unsuitable file before offering to frame it", async () => {
            const vm = await ready(makeClient({}));
            vi.mocked(editImage).mockClear();
            await vm.chooseAvatar(new File(["x"], "evil.svg", { type: "image/svg+xml" }));
            expect(editImage).not.toHaveBeenCalled();
        });

        it("flags an unusable link and will not save it", async () => {
            const client = makeClient({});
            const vm = await ready(client);
            vm.addLink();
            const { id } = vm.getSnapshot().draft.links[0];
            vm.updateLink(id, { label: "x", url: "javascript:alert(1)" });
            expect(vm.getSnapshot().draft.links[0].invalid).toBe(true);
            await vm.save();
            expect(vm.getSnapshot().error).toMatch(/valid web address/);
            expect(client.setExtendedProfileProperty).not.toHaveBeenCalled();
        });

        it("stops adding links and board items at the limit", async () => {
            const vm = await ready(makeClient({}));
            for (let i = 0; i < 10; i++) vm.addLink();
            for (let i = 0; i < 12; i++) vm.addBoardItem(new File(["x"], "a.png", { type: "image/png" }));
            expect(vm.getSnapshot().draft.links).toHaveLength(6);
            expect(vm.getSnapshot().draft.board).toHaveLength(8);
        });

        it("surprise produces a stored-format colour every time", async () => {
            const vm = await ready(makeClient({}));
            for (let i = 0; i < 20; i++) {
                vm.surpriseName();
                const { colour, colourEnd } = vm.getSnapshot().draft.nameStyle;
                expect(colour).toMatch(/^#[0-9a-f]{6}$/);
                expect(colourEnd).toMatch(/^#[0-9a-f]{6}$/);
            }
        });

        it("reports a draft too large to store", async () => {
            const vm = await ready(makeClient({}));
            vm.addBoardItem(new File(["x"], "a.png", { type: "image/png" }));
            const { id } = vm.getSnapshot().draft.board[0];
            vm.updateBoardItem(id, { title: "x".repeat(40 * 1024) });
            expect(vm.getSnapshot().tooLarge).toBe(true);
        });
    });

    describe("saving", () => {
        it("writes only what changed and goes back to clean", async () => {
            const client = makeClient({ displayname: "Me" });
            const vm = await ready(client);
            vm.update({ decoration: "halo" });
            await vm.save();
            expect(client.setExtendedProfileProperty).toHaveBeenCalledTimes(1);
            expect(client.setExtendedProfileProperty).toHaveBeenCalledWith(RICH_PROFILE_FIELD, {
                v: 1,
                decoration: "halo",
            });
            expect(client.setDisplayName).not.toHaveBeenCalled();
            expect(client.setAvatarUrl).not.toHaveBeenCalled();
            expect(vm.getSnapshot()).toMatchObject({ dirty: false, saved: true, saving: false });
        });

        it("makes the change visible to the rest of the app at once", async () => {
            const client = makeClient({ displayname: "Me" });
            const vm = await ready(client);
            vm.update({ decoration: "halo" });
            await vm.save();
            expect(RichProfileStore.forClient(client).get(ME)?.decoration).toBe("halo");
        });

        it("uploads a chosen banner and marks a GIF as animated", async () => {
            const client = makeClient({});
            const vm = await ready(client);
            await vm.chooseBanner(new File(["x"], "b.gif", { type: "image/gif" }));
            await vm.save();
            expect(client.uploadContent).toHaveBeenCalledTimes(1);
            expect(client.setExtendedProfileProperty).toHaveBeenCalledWith(BANNER_FIELD, "mxc://example.org/uploaded");
            expect(client.setExtendedProfileProperty).toHaveBeenCalledWith(
                RICH_PROFILE_FIELD,
                expect.objectContaining({ banner_animated: true }),
            );
        });

        it("keeps an animated banner moving and stores where to frame it", async () => {
            const client = makeClient({});
            const vm = await ready(client);
            const frame = { x: 0, y: 0.123456, width: 1, height: 0.5 };
            const gif = new File(["x"], "b.gif", { type: "image/gif" });
            vi.mocked(frameImage).mockResolvedValueOnce({ file: gif, frame });
            await vm.chooseBanner(gif);
            expect(vm.getSnapshot().preview.appearance?.bannerFrame).toEqual(frame);
            await vm.save();
            expect(client.uploadContent).toHaveBeenCalledWith(gif);
            expect(client.setExtendedProfileProperty).toHaveBeenCalledWith(
                RICH_PROFILE_FIELD,
                expect.objectContaining({
                    banner_animated: true,
                    banner_frame: { x: 0, y: 0.1235, width: 1, height: 0.5 },
                }),
            );
            // Once saved, the preview plays the original rather than a still thumbnail of it.
            expect(vm.getSnapshot().preview.appearance?.bannerAnimatedUrl).toBe(
                "http://media/mxc://example.org/uploaded",
            );
        });

        it("marks an animated nameplate image so rows can play it", async () => {
            const client = makeClient({});
            const vm = await ready(client);
            await vm.chooseNameplateImage(new File(["x"], "n.gif", { type: "image/gif" }));
            await vm.save();
            expect(client.setExtendedProfileProperty).toHaveBeenCalledWith(
                RICH_PROFILE_FIELD,
                expect.objectContaining({ nameplate: { mxc: "mxc://example.org/uploaded", animated: true } }),
            );
        });

        it("removes a banner", async () => {
            const client = makeClient({ [BANNER_FIELD]: "mxc://example.org/b" });
            const vm = await ready(client);
            vm.removeBanner();
            await vm.save();
            expect(client.deleteExtendedProfileProperty).toHaveBeenCalledWith(BANNER_FIELD);
        });

        it("marks an animated avatar so only that exact image plays", async () => {
            const client = makeClient({});
            const vm = await ready(client);
            await vm.chooseAvatar(new File(["x"], "a.gif", { type: "image/gif" }));
            await vm.save();
            expect(client.setAvatarUrl).toHaveBeenCalledWith("mxc://example.org/uploaded");
            expect(client.setExtendedProfileProperty).toHaveBeenCalledWith(
                RICH_PROFILE_FIELD,
                expect.objectContaining({ animated_avatar: "mxc://example.org/uploaded" }),
            );
        });

        it("sets and clears the status", async () => {
            const client = makeClient({});
            const vm = await ready(client);
            vm.update({ statusText: "Busy" });
            await vm.save();
            expect(client.setExtendedProfileProperty).toHaveBeenCalledWith(
                STATUS_FIELD,
                expect.objectContaining({ text: "Busy" }),
            );
            vm.update({ statusText: "" });
            await vm.save();
            expect(client.deleteExtendedProfileProperty).toHaveBeenCalledWith(STATUS_FIELD);
            expect(client.setExtendedProfileProperty).not.toHaveBeenCalledWith(STATUS_FIELD, null);
            expect(vm.getSnapshot()).toMatchObject({ dirty: false, saved: true, error: undefined });
        });

        it("keeps the draft on failure, says why, and a retry only finishes the rest", async () => {
            const setExtendedProfileProperty = vi
                .fn()
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(new MatrixError({ errcode: "M_FORBIDDEN" }, 403))
                .mockResolvedValue(undefined);
            const client = makeClient({}, { setExtendedProfileProperty });
            const vm = await ready(client);
            await vm.chooseBanner(new File(["x"], "b.png", { type: "image/png" }));
            vm.update({ bio: "Hello", decoration: "halo" });
            await vm.save();
            expect(vm.getSnapshot()).toMatchObject({ dirty: true, saving: false, draft: { bio: "Hello" } });
            expect(vm.getSnapshot().error).toMatch(/does not allow/);
            await vm.save();
            expect(vm.getSnapshot().error).toBeUndefined();
            expect(vm.getSnapshot().dirty).toBe(false);
            // The banner uploaded the first time and must not upload again.
            expect(client.uploadContent).toHaveBeenCalledTimes(1);
            const keys = setExtendedProfileProperty.mock.calls.map(([key]) => key);
            expect(keys.filter((key) => key === RICH_PROFILE_FIELD)).toHaveLength(1);
        });

        it.each([
            ["M_PROFILE_TOO_LARGE", /larger than your homeserver allows/],
            ["M_LIMIT_EXCEEDED", /slow down/],
            ["M_UNKNOWN", /could not be saved/],
        ])("explains %s", async (errcode, message) => {
            const client = makeClient(
                {},
                {
                    setExtendedProfileProperty: vi
                        .fn()
                        .mockRejectedValue(new MatrixError({ errcode, retry_after_ms: 60000 }, 400)),
                },
            );
            const vm = await ready(client);
            vm.update({ decoration: "halo" });
            await vm.save();
            expect(vm.getSnapshot().error).toMatch(message);
        });

        it("waits out one short rate limit instead of failing", async () => {
            const setExtendedProfileProperty = vi
                .fn()
                .mockRejectedValueOnce(new MatrixError({ errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 1 }, 429))
                .mockResolvedValue(undefined);
            const client = makeClient({}, { setExtendedProfileProperty });
            const vm = await ready(client);
            vm.update({ decoration: "halo" });
            await vm.save();
            expect(setExtendedProfileProperty).toHaveBeenCalledTimes(2);
            expect(vm.getSnapshot().saved).toBe(true);
        });

        it("skips fields the server manages rather than failing the save", async () => {
            const client = makeClient(
                {},
                {
                    getCapabilities: vi
                        .fn()
                        .mockResolvedValue({ "m.profile_fields": { enabled: true, disallowed: [BIO_FIELD_MSC4440] } }),
                },
            );
            const vm = await ready(client);
            vm.update({ bio: "Hello" });
            await vm.save();
            const keys = vi.mocked(client.setExtendedProfileProperty).mock.calls.map(([key]) => key);
            expect(keys).not.toContain(BIO_FIELD_MSC4440);
            expect(vm.getSnapshot().error).toBeUndefined();
        });

        it("ignores a second press while saving", async () => {
            const client = makeClient({});
            const vm = await ready(client);
            vm.update({ decoration: "halo" });
            await Promise.all([vm.save(), vm.save()]);
            expect(client.setExtendedProfileProperty).toHaveBeenCalledTimes(1);
        });
    });

    it("releases image previews when the tab closes", async () => {
        const vm = await ready(makeClient({}));
        await vm.chooseBanner(new File(["x"], "b.png", { type: "image/png" }));
        vm.dispose();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
    });
});
