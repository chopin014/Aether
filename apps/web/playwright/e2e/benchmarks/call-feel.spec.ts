/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/*
 * How joining and leaving a call looks, sounds and feels, measured on a local homeserver with LiveKit. Every frame
 * records what the user sees (main view, call stage and its phase, the voice panel and its status, who is listed in
 * the voice channel, spinners), every cue that starts playing, and long tasks. It runs only when
 * AETHER_BENCHMARK_CALLS is set:
 *
 *   AETHER_BENCHMARK_CALLS=1 [AETHER_BENCHMARK_OUT=calls.jsonl] [AETHER_BENCHMARK_LATENCY_MS=150] \
 *     [AETHER_BENCHMARK_CALL_SERVICE_MS=1500] pnpm exec playwright test playwright/e2e/benchmarks/call-feel.spec.ts \
 *     --project=Chrome
 *
 * AETHER_BENCHMARK_LATENCY_MS holds every homeserver request, as a server across the internet would. Requests to
 * the call service (LiveKit JWT) are held for AETHER_BENCHMARK_CALL_SERVICE_MS on top, as a busy service would.
 *
 * With AETHER_BENCHMARK_AUDIO=1 and --headed, the "cues out loud" tests play the cues for real during a call and
 * print when each started, so a recording of the output can be checked for crackle, for example with PipeWire:
 *   pactl load-module module-null-sink sink_name=aether_test
 *   parec -d aether_test.monitor --file-format=wav out.wav &   # then run with PULSE_SINK=aether_test
 */

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";

import { type BrowserContext, type Page } from "@playwright/test";
import {
    closeReleaseAnnouncementIfExists,
    populateLocalStorageWithCredentials,
    rejectToastIfExists,
    routeConfigJson,
} from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../element-web-test";
import { ElementAppPage } from "../../pages/ElementAppPage";
import { SettingLevel } from "../../../src/settings/SettingLevel";

const enabled = Boolean(process.env.AETHER_BENCHMARK_CALLS);
const LATENCY_MS = Number(process.env.AETHER_BENCHMARK_LATENCY_MS ?? 0);
const CALL_SERVICE_MS = Number(process.env.AETHER_BENCHMARK_CALL_SERVICE_MS ?? 0);
const OUT = process.env.AETHER_BENCHMARK_OUT;

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
    // Cues are only heard, and recorded, without Chromium's default --mute-audio.
    ...(process.env.AETHER_BENCHMARK_AUDIO
        ? { launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } }
        : {}),
});
test.skip(!enabled, "Set AETHER_BENCHMARK_CALLS=1 to measure how calls feel");
test.skip(({ homeserverType }) => homeserverType !== "synapse", "Needs a real MatrixRTC transport");

/** One recorded moment in the page, in epoch milliseconds. */
interface FeelEvent {
    t: number;
    kind: string;
    [key: string]: unknown;
}

