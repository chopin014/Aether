/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { readFile } from "node:fs/promises";
import {
    closeReleaseAnnouncementIfExists,
    rejectToastIfExists,
    populateLocalStorageWithCredentials,
    routeConfigJson,
} from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";
import { ElementAppPage } from "../../pages/ElementAppPage";

test.use({
    matrixRTC: true,
    lockLeftPanelWidth: false,
    displayName: "Alice",
    permissions: ["microphone", "camera"],
    config: {
        default_theme: "dark",
        features: {
            feature_desktop_shell: true,
            feature_video_rooms: true,
            feature_element_call_video_rooms: true,
            feature_element_call_react: true,
        },
        element_call: { disable: false, use_exclusively: true },
    },
});

test("browses Space avatars and uploads a sound from the dock and call toolbar", async ({ page, app, user }, info) => {
    test.setTimeout(120_000);
    await rejectToastIfExists(page, "Verify this device");
    await rejectToastIfExists(page, "Notifications");
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
    const roomId = await app.client.createRoom({
        name: "Lounge",
        creation_content: { type: "org.matrix.msc3417.call" },
    });
    const { content_uri: avatar } = await app.client.uploadContent(
        await readFile("playwright/sample-files/element.png"),
        {
            type: "image/png",
        },
    );
    const { content_uri: soundUrl } = await app.client.uploadContent(
        await readFile("res/media/aether/soundboard-quack.wav"),
        { type: "audio/wav" },
    );
    const customSound = { name: "Welcome", emoji: "👋", url: soundUrl, duration_ms: 550 };
    await app.client.createSpace({
        name: "Other server",
        initial_state: [
            {
                type: "io.aether.soundboard.sound",
                state_key: "elsewhere",
                content: { ...customSound, name: "From another Space" },
            },
        ],
    });
    await app.client.createSpace({ name: "Empty server" });
    const spaceId = await app.client.createSpace({
        name: "The Hangout",
        initial_state: [
            { type: "m.room.avatar", state_key: "", content: { url: avatar } },
            { type: "m.space.child", state_key: roomId, content: { via: [user.homeServer] } },
            { type: "io.aether.soundboard.sound", state_key: "welcome", content: customSound },
        ],
    });
    await app.viewSpaceByName("The Hangout");
    await page.getByRole("button", { name: "Open room Lounge", exact: true }).click();
    const dock = page.getByRole("group", { name: "User menu" });
    await expect(dock.getByText("Voice Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
    const trigger = dock.getByRole("button", { name: "Soundboard", exact: true });
    await expect(trigger.locator("svg")).toBeVisible();
    await trigger.click();
    const picker = page.getByRole("dialog", { name: "Soundboard", exact: true });
    await expect(picker.getByRole("button", { name: "View all" })).toHaveCount(0);
    await expect(picker.getByRole("searchbox")).toBeFocused();
    const libraries = picker.getByRole("navigation", { name: "Sound library" });
    await expect(libraries.getByRole("button")).toHaveCount(4);
    expect(
        await libraries
            .getByRole("button")
            .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))),
    ).toEqual(["All sounds", "Aether sounds", "The Hangout", "Other server"]);
    await expect(picker.getByRole("button", { name: "Empty server", exact: true })).toHaveCount(0);
    const server = picker.getByRole("button", { name: "The Hangout", exact: true });
    await expect(server.locator("img")).toBeVisible();
    await server.click();
    await expect(picker.getByText("Aether sounds", { exact: true })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Cricket", exact: true })).toBeVisible();
    await picker.getByRole("button", { name: "All sounds", exact: true }).click();
    await page.screenshot({ path: info.outputPath("soundboard-default.png") });
    await picker.locator("summary").filter({ hasText: "Upload a sound" }).click();
    await expect(picker.getByText("Preview or trim audio to 10 seconds.", { exact: false })).toBeVisible();
    await picker.getByRole("combobox", { name: "Sound library" }).selectOption(spaceId);
    await expect(picker.getByRole("option", { name: "Empty server", exact: true })).toHaveCount(1);
    await picker.getByRole("textbox", { name: "Sound name", exact: true }).fill("Hello everyone");
    const emojiButton = picker.getByRole("button", { name: "Emoji", exact: true });
    await emojiButton.click();
    const emojiPicker = picker.getByRole("dialog", { name: "Emoji", exact: true });
    await emojiPicker.getByRole("textbox", { name: "Search", exact: true }).fill("duck");
    await page.screenshot({ path: info.outputPath("soundboard-emoji-picker.png") });
    await emojiPicker.getByRole("button", { name: "🦆", exact: true }).click();
    await expect(emojiButton).toHaveText("🦆");
    await expect(emojiButton).toBeFocused();
    await emojiButton.click();
    await page.keyboard.press("Escape");
    await expect(emojiPicker).toHaveCount(0);
    await expect(picker).toBeVisible();
    await page.screenshot({ path: info.outputPath("soundboard-upload.png") });
    // Observe actual audio readiness and playback, including detached soundboard audio elements.
    await page.evaluate(() => {
        const timing = { ready: false, clicked: 0, playing: 0 };
        Object.defineProperty(window, "__soundboardTiming", { value: timing });
        const load = HTMLMediaElement.prototype.load;
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.load = function () {
            if (!this.srcObject && this.src.startsWith("blob:")) {
                this.addEventListener(
                    "canplaythrough",
                    () => {
                        timing.ready = true;
                    },
                    { once: true },
                );
            }
            return load.call(this);
        };
        HTMLMediaElement.prototype.play = function () {
            if (!this.srcObject && this.src.startsWith("blob:")) {
                this.addEventListener(
                    "playing",
                    () => {
                        timing.playing = performance.now();
                    },
                    { once: true },
                );
            }
            return play.call(this);
        };
    });
    // A source longer than the upload limit must stay local until a selection is confirmed.
    const audio = Buffer.alloc(44 + 8000 * 20 * 2);
    audio.write("RIFF", 0);
    audio.writeUInt32LE(audio.length - 8, 4);
    audio.write("WAVEfmt ", 8);
    audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20);
    audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(8000, 24);
    audio.writeUInt32LE(16000, 28);
    audio.writeUInt16LE(2, 32);
    audio.writeUInt16LE(16, 34);
    audio.write("data", 36);
    audio.writeUInt32LE(audio.length - 44, 40);
    for (let i = 0; i < 160000; i++)
        audio.writeInt16LE(Math.round(1000 * Math.sin((2 * Math.PI * 440 * i) / 8000)), 44 + i * 2);
    await picker.getByLabel("Upload a sound", { exact: true }).setInputFiles({
        name: "twenty-seconds.wav",
        mimeType: "audio/wav",
        buffer: audio,
    });
    const editor = picker.getByRole("region", { name: "Preview and trim audio" });
    await expect(editor).toBeVisible();
    await expect(editor.getByText("0:20.0", { exact: true })).toBeVisible();
    const position = editor.getByRole("slider", { name: "Selection position", exact: true });
    await position.focus();
    await page.keyboard.press("Shift+ArrowRight");
    await expect(position).toHaveAttribute("aria-valuenow", "1");
    const box = await position.boundingBox();
    if (!box) throw new Error("Waveform selection not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + box.width / 2, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => Number(await position.getAttribute("aria-valuenow"))).toBeGreaterThan(5);
    await editor.getByRole("button", { name: "Play selected audio" }).click();
    await expect(editor.getByRole("button", { name: "Stop audio preview" })).toBeVisible();
    await editor.getByRole("button", { name: "Stop audio preview" }).click();
    await page.screenshot({ path: info.outputPath("soundboard-trim.png") });
    await editor.getByRole("button", { name: "Upload sound", exact: true }).click();
    await picker.getByRole("searchbox").fill("Hello everyone");
    await expect(picker.getByRole("button", { name: "Hello everyone", exact: true })).toBeVisible();
    await expect
        .poll(() =>
            app.client.evaluate(
                (client, id) => client.getRoom(id)?.currentState.getStateEvents("io.aether.soundboard.sound").length,
                spaceId,
            ),
        )
        .toBe(2);
    expect(
        await app.client.evaluate(
            (client, id) =>
                client
                    .getRoom(id)
                    ?.currentState.getStateEvents("io.aether.soundboard.sound")
                    .find((event) => event.getContent().name === "Hello everyone")
                    ?.getContent().duration_ms,
            spaceId,
        ),
    ).toBe(10_000);
    const timing = () =>
        page.evaluate(
            () =>
                (
                    window as Window & {
                        __soundboardTiming?: { ready: boolean; clicked: number; playing: number };
                    }
                ).__soundboardTiming!,
        );
    await expect.poll(async () => (await timing()).ready).toBe(true);
    const uploadedSound = picker.getByRole("button", { name: "Hello everyone", exact: true });
    await uploadedSound.evaluate((button) =>
        button.addEventListener(
            "click",
            () => {
                (window as Window & { __soundboardTiming?: { clicked: number } }).__soundboardTiming!.clicked =
                    performance.now();
            },
            { capture: true },
        ),
    );
    let matrixSends = 0;
    // A rate-limited homeserver must not affect solo sound testing: no playback event should be sent at all.
    await page.route(/\/rooms\/[^/]+\/send\//, async (route) => {
        matrixSends++;
        await route.fulfill({
            status: 429,
            json: { errcode: "M_LIMIT_EXCEEDED", error: "Too Many Requests", retry_after_ms: 10000 },
        });
    });
    await uploadedSound.click();
    await expect.poll(async () => (await timing()).playing).toBeGreaterThan(0);
    const measured = await timing();
    const delay = measured.playing - measured.clicked;
    console.log(`Solo soundboard click to media playing: ${delay.toFixed(1)} ms; Matrix sends: ${matrixSends}`);
    expect(delay).toBeLessThan(250);
    expect(matrixSends).toBe(0);
    await expect(picker.getByRole("alert")).toHaveCount(0);
    const beforeEdit = await app.client.evaluate(
        (client, id) =>
            client
                .getRoom(id)!
                .currentState.getStateEvents("io.aether.soundboard.sound")
                .find((event) => event.getContent().name === "Hello everyone")!
                .getStateKey(),
        spaceId,
    );
    await uploadedSound.hover();
    await picker.getByRole("button", { name: "Edit Hello everyone", exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(picker.getByRole("textbox", { name: "Sound name", exact: true })).toHaveValue("Hello everyone");
    await expect(emojiButton).toHaveText("🦆");
    await picker.getByRole("textbox", { name: "Sound name", exact: true }).fill("Edited greeting");
    await editor.getByRole("slider", { name: "Selection end", exact: true }).focus();
    await page.keyboard.press("Shift+ArrowLeft");
    await editor.getByRole("slider", { name: "Sound volume", exact: false }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(editor.getByText("99%", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("soundboard-edit.png") });
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect
        .poll(() =>
            app.client.evaluate(
                (client, { id, key }) => {
                    const events = client.getRoom(id)!.currentState.getStateEvents("io.aether.soundboard.sound");
                    return {
                        count: events.length,
                        sound: events.find((event) => event.getStateKey() === key)?.getContent(),
                    };
                },
                { id: spaceId, key: beforeEdit },
            ),
        )
        .toMatchObject({ count: 2, sound: { name: "Edited greeting", emoji: "🦆", duration_ms: 9000 } });
    await picker.getByRole("searchbox").fill("Edited greeting");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await page.getByTestId("aether-call-stage").getByRole("button", { name: "Soundboard", exact: true }).click();
    await expect(picker.getByRole("searchbox")).toBeFocused();
    await expect(picker.getByRole("button", { name: "Edited greeting", exact: true })).toBeVisible();
    await picker.getByRole("searchbox").fill("");
    await page.screenshot({ path: info.outputPath("soundboard-call-toolbar.png") });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1024, height: 768 });
    await trigger.click();
    await page.screenshot({ path: info.outputPath("soundboard-narrow.png") });
    // Observe native media playback to verify overlapping clips and restarting a cached clip.
    await page.evaluate(() => {
        const clips = new Map<HTMLMediaElement, number>();
        Object.defineProperty(window, "__soundboardClips", { value: clips });
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
            if (!this.srcObject) clips.set(this, (clips.get(this) ?? 0) + 1);
            return play.call(this);
        };
    });
    const clips = () =>
        page.evaluate(() => {
            const tracked = (window as Window & { __soundboardClips?: Map<HTMLMediaElement, number> })
                .__soundboardClips!;
            return [...tracked].map(([audio, starts]) => ({ starts, paused: audio.paused, time: audio.currentTime }));
        });
    const airhorn = picker.getByRole("button", { name: "Airhorn", exact: true }).first();
    await airhorn.click();
    await picker.getByRole("button", { name: "Sad horn", exact: true }).first().click();
    await expect.poll(async () => (await clips()).filter((clip) => !clip.paused).length).toBe(2);
    await expect.poll(async () => (await clips())[0].time).toBeGreaterThan(0.2);
    await airhorn.click();
    const restarted = await clips();
    expect(restarted).toHaveLength(2);
    expect(restarted[0]).toMatchObject({ starts: 2, paused: false });
    expect(restarted[0].time).toBeLessThan(0.2);
    expect(restarted[1]).toMatchObject({ starts: 1, paused: false });
    await picker.getByRole("button", { name: "From another Space", exact: true }).click();
    expect(matrixSends).toBe(0);
    await expect(picker.getByRole("alert")).toHaveCount(0);
});

