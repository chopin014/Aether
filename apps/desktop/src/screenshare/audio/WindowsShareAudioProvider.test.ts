/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { createWindowsShareAudioProvider } from "./WindowsShareAudioProvider.js";

interface SpawnCall {
    args: string[];
    child: FakeChild;
}

interface SpawnMockOptions {
    capabilityOutput?: string;
    capabilityNeverResponds?: boolean;
    captureReady?: boolean;
    captureClosesOnStop?: boolean;
    captureClosesOnKill?: boolean;
}

class FakeChild extends EventEmitter {
    public readonly stdin = new PassThrough();
    public readonly stdout = new PassThrough();
    public readonly stderr = new PassThrough();
    public closed = false;
    public closeOnKill = true;
    public readonly kill = vi.fn(() => {
        if (this.closeOnKill) closeFakeChild(this, null, "SIGTERM");
        return true;
    });
}

function createFakeChild(): FakeChild {
    return new FakeChild();
}

function asSpawnChild(child: FakeChild): ChildProcessWithoutNullStreams {
    return child as unknown as ChildProcessWithoutNullStreams;
}

function closeFakeChild(child: FakeChild, code: number | null, signal: NodeJS.Signals | null): void {
    if (child.closed) return;
    child.closed = true;
    if (!child.stdin.destroyed) child.stdin.end();
    if (!child.stdout.destroyed) child.stdout.end();
    if (!child.stderr.destroyed) child.stderr.end();
    child.emit("close", code, signal);
}

function createSpawnMock(options: SpawnMockOptions = {}): {
    spawn: NonNullable<Parameters<typeof createWindowsShareAudioProvider>[0]["spawn"]>;
    calls: SpawnCall[];
} {
    const calls: SpawnCall[] = [];
    const spawn = (command: string, args: string[], spawnOptions: SpawnOptions): ChildProcessWithoutNullStreams => {
        void command;
        void spawnOptions;
        const child = createFakeChild();
        calls.push({ args, child });

        if (args[0] === "--capabilities") {
            if (!options.capabilityNeverResponds) {
                queueMicrotask(() => {
                    child.stderr.write(
                        options.capabilityOutput ?? '{"type":"capabilities","supported":true,"build":26100}\n',
                    );
                    closeFakeChild(child, 0, null);
                });
            }
        } else if (args[0] === "--resolve-window") {
            queueMicrotask(() => {
                if (args[1] === "window:123456:0" || args[1] === "window:123457:0") {
                    child.stderr.write('{"type":"resolved","valid":true,"pid":2400,"creationTime":"1A2B"}\n');
                } else {
                    child.stderr.write('{"type":"resolved","valid":false}\n');
                }
                closeFakeChild(child, 0, null);
            });
        } else {
            child.closeOnKill = options.captureClosesOnKill ?? true;
            child.stdin.on("data", (chunk: Buffer) => {
                if (chunk.toString("utf8").includes("stop") && (options.captureClosesOnStop ?? true)) {
                    closeFakeChild(child, 0, null);
                }
            });
            if (options.captureReady ?? true) queueMicrotask(() => child.stderr.write('{"type":"ready"}\n'));
        }

        return asSpawnChild(child);
    };
    return { spawn, calls };
}

function createProvider(
    spawn: NonNullable<Parameters<typeof createWindowsShareAudioProvider>[0]["spawn"]>,
    overrides: Partial<Parameters<typeof createWindowsShareAudioProvider>[0]> = {},
): ReturnType<typeof createWindowsShareAudioProvider> {
    return createWindowsShareAudioProvider({
        helperPath: "helper.exe",
        platform: "win32",
        helperExists: vi.fn(async () => true),
        spawn,
        ...overrides,
    });
}

function nextTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