/** Installs the recorder: per-frame UI state, cue playback and long tasks. */
async function installRecorder(page: Page): Promise<void> {
    await page.evaluate(() => {
        const w = window as unknown as { __feel?: { ev: unknown[] } };
        if (w.__feel) return;
        const ev: unknown[] = [];
        let last = "";
        // Clearing starts a new recording with a baseline frame of what is on screen.
        w.__feel = {
            ev,
            reset: (): void => {
                ev.length = 0;
                last = "";
            },
        } as { ev: unknown[] };
        const now = (): number => performance.timeOrigin + performance.now();
        const mark = (kind: string, data: Record<string, unknown> = {}): void =>
            void ev.push({ t: now(), kind, ...data });
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (): Promise<void> {
            const src = this.currentSrc || this.src;
            // Call audio plays a stream, not a file: it is no cue.
            if (!src) return play.call(this);
            mark("cue.play", { src });
            this.addEventListener("playing", () => mark("cue.playing", { src }), { once: true });
            return play.call(this);
        };
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args: Parameters<AudioBufferSourceNode["start"]>): void {
            mark("webaudio.start", { duration: this.buffer?.duration, loop: this.loop });
            start.apply(this, args);
        };
        // Audio lifecycle around the cues: what is opened, stopped and closed while one plays.
        const wrap = <T extends object>(
            proto: T,
            name: string,
            kind: string,
            detail?: (self: never) => unknown,
        ): void => {
            const original = (proto as Record<string, unknown>)[name] as ((...a: unknown[]) => unknown) | undefined;
            if (typeof original !== "function") return;
            (proto as Record<string, unknown>)[name] = function (this: never, ...args: unknown[]): unknown {
                mark(kind, { detail: detail?.(this) });
                return original.apply(this, args);
            };
        };
        wrap(AudioContext.prototype, "close", "audio.ctx.close", (c: AudioContext) => c.sampleRate);
        wrap(AudioContext.prototype, "suspend", "audio.ctx.suspend");
        wrap(AudioContext.prototype, "resume", "audio.ctx.resume");
        wrap(
            MediaStreamTrack.prototype,
            "stop",
            "track.stop",
            (t: MediaStreamTrack) => `${t.kind}:${t.label.slice(0, 20)}`,
        );
        wrap(RTCPeerConnection.prototype, "close", "pc.close");
        wrap(HTMLMediaElement.prototype, "setSinkId", "media.setSinkId");
        wrap(HTMLMediaElement.prototype, "pause", "media.pause", (m: HTMLMediaElement) =>
            m.srcObject ? "stream" : "file",
        );
        const OriginalContext = window.AudioContext;
        window.AudioContext = class extends OriginalContext {
            public constructor(options?: AudioContextOptions) {
                super(options);
                mark("audio.ctx.new", { detail: `${this.sampleRate}/${options?.latencyHint ?? "default"}` });
            }
        };
        const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = (c) => {
            mark("gum", { detail: JSON.stringify(c).slice(0, 80) });
            return gum(c);
        };
        try {
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries())
                    mark("longtask", { start: performance.timeOrigin + entry.startTime, duration: entry.duration });
            }).observe({ type: "longtask" });
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries() as PerformanceEntry[] & { scripts?: unknown[] }[]) {
                    const frame = entry as PerformanceEntry & {
                        blockingDuration: number;
                        scripts: { invoker: string; sourceFunctionName: string; sourceURL: string; duration: number }[];
                    };
                    mark("loaf", {
                        start: performance.timeOrigin + frame.startTime,
                        duration: frame.duration,
                        detail: frame.scripts
                            .slice(0, 6)
                            .map((s) => `${s.invoker}|${s.sourceFunctionName}|${Math.round(s.duration)}`)
                            .join(" ; "),
                    });
                }
            }).observe({ type: "long-animation-frame" });
        } catch {
            // Not every browser reports long tasks.
        }
        document.addEventListener(
            "click",
            (e) => {
                const target = (e.target as Element).closest("[aria-label],button");
                mark("input.click", { label: target?.getAttribute("aria-label") ?? target?.textContent?.slice(0, 40) });
            },
            true,
        );
        const visible = (el: Element | null): boolean =>
            !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
        const probe = (): void => {
            const stage = document.querySelector<HTMLElement>("[data-testid=aether-call-stage]");
            const dock = document.querySelector<HTMLElement>("[data-voice-connected]");
            const voiceRows = [...document.querySelectorAll("[role=group]")]
                .filter((g) => /Lounge/.test(g.getAttribute("aria-label") ?? ""))
                .flatMap((g) =>
                    [...g.querySelectorAll("button")].map(
                        (b) => `${b.getAttribute("aria-label")}@${getComputedStyle(b).opacity}`,
                    ),
                );
            const state = {
                room: location.hash.replace(/^#\/room\//, ""),
                timeline: visible(document.querySelector("[data-testid=timeline]")),
                stage: stage
                    ? {
                          visible: visible(stage),
                          phase: stage.dataset.phase,
                          presentation: stage.dataset.presentation,
                          tiles: stage.querySelectorAll("[data-testid=videoTile]").length,
                          callees: stage.querySelectorAll("[data-testid=callee-tile]").length,
                          lobby: visible(stage.querySelector("[data-testid=call-lobby-card]")),
                          joinButton: visible(stage.querySelector("[data-testid=lobby_joinCall]")),
                      }
                    : null,
                spinners: [...document.querySelectorAll(".mx_Spinner")].filter(visible).length,
                dock: dock
                    ? { tone: dock.dataset.tone, status: dock.querySelector("[role=status]")?.textContent ?? "" }
                    : null,
                voiceRows,
            };
            const s = JSON.stringify(state);
            if (s !== last) {
                last = s;
                mark("ui", state);
            }
            requestAnimationFrame(probe);
        };
        requestAnimationFrame(probe);
    });
}