test("keeps the sidebar upload open while viewing a text channel", async ({ page, app, user }, info) => {
    test.setTimeout(120_000);
    await rejectToastIfExists(page, "Verify this device");
    await rejectToastIfExists(page, "Notifications");
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
    const voiceId = await app.client.createRoom({
        name: "Lounge",
        creation_content: { type: "org.matrix.msc3417.call" },
    });
    const textId = await app.client.createRoom({ name: "chat" });
    await app.client.createSpace({
        name: "The Hangout",
        initial_state: [voiceId, textId].map((id) => ({
            type: "m.space.child",
            state_key: id,
            content: { via: [user.homeServer] },
        })),
    });
    await app.viewSpaceByName("The Hangout");
    await page.getByRole("button", { name: "Open room Lounge", exact: true }).click();
    const dock = page.getByRole("group", { name: "User menu" });
    await expect(dock.getByText("Voice Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Open room chat", exact: true }).click();
    const composer = page.getByRole("region", { name: "Message composer" }).getByRole("textbox");
    await expect(composer).toBeVisible();
    await dock.getByRole("button", { name: "Soundboard", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Soundboard", exact: true });
    await picker.locator("summary").filter({ hasText: "Upload a sound" }).click();
    await page.evaluate(() => {
        const decode = AudioContext.prototype.decodeAudioData;
        AudioContext.prototype.decodeAudioData = async function (data) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return decode.call(this, data);
        };
    });
    const chooserOpened = page.waitForEvent("filechooser");
    await picker.getByText("Choose audio", { exact: true }).click();
    const chooser = await chooserOpened;
    // Returning from a native file dialog can restore the text composer's focus before the change event.
    await composer.focus();
    await expect(picker).toBeVisible();
    await chooser.setFiles("res/media/aether/soundboard-quack.wav");
    await expect(picker.getByRole("region", { name: "Preview and trim audio" })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Play selected audio", exact: true })).toBeFocused();
    await expect(dock.getByText("Voice Connected", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("soundboard-text-channel-upload.png") });
    await picker.getByRole("button", { name: "Upload sound", exact: true }).click();
    await expect(picker.getByRole("region", { name: "Preview and trim audio" })).toHaveCount(0);
    await expect(picker.getByRole("button", { name: "soundboard-quack", exact: true })).toBeVisible();
});

test("delivers repeated sounds over the encrypted call connection without Matrix message sends", async ({
    page,
    app,
    user,
    browser,
    homeserver,
    config,
}) => {
    test.setTimeout(180_000);
    for (const message of ["Verify this device", "Notifications"]) await rejectToastIfExists(page, message);
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
    const bob = await homeserver.registerUser("bob-soundboard", "password", "Bob");
    const bobContext = await browser.newContext({
        baseURL: new URL(page.url()).origin,
        permissions: ["microphone", "camera"],
    });
    try {
        const bobPage = await bobContext.newPage();
        await routeConfigJson(bobContext, homeserver.baseUrl, config);
        await populateLocalStorageWithCredentials(bobPage, bob);
        await bobPage.goto("/");
        await bobPage.waitForSelector(".mx_MatrixChat");
        for (const message of ["Verify this device", "Notifications"]) await rejectToastIfExists(bobPage, message);
        await closeReleaseAnnouncementIfExists(bobPage, "Introducing Sections");
        const bobApp = new ElementAppPage(bobPage);
        const roomId = await app.client.createRoom({
            name: "Sound studio",
            creation_content: { type: "org.matrix.msc3417.call" },
            power_level_content_override: { events: { "org.matrix.msc3401.call.member": 0 } },
            initial_state: [
                { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
            ],
            invite: [bob.userId],
        });
        const spaceId = await app.client.createSpace({
            name: "Soundboard test",
            initial_state: [{ type: "m.space.child", state_key: roomId, content: { via: [user.homeServer] } }],
            invite: [bob.userId],
        });
        await homeserver.csApi.request("POST", `/v3/join/${roomId}`, bob.accessToken, {});
        await homeserver.csApi.request("POST", `/v3/join/${spaceId}`, bob.accessToken, {});
        await expect
            .poll(() => bobApp.client.evaluate((client, id) => client.getRoom(id)?.getMyMembership(), spaceId))
            .toBe("join");
        await expect
            .poll(() => bobApp.client.evaluate((client, id) => client.getRoom(id)?.getMyMembership(), roomId))
            .toBe("join");
        await app.viewSpaceByName("Soundboard test");
        await bobApp.viewSpaceByName("Soundboard test");
        await page.getByRole("button", { name: "Open room Sound studio", exact: true }).click();
        await bobPage.getByRole("button", { name: "Open room Sound studio", exact: true }).click();
        for (const memberPage of [page, bobPage]) {
            const dock = memberPage.getByRole("group", { name: "User menu" });
            await expect(dock.getByText("Voice Connected", { exact: true })).toBeVisible({ timeout: 60_000 });
            await expect(memberPage.getByTestId("videoTile")).toHaveCount(2, { timeout: 60_000 });
            await dock.getByRole("button", { name: "Soundboard", exact: true }).click();
            await expect(memberPage.getByRole("dialog", { name: "Soundboard" }).getByRole("searchbox")).toBeFocused();
        }
        // Record real soundboard media starts on the receiving client, independently of call track playback.
        await bobPage.evaluate(() => {
            const starts: { source: string; time: number }[] = [];
            Object.defineProperty(window, "__receivedSounds", { value: starts });
            const play = HTMLMediaElement.prototype.play;
            HTMLMediaElement.prototype.play = function () {
                if (this.src && !this.srcObject)
                    this.addEventListener("playing", () => starts.push({ source: this.src, time: Date.now() }), {
                        once: true,
                    });
                return play.call(this);
            };
        });
        let sends = 0;
        for (const memberPage of [page, bobPage])
            await memberPage.route(/\/rooms\/[^/]+\/send\//, async (route) => {
                sends++;
                await route.fulfill({
                    status: 429,
                    json: { errcode: "M_LIMIT_EXCEEDED", error: "Too Many Requests", retry_after_ms: 10000 },
                });
            });
        const picker = page.getByRole("dialog", { name: "Soundboard", exact: true });
        const clicked = Date.now();
        await picker.getByRole("button", { name: "Airhorn", exact: true }).first().click();
        await picker.getByRole("button", { name: "Sad horn", exact: true }).first().click();
        await picker.getByRole("button", { name: "Airhorn", exact: true }).first().click();
        const received = () =>
            bobPage.evaluate(
                () => (window as Window & { __receivedSounds?: { source: string; time: number }[] }).__receivedSounds!,
            );
        await expect.poll(async () => (await received()).length).toBe(3);
        const clips = await received();
        expect(clips[0].source).toBe(clips[2].source);
        expect(clips[1].source).not.toBe(clips[0].source);
        console.log(
            `Remote soundboard media started ${clips[0].time - clicked} ms after clicking; Matrix sends: ${sends}`,
        );
        expect(sends).toBe(0);
        await expect(picker.getByRole("alert")).toHaveCount(0);
        await expect(bobPage.getByRole("dialog", { name: "Soundboard" }).getByRole("alert")).toHaveCount(0);
    } finally {
        await bobContext.close();
    }
});