describe("Windows share-audio provider", () => {
    it("reports unsupported platforms, missing helpers and old Windows builds", async () => {
        const fake = createSpawnMock();
        const nonWindows = createWindowsShareAudioProvider({
            helperPath: "helper.exe",
            platform: "linux",
            helperExists: vi.fn(async () => true),
            spawn: fake.spawn,
        });
        expect(await nonWindows.capabilities()).toMatchObject({ system: false, application: false, window: false });
        expect(fake.calls).toHaveLength(0);

        const missingHelper = createWindowsShareAudioProvider({
            helperPath: "helper.exe",
            platform: "win32",
            helperExists: vi.fn(async () => false),
            spawn: fake.spawn,
        });
        expect((await missingHelper.capabilities()).reason).toContain("helper is missing");

        const oldBuild = createProvider(
            createSpawnMock({
                capabilityOutput:
                    '{"type":"capabilities","supported":false,"build":19045,"reason":"Windows 10 build 20348 or later is required."}\n',
            }).spawn,
        );
        expect((await oldBuild.capabilities()).reason).toContain("20348");
    });

    it.each([
        ['{"type":"other","supported":true,"build":26100}\n', "invalid capability data"],
        ['{"type":"capabilities","supported":"yes","build":26100}\n', "invalid capability data"],
        ['{"type":"capabilities","supported":true,"build":19045}\n', "invalid capability data"],
        ['{"type":"capabilities","supported":true}\n', "invalid capability data"],
    ])("fails closed for malformed capability response %s", async (capabilityOutput, expectedReason) => {
        const provider = createProvider(createSpawnMock({ capabilityOutput }).spawn);
        const capabilities = await provider.capabilities();
        expect(capabilities.system).toBe(false);
        expect(capabilities.application).toBe(false);
        expect(capabilities.reason).toContain(expectedReason);
    });

    it.each([
        ["invalid JSON", "not json\n", 0],
        ["oversized JSON", `${"x".repeat(65 * 1024)}\n`, 0],
    ])("kills a query helper that returns %s", async (_label, output, exitCode) => {
        const calls: SpawnCall[] = [];
        const spawn = (command: string, args: string[], spawnOptions: SpawnOptions): ChildProcessWithoutNullStreams => {
            void command;
            void spawnOptions;
            const child = createFakeChild();
            calls.push({ args, child });
            queueMicrotask(() => {
                child.stderr.write(output);
                closeFakeChild(child, exitCode, null);
            });
            return asSpawnChild(child);
        };
        const provider = createProvider(spawn);
        expect((await provider.capabilities()).system).toBe(false);
        expect(calls[0].child.kill).toHaveBeenCalledTimes(1);
    });

    it("handles query stream errors and bounded query timeouts", async () => {
        const errorChild = createFakeChild();
        const errorProvider = createProvider(() => {
            queueMicrotask(() => errorChild.stderr.emit("error", new Error("broken stderr")));
            return asSpawnChild(errorChild);
        });
        const errorCapabilities = await errorProvider.capabilities();
        expect(errorCapabilities.system).toBe(false);
        expect(errorCapabilities.reason).toContain("query stream failed");
        expect(errorChild.kill).toHaveBeenCalledTimes(1);

        const timeoutChild = createFakeChild();
        const timeoutProvider = createWindowsShareAudioProvider({
            helperPath: "helper.exe",
            platform: "win32",
            helperExists: vi.fn(async () => true),
            queryTimeoutMs: 5,
            spawn: () => asSpawnChild(timeoutChild),
        });
        const timeoutCapabilities = await timeoutProvider.capabilities();
        expect(timeoutCapabilities.system).toBe(false);
        expect(timeoutCapabilities.reason).toContain("timed out");
        expect(timeoutChild.kill).toHaveBeenCalledTimes(1);
    });

    it("validates decimal HWNDs, lists one process once, and streams aligned PCM", async () => {
        const fake = createSpawnMock();
        const listWindows = vi.fn(async () => [
            { id: "window:123456:0", name: "Editor" },
            { id: "window:123457:0", name: "Editor child" },
            { id: "screen:123456:0", name: "Desktop" },
        ]);
        const provider = createProvider(fake.spawn, { listWindows });
        const [applications, concurrentApplications] = await Promise.all([
            provider.listApplications(),
            provider.listApplications(),
        ]);
        expect(concurrentApplications).toEqual(applications);
        expect(listWindows).toHaveBeenCalledTimes(1);
        expect(applications).toHaveLength(1);
        expect(applications[0].name).toBe("Editor");
        expect(applications[0].id).not.toContain("123456");

        const pcmData: Buffer[] = [];
        const onStopped = vi.fn();
        const onError = vi.fn();
        const session = await provider.start({ kind: "application", id: applications[0].id }, [], {
            onData: (pcm) => pcmData.push(pcm),
            onError,
            onStopped,
        });
        const capture = fake.calls.find(({ args }) => args[0] === "--include-tree");
        expect(capture?.args).toEqual(["--include-tree", "2400", "1a2b"]);

        const packet = Buffer.alloc(16, 7);
        capture?.child.stdout.write(packet.subarray(0, 7));
        capture?.child.stdout.write(packet.subarray(7));
        expect(pcmData.reduce((length, chunk) => length + chunk.length, 0)).toBe(16);
        expect(pcmData.every((chunk) => chunk.length % 8 === 0)).toBe(true);

        const firstStop = session.stop();
        expect(session.stop()).toBe(firstStop);
        await firstStop;
        expect(onStopped).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
    });

    it("prunes application IDs after a refresh no longer sees their window", async () => {
        const fake = createSpawnMock();
        const listWindows = vi
            .fn<() => Promise<Array<{ id: string; name: string }>>>()
            .mockResolvedValueOnce([{ id: "window:123456:0", name: "Editor" }])
            .mockResolvedValueOnce([]);
        const provider = createProvider(fake.spawn, { listWindows });
        const [application] = await provider.listApplications();
        expect(await provider.listApplications()).toEqual([]);

        await expect(
            provider.start({ kind: "application", id: application.id }, [], {
                onData: vi.fn(),
                onError: vi.fn(),
                onStopped: vi.fn(),
            }),
        ).rejects.toThrow("no longer available");
        expect(fake.calls.some(({ args }) => args[0] === "--include-tree")).toBe(false);
    });

    it("uses the first excluded process ID as the native system-loopback root", async () => {
        const fake = createSpawnMock();
        const provider = createProvider(fake.spawn);
        const session = await provider.start({ kind: "system" }, [1234, 5678], {
            onData: vi.fn(),
            onError: vi.fn(),
            onStopped: vi.fn(),
        });
        expect(fake.calls.find(({ args }) => args[0] === "--exclude-tree")?.args).toEqual(["--exclude-tree", "1234"]);
        await session.stop();
    });

    it("rejects unknown targets and missing system roots without launching capture", async () => {
        const fake = createSpawnMock();
        const provider = createProvider(fake.spawn);
        const callbacks = { onData: vi.fn(), onError: vi.fn(), onStopped: vi.fn() };

        await expect(provider.start({ kind: "system" }, [], callbacks)).rejects.toThrow("root process ID");
        await expect(provider.start({ kind: "application", id: "renderer-chosen" }, [123], callbacks)).rejects.toThrow(
            "no longer available",
        );
        expect(fake.calls.some(({ args }) => args[0] === "--include-tree" || args[0] === "--exclude-tree")).toBe(false);
    });

    it("aborts while capability probing is pending and does not start a capture later", async () => {
        const child = createFakeChild();
        let resolveQueryStarted: () => void = () => {
            throw new Error("The query did not start.");
        };
        const queryStarted = new Promise<void>((resolve) => {
            resolveQueryStarted = resolve;
        });
        const calls: SpawnCall[] = [];
        const spawn = (command: string, args: string[], spawnOptions: SpawnOptions): ChildProcessWithoutNullStreams => {
            void command;
            void spawnOptions;
            calls.push({ args, child });
            resolveQueryStarted();
            return asSpawnChild(child);
        };
        const provider = createProvider(spawn);
        const controller = new AbortController();
        const start = provider.start(
            { kind: "system" },
            [1234],
            {
                onData: vi.fn(),
                onError: vi.fn(),
                onStopped: vi.fn(),
            },
            controller.signal,
        );
        await queryStarted;
        controller.abort();
        child.stderr.write('{"type":"capabilities","supported":true,"build":26100}\n');
        closeFakeChild(child, 0, null);

        await expect(start).rejects.toMatchObject({ name: "AbortError" });
        expect(calls.map(({ args }) => args[0])).toEqual(["--capabilities"]);
    });

    it("kills the helper and rejects if startup aborts before readiness", async () => {
        const fake = createSpawnMock({ captureReady: false });
        const provider = createProvider(fake.spawn);
        const controller = new AbortController();
        const callbacks = { onData: vi.fn(), onError: vi.fn(), onStopped: vi.fn() };

        const start = provider.start({ kind: "system" }, [process.pid], callbacks, controller.signal);
        await nextTurn();
        const capture = fake.calls.find(({ args }) => args[0] === "--exclude-tree");
        controller.abort();

        await expect(start).rejects.toMatchObject({ name: "AbortError" });
        expect(capture?.child.kill).toHaveBeenCalledTimes(1);
        expect(callbacks.onError).not.toHaveBeenCalled();
        expect(callbacks.onStopped).not.toHaveBeenCalled();
    });

    it("rejects when the native helper exits before readiness or misses the ready deadline", async () => {
        const earlyExit = createSpawnMock({ captureReady: false });
        const earlyProvider = createProvider((command, args, spawnOptions) => {
            const child = earlyExit.spawn(command, args, spawnOptions);
            if (args[0] !== "--capabilities")
                queueMicrotask(() => closeFakeChild(earlyExit.calls.at(-1)!.child, 0, null));
            return child;
        });
        const earlyOnStopped = vi.fn();
        await expect(
            earlyProvider.start({ kind: "system" }, [1234], {
                onData: vi.fn(),
                onError: vi.fn(),
                onStopped: earlyOnStopped,
            }),
        ).rejects.toThrow("exited before capture was ready");
        earlyExit.calls.at(-1)!.child.stderr.write('{"type":"ready"}\n');
        expect(earlyOnStopped).not.toHaveBeenCalled();

        const timeout = createSpawnMock({ captureReady: false });
        const timeoutProvider = createWindowsShareAudioProvider({
            helperPath: "helper.exe",
            platform: "win32",
            helperExists: vi.fn(async () => true),
            startTimeoutMs: 5,
            spawn: timeout.spawn,
        });
        await expect(
            timeoutProvider.start({ kind: "system" }, [1234], {
                onData: vi.fn(),
                onError: vi.fn(),
                onStopped: vi.fn(),
            }),
        ).rejects.toThrow("did not become ready");
        expect(timeout.calls.at(-1)?.child.kill).toHaveBeenCalledTimes(1);
    });

    it("rejects a native startup error and ignores a late ready message", async () => {
        const fake = createSpawnMock({ captureReady: false });
        const provider = createProvider(fake.spawn);
        const start = provider.start({ kind: "system" }, [1234], {
            onData: vi.fn(),
            onError: vi.fn(),
            onStopped: vi.fn(),
        });
        await nextTurn();
        const capture = fake.calls.at(-1)!;
        capture.child.stderr.write('{"type":"error","message":"native activation failed"}\n');
        capture.child.stderr.write('{"type":"ready"}\n');

        await expect(start).rejects.toThrow("native activation failed");
        await nextTurn();
        expect(capture.child.kill).toHaveBeenCalledTimes(1);
    });

    it("reports a native error after readiness and stops forwarding PCM", async () => {
        const fake = createSpawnMock();
        const provider = createProvider(fake.spawn);
        const onData = vi.fn();
        const onError = vi.fn((error: Error) => {
            void error;
            throw new Error("consumer error callback failed");
        });
        const onStopped = vi.fn();
        await provider.start({ kind: "system" }, [1234], { onData, onError, onStopped });
        const capture = fake.calls.at(-1)!;

        capture.child.stderr.write('{"type":"error","message":"capture device lost"}\n');
        capture.child.stdout.write(Buffer.alloc(8));
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0].message).toBe("capture device lost");
        expect(onData).not.toHaveBeenCalled();
        expect(onStopped).not.toHaveBeenCalled();
        expect(capture.child.kill).toHaveBeenCalledTimes(1);
    });

    it("reports early EOF and incomplete PCM as one terminal error", async () => {
        const fake = createSpawnMock();
        const provider = createProvider(fake.spawn);
        const onError = vi.fn();
        const onStopped = vi.fn();
        await provider.start({ kind: "system" }, [1234], { onData: vi.fn(), onError, onStopped });
        const capture = fake.calls.at(-1)!;
        capture.child.stdout.write(Buffer.alloc(7));
        closeFakeChild(capture.child, 0, null);

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0].message).toContain("incomplete PCM frame");
        expect(onStopped).not.toHaveBeenCalled();
    });

    it("guards throwing data and error callbacks while cleaning up", async () => {
        const fake = createSpawnMock();
        const provider = createProvider(fake.spawn);
        const onError = vi.fn(() => {
            throw new Error("consumer error callback failed");
        });
        const session = await provider.start({ kind: "system" }, [1234], {
            onData: () => {
                throw new Error("consumer data callback failed");
            },
            onError,
            onStopped: () => {
                throw new Error("consumer stopped callback failed");
            },
        });
        const capture = fake.calls.at(-1)!;
        expect(() => capture.child.stdout.write(Buffer.alloc(8))).not.toThrow();
        expect(onError).toHaveBeenCalledTimes(1);
        expect(capture.child.kill).toHaveBeenCalledTimes(1);

        await session.stop();
    });

    it("swallows a throwing stopped callback after natural helper exit", async () => {
        const fake = createSpawnMock();
        const provider = createProvider(fake.spawn);
        const onStopped = vi.fn(() => {
            throw new Error("consumer stopped callback failed");
        });
        await provider.start({ kind: "system" }, [1234], {
            onData: vi.fn(),
            onError: vi.fn(),
            onStopped,
        });
        const capture = fake.calls.at(-1)!;

        expect(() => closeFakeChild(capture.child, 0, null)).not.toThrow();
        expect(onStopped).toHaveBeenCalledTimes(1);
    });

    it("reports bounded forced-stop failure instead of claiming the helper stopped", async () => {
        const fake = createSpawnMock({ captureClosesOnStop: false, captureClosesOnKill: false });
        const provider = createWindowsShareAudioProvider({
            helperPath: "helper.exe",
            platform: "win32",
            helperExists: vi.fn(async () => true),
            stopTimeoutMs: 2,
            killTimeoutMs: 2,
            spawn: fake.spawn,
        });
        const onError = vi.fn();
        const onStopped = vi.fn();
        const session = await provider.start({ kind: "system" }, [1234], {
            onData: vi.fn(),
            onError,
            onStopped,
        });
        const capture = fake.calls.at(-1)!;

        await session.stop();
        expect(capture.child.kill).toHaveBeenCalledTimes(1);
        expect(capture.child.stdin.destroyed).toBe(true);
        expect(capture.child.stdout.destroyed).toBe(true);
        expect(capture.child.stderr.destroyed).toBe(true);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0].message).toContain("did not exit after being terminated");
        expect(onStopped).not.toHaveBeenCalled();
    });
});