async function startRecording(page: Page): Promise<void> {
    await page.evaluate(() => {
        (window as unknown as { __feel: { reset(): void } }).__feel.reset();
    });
    await page.waitForTimeout(100);
}

/** The recorded events, with each cue's file named by its bytes. */
async function stopRecording(page: Page): Promise<FeelEvent[]> {
    const names = new Map<string, string>();
    const dir = new URL("../../../res/media/aether/", import.meta.url);
    for (const file of readdirSync(dir)) {
        names.set(
            createHash("sha256")
                .update(readFileSync(new URL(file, dir)))
                .digest("hex"),
            file,
        );
    }
    const events = await page.evaluate(async () => {
        const ev = (window as unknown as { __feel: { ev: FeelEvent[] } }).__feel.ev.slice();
        const hashes = new Map<string, string>();
        for (const e of ev) {
            if (typeof e.src !== "string" || hashes.has(e.src)) continue;
            try {
                const bytes = await (await fetch(e.src)).arrayBuffer();
                const digest = await crypto.subtle.digest("SHA-256", bytes);
                hashes.set(e.src, Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""));
            } catch {
                hashes.set(e.src, "unreadable");
            }
        }
        return ev.map((e) => (typeof e.src === "string" ? { ...e, hash: hashes.get(e.src) } : e));
    });
    return events.map((e) => (typeof e.hash === "string" ? { ...e, src: names.get(e.hash) ?? e.hash } : e));
}

/** Milestones after the first click, in milliseconds. */
function milestones(events: FeelEvent[], clickLabel: RegExp): Record<string, number | string[]> {
    const click =
        events.find((e) => e.kind === "input.click" && clickLabel.test(String(e.label))) ??
        events.find((e) => e.kind === "input.click");
    if (!click) return { error: ["no click"] };
    const t0 = click.t;
    const out: Record<string, number | string[]> = {};
    const first = (name: string, predicate: (e: FeelEvent) => boolean): void => {
        const e = events.find((e) => e.t >= t0 && predicate(e));
        if (e && out[name] === undefined) out[name] = Math.round(e.t - t0);
    };
    type Ui = {
        room: string;
        timeline: boolean;
        stage: {
            visible: boolean;
            phase: string;
            tiles: number;
            callees: number;
            lobby: boolean;
            joinButton: boolean;
        } | null;
        spinners: number;
        dock: { tone: string; status: string } | null;
        voiceRows: string[];
    };
    const ui = (e: FeelEvent): Ui | null => (e.kind === "ui" ? (e as unknown as Ui) : null);
    const before = [...events].reverse().find((e) => e.t < t0 && e.kind === "ui") as unknown as Ui | undefined;
    first("first_change", (e) => !!ui(e) && JSON.stringify({ ...ui(e), t: 0 }) !== JSON.stringify({ ...before, t: 0 }));
    first("view_changed", (e) => !!ui(e) && ui(e)!.room !== before?.room);
    first("timeline_hidden", (e) => !!ui(e) && before?.timeline === true && !ui(e)!.timeline);
    first("stage_visible", (e) => !!ui(e)?.stage?.visible);
    first("spinner", (e) => (ui(e)?.spinners ?? 0) > 0);
    first("lobby_shown", (e) => !!ui(e)?.stage?.lobby || !!ui(e)?.stage?.joinButton);
    first("phase_joining", (e) => ui(e)?.stage?.phase === "joining");
    first("phase_in_call", (e) => ui(e)?.stage?.phase === "in_call");
    first("own_tile", (e) => (ui(e)?.stage?.tiles ?? 0) > 0);
    first("callee_tile", (e) => (ui(e)?.stage?.callees ?? 0) > 0);
    first("dock", (e) => !!ui(e)?.dock);
    first("dock_connected", (e) => ui(e)?.dock?.tone === "success" || ui(e)?.dock?.status === "Connected");
    first("listed_in_channel", (e) => (ui(e)?.voiceRows ?? []).some((r) => /Alice/.test(r)));
    first("cue_join", (e) => e.kind === "cue.playing" && e.src === "join.wav");
    out.cues = events
        .filter((e) => e.t >= t0 && e.kind === "cue.playing")
        .map((e) => `${e.src}@${Math.round(e.t - t0)}`);
    out.phases = events
        .filter((e) => e.t >= t0 && ui(e)?.stage)
        .map((e) => `${ui(e)!.stage!.phase}${ui(e)!.stage!.lobby ? "+lobby" : ""}@${Math.round(e.t - t0)}`)
        .filter((v, i, a) => i === 0 || v.split("@")[0] !== a[i - 1].split("@")[0]);
    out.dock_states = events
        .filter((e) => e.t >= t0 && ui(e))
        .map((e) => `${ui(e)!.dock?.status ?? "-"}@${Math.round(e.t - t0)}`)
        .filter((v, i, a) => i === 0 || v.split("@")[0] !== a[i - 1].split("@")[0]);
    out.long_tasks_ms = Math.round(
        events
            .filter((e) => e.kind === "longtask" && e.t >= t0 && e.t - t0 < 5000)
            .reduce((s, e) => s + Number(e.duration), 0),
    );
    return out;
}

/** Holds homeserver and call-service requests as a distant server would. */
async function addServerDelay(context: BrowserContext, homeserverUrl: string): Promise<void> {
    if (!LATENCY_MS && !CALL_SERVICE_MS) return;
    await context.route(
        (url) => url.href.startsWith(homeserverUrl) || /\/(sfu\/get|get_token)$/.test(url.pathname),
        async (route) => {
            const callService = /\/(sfu\/get|get_token)$/.test(new URL(route.request().url()).pathname);
            await new Promise((resolve) => setTimeout(resolve, LATENCY_MS + (callService ? CALL_SERVICE_MS : 0)));
            await route.fallback();
        },
    );
}

async function settle(page: Page): Promise<void> {
    await rejectToastIfExists(page, "Verify this device");
    await rejectToastIfExists(page, "Notifications");
    await closeReleaseAnnouncementIfExists(page, "Introducing Sections");
}

async function unprocessedMicrophone(page: Page): Promise<void> {
    await page.evaluate(async (level) => {
        await window.mxSettingsStore.setValue("desktopAnsMigrated", null, level, true);
        await window.mxSettingsStore.setValue("desktopInputProfile", null, level, "custom");
        await window.mxSettingsStore.setValue("desktopNoiseSuppression", null, level, "none");
    }, SettingLevel.DEVICE);
}

function report(name: string, events: FeelEvent[], clickLabel: RegExp): void {
    const result = {
        scenario: name,
        latencyMs: LATENCY_MS,
        callServiceMs: CALL_SERVICE_MS,
        ...milestones(events, clickLabel),
    };
    console.log(JSON.stringify(result));
    if (OUT) appendFileSync(OUT, JSON.stringify({ ...result, events }) + "\n");
}

for (const withPeer of [false, true]) {
    test(`voice channel join and leave${withPeer ? " with someone in it" : ""}`, async ({
        page,
        app,
        user,
        browser,
        homeserver,
        config,
    }) => {
        test.setTimeout(240_000);
        await settle(page);
        await unprocessedMicrophone(page);
        const textId = await app.client.createRoom({ name: "chat" });
        const voiceId = await app.client.createRoom({
            name: "Lounge",
            creation_content: { type: "org.matrix.msc3417.call" },
            power_level_content_override: { events: { "org.matrix.msc3401.call.member": 0 } },
        });
        await app.client.createSpace({
            name: "Feel",
            initial_state: [textId, voiceId].map((roomId) => ({
                type: "m.space.child",
                state_key: roomId,
                content: { via: [user.homeServer] },
            })),
        });
        let bobContext: BrowserContext | undefined;
        try {
            if (withPeer) {
                const bob = await homeserver.registerUser("bob-feel", "password", "Bob");
                await app.client.evaluate((client, { voiceId, bob }) => client.invite(voiceId, bob), {
                    voiceId,
                    bob: bob.userId,
                });
                await homeserver.csApi.request("POST", `/v3/join/${voiceId}`, bob.accessToken, {});
                bobContext = await browser.newContext({
                    baseURL: new URL(page.url()).origin,
                    permissions: ["microphone", "camera"],
                });
                const bobPage = await bobContext.newPage();
                await routeConfigJson(bobContext, homeserver.baseUrl, config);
                await populateLocalStorageWithCredentials(bobPage, bob);
                await bobPage.goto("/");
                await bobPage.waitForSelector(".mx_MatrixChat");
                await settle(bobPage);
                await unprocessedMicrophone(bobPage);
                await expect
                    .poll(() =>
                        new ElementAppPage(bobPage).client.evaluate((c, id) => c.getRoom(id)?.getType(), voiceId),
                    )
                    .toBe("org.matrix.msc3417.call");
                await bobPage.evaluate((roomId) => {
                    const { mxDispatcher } = window as unknown as {
                        mxDispatcher: { dispatch(payload: Record<string, unknown>): void };
                    };
                    mxDispatcher.dispatch({
                        action: "view_room",
                        room_id: roomId,
                        view_call: true,
                        skipLobby: true,
                        voiceOnly: true,
                    });
                }, voiceId);
                await expect(
                    bobPage.getByRole("group", { name: "User menu" }).getByText("Voice Connected", { exact: true }),
                ).toBeVisible({ timeout: 60_000 });
            }
            await addServerDelay(page.context(), homeserver.baseUrl);
            await app.viewSpaceByName("Feel");
            await page.mouse.move(900, 400);
            await page.getByRole("button", { name: "Open room chat", exact: true }).click();
            await expect(page.getByTestId("timeline")).toBeVisible();
            await installRecorder(page);
            await page.waitForTimeout(1000);
            await startRecording(page);
            await page
                .getByRole("button", { name: /^Open room Lounge/ })
                .first()
                .click();
            await expect(page.locator("[data-voice-connected]")).toBeVisible({ timeout: 60_000 });
            await page.waitForTimeout(6000);
            const join = await stopRecording(page);
            report(`voice-join${withPeer ? "-peer" : ""}`, join, /Open room Lounge/);
            await startRecording(page);
            await page.getByRole("group", { name: "User menu" }).getByRole("button", { name: "Disconnect" }).click();
            await page.waitForTimeout(4000);
            report(`voice-leave${withPeer ? "-peer" : ""}`, await stopRecording(page), /Disconnect/);
        } finally {
            await bobContext?.close();
        }
    });
}

test("conversation call while the other person has not answered yet", async ({
    page,
    app,
    user,
    browser,
    homeserver,
    config,
}) => {
    test.setTimeout(240_000);
    expect(user).toBeTruthy();
    await settle(page);
    await unprocessedMicrophone(page);
    const bob = await homeserver.registerUser("bob-feel-dm", "password", "Bob");
    const roomId = await app.client.createRoom({
        name: "Conversation",
        is_direct: true,
        initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
        invite: [bob.userId],
        power_level_content_override: { events: { "org.matrix.msc3401.call.member": 0 } },
    });
    await app.client.evaluate(
        async (client, { id, peer }) => {
            await client.setAccountData("m.direct" as import("matrix-js-sdk/src/matrix").EventType.Direct, {
                [peer]: [id],
            });
        },
        { id: roomId, peer: bob.userId },
    );
    await homeserver.csApi.request("POST", `/v3/join/${roomId}`, bob.accessToken, {});
    const bobContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
        const bobPage = await bobContext.newPage();
        await routeConfigJson(bobContext, homeserver.baseUrl, config);
        await populateLocalStorageWithCredentials(bobPage, bob);
        await bobPage.goto("/");
        await bobPage.waitForSelector(".mx_MatrixChat");
        await addServerDelay(page.context(), homeserver.baseUrl);
        await app.viewRoomById(roomId);
        await expect(page.getByTestId("timeline")).toBeVisible();
        await installRecorder(page);
        await page.waitForTimeout(1000);
        await startRecording(page);
        await page.getByRole("button", { name: "Voice call", exact: true }).click();
        await expect(page.getByTestId("aether-call-stage")).toHaveAttribute("data-phase", "in_call", {
            timeout: 60_000,
        });
        await page.waitForTimeout(6000);
        report("conversation-call", await stopRecording(page), /Voice call/);
        await startRecording(page);
        await page.getByTestId("incall_leave").click();
        await page.waitForTimeout(4000);
        report("conversation-leave", await stopRecording(page), /Leave|Hang|Disconnect/i);
    } finally {
        await bobContext.close();
    }
});

/*
 * Plays the call cues out loud during a real call, so a recording of the system output can show whether they
 * crackle. Run with AETHER_BENCHMARK_AUDIO=1 while recording the default output (see the PR's measurement notes).
 * The epoch time of each cue is printed so the recording can be lined up with it.
 */
test.describe("cues out loud", () => {
    test.skip(!process.env.AETHER_BENCHMARK_AUDIO, "Set AETHER_BENCHMARK_AUDIO=1 to play cues out loud");
    for (const suppression of ["voice_isolation", "none"] as const) {
        test(`cues during a call with noise suppression ${suppression}`, async ({ page, app, user }) => {
            test.setTimeout(240_000);
            await settle(page);
            await page.evaluate(
                async ({ level, suppression }) => {
                    await window.mxSettingsStore.setValue("desktopAnsMigrated", null, level, true);
                    if (suppression === "none") {
                        await window.mxSettingsStore.setValue("desktopInputProfile", null, level, "custom");
                        await window.mxSettingsStore.setValue("desktopNoiseSuppression", null, level, "none");
                    }
                },
                { level: SettingLevel.DEVICE, suppression },
            );
            const voiceId = await app.client.createRoom({
                name: "Lounge",
                creation_content: { type: "org.matrix.msc3417.call" },
            });
            await app.client.createSpace({
                name: "Loud",
                initial_state: [{ type: "m.space.child", state_key: voiceId, content: { via: [user.homeServer] } }],
            });
            await app.viewSpaceByName("Loud");
            await page.mouse.move(900, 400);
            await installRecorder(page);
            await startRecording(page);
            await page
                .getByRole("button", { name: /^Open room Lounge/ })
                .first()
                .click();
            await expect(page.locator("[data-voice-connected]")).toHaveAttribute("data-tone", /success|neutral/, {
                timeout: 60_000,
            });
            const dock = page.getByRole("group", { name: "User menu" });
            for (let i = 0; i < 4; i++) {
                await page.waitForTimeout(2500);
                await dock
                    .getByRole("button", { name: /^(Mute|Unmute)/ })
                    .first()
                    .click();
            }
            await page.waitForTimeout(2500);
            await dock.getByRole("button", { name: "Disconnect" }).click();
            await page.waitForTimeout(2500);
            const events = await stopRecording(page);
            const cues = events.filter((e) => e.kind === "cue.playing").map((e) => ({ t: e.t, src: e.src }));
            console.log(JSON.stringify({ scenario: `cues-${suppression}`, cues }));
            if (OUT) appendFileSync(OUT, JSON.stringify({ scenario: `cues-${suppression}`, cues, events }) + "\n");
        });
    }
});
