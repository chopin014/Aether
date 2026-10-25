/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MINIMUM_WINDOWS_BUILD = 20348;
const MAX_CONTROL_LINE_CHARS = 64 * 1024;
const MAX_CONTROL_MESSAGES = 32;
const QUERY_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 1_000;

interface HelperMessage {
    type?: unknown;
    supported?: unknown;
    build?: unknown;
    valid?: unknown;
    message?: unknown;
}

interface ExitResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
}

interface ExitObserver {
    promise: Promise<ExitResult>;
    dispose: () => void;
}

interface CaptureResult {
    records: HelperMessage[];
    exit: ExitResult;
    pcmBytes: number;
}

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptsDirectory, "..");
const defaultHelperPath = path.join(
    desktopDirectory,
    "native",
    "share-audio",
    "windows",
    "build",
    "Release",
    "aether-share-audio.exe",
);

/**
 * Runs a real-helper startup and shutdown smoke check without making claims about audible quality.
 * @param helperPath Built helper path; defaults to the development build output.
 */
export async function runWindowsShareAudioSmoke(helperPath: string = defaultHelperPath): Promise<void> {
    if (process.platform !== "win32") {
        throw new Error("The Windows share-audio smoke check can only run on Windows.");
    }

    const resolvedHelperPath = path.resolve(helperPath);
    await access(resolvedHelperPath);

    const capabilities = await runOneShot(resolvedHelperPath, ["--capabilities"], QUERY_TIMEOUT_MS);
    const capability = requireSingleMessage(capabilities, "capabilities");
    if (
        capability.type !== "capabilities" ||
        capability.supported !== true ||
        typeof capability.build !== "number" ||
        !Number.isSafeInteger(capability.build) ||
        capability.build < MINIMUM_WINDOWS_BUILD
    ) {
        throw new Error("The helper did not report supported process-loopback capture on this Windows build.");
    }

    const invalidWindow = await runOneShot(resolvedHelperPath, ["--resolve-window", "window:0:0"], QUERY_TIMEOUT_MS);
    const invalidWindowResult = requireSingleMessage(invalidWindow, "resolved");
    if (invalidWindowResult.type !== "resolved" || invalidWindowResult.valid !== false) {
        throw new Error("The helper did not reject the invalid HWND source ID.");
    }

    const capture = await runCaptureSmoke(resolvedHelperPath);
    if (capture.exit.code !== 0 || capture.exit.signal !== null) {
        throw new Error(
            `The helper did not exit cleanly after stop (code=${capture.exit.code}, signal=${capture.exit.signal}).`,
        );
    }
    if (capture.records.some((record) => record.type === "error")) {
        throw new Error("The helper reported an error during its startup/shutdown smoke check.");
    }
    if (capture.pcmBytes % 8 !== 0) {
        throw new Error("Captured output ended on an incomplete stereo float32 PCM frame.");
    }

    console.log(
        `Windows share-audio startup/shutdown smoke passed (build ${capability.build}; ${capture.pcmBytes} PCM bytes observed).`,
    );
}

async function runOneShot(helperPath: string, args: string[], timeoutMs: number): Promise<HelperMessage[]> {
    const child = spawn(helperPath, args, {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = child.stderr;
    if (!stderr) {
        terminateChild(child);
        throw new Error("The helper query stderr stream is unavailable.");
    }

    const records: HelperMessage[] = [];
    let remainder = "";
    let controlError: Error | undefined;
    let childExit: ExitResult | undefined;
    const exitObserver = observeExit(child);
    const exitPromise = exitObserver.promise.then((exit) => {
        childExit = exit;
        return exit;
    });

    const consume = (chunk: Buffer): void => {
        if (controlError) return;
        remainder += chunk.toString("utf8");
        let lineEnd = remainder.indexOf("\n");
        while (lineEnd >= 0) {
            const line = remainder.slice(0, lineEnd).trim();
            remainder = remainder.slice(lineEnd + 1);
            if (line) {
                try {
                    records.push(parseHelperMessage(line));
                    if (records.length > MAX_CONTROL_MESSAGES) throw new Error("too many control messages");
                } catch (error) {
                    controlError = new Error(`The helper query returned invalid control data: ${errorMessage(error)}`);
                    terminateChild(child);
                    return;
                }
            }
            lineEnd = remainder.indexOf("\n");
        }
        if (remainder.length > MAX_CONTROL_LINE_CHARS) {
            controlError = new Error("The helper query returned an oversized control message.");
            terminateChild(child);
        }
    };

    const onStderrError = (error: Error): void => {
        controlError = new Error(`The helper query stderr stream failed: ${errorMessage(error)}`);
        terminateChild(child);
    };
    stderr.on("data", consume);
    stderr.on("error", onStderrError);

    const timeout = setTimeout(() => {
        controlError = new Error("The helper query timed out.");
        terminateChild(child);
    }, timeoutMs);

    try {
        const exit = await waitForExitOrTimeout(exitPromise, timeoutMs);
        if (!exit) throw controlError ?? new Error("The helper query timed out.");
        if (controlError) throw controlError;
        if (remainder.trim()) throw new Error("The helper query returned an unterminated control message.");
        if (exit.error) throw new Error(`The helper query process failed: ${errorMessage(exit.error)}`);
        if (exit.code !== 0 || exit.signal !== null) {
            throw new Error(`The helper query exited unsuccessfully (code=${exit.code}, signal=${exit.signal}).`);
        }
        return records;
    } finally {
        clearTimeout(timeout);
        if (!childExit || childExit.error) terminateChild(child);
        await waitForExitOrTimeout(exitPromise, CLEANUP_TIMEOUT_MS);
        stderr.off("data", consume);
        stderr.off("error", onStderrError);
        stderr.destroy();
        exitObserver.dispose();
    }
}

async function runCaptureSmoke(helperPath: string): Promise<CaptureResult> {
    const child = spawn(helperPath, ["--exclude-tree", String(process.pid)], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdin || !stdout || !stderr) {
        terminateChild(child);
        throw new Error("The helper capture streams are unavailable.");
    }

    const records: HelperMessage[] = [];
    const controlErrors: Error[] = [];
    let remainder = "";
    let ready = false;
    let childExit: ExitResult | undefined;
    let readyResolve: () => void = () => undefined;
    let readyReject: (error: Error) => void = () => undefined;
    const readyPromise = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
    });
    const exitObserver = observeExit(child);
    const exitPromise = exitObserver.promise.then((exit) => {
        childExit = exit;
        return exit;
    });
    let pcmBytes = 0;
    let pcmRemainder = 0;

    const reportControlFailure = (error: Error): void => {
        controlErrors.push(error);
        if (!ready) readyReject(error);
        terminateChild(child);
    };

    const consume = (chunk: Buffer): void => {
        if (controlErrors.length > 0) return;
        remainder += chunk.toString("utf8");
        let lineEnd = remainder.indexOf("\n");
        while (lineEnd >= 0) {
            const line = remainder.slice(0, lineEnd).trim();
            remainder = remainder.slice(lineEnd + 1);
            if (line) {
                try {
                    const message = parseHelperMessage(line);
                    records.push(message);
                    if (records.length > MAX_CONTROL_MESSAGES) throw new Error("too many control messages");
                    if (message.type === "error") {
                        reportControlFailure(new Error(helperMessage(message)));
                        return;
                    }
                    if (message.type === "ready" && !ready) {
                        ready = true;
                        readyResolve();
                    }
                } catch (error) {
                    reportControlFailure(
                        new Error(`The helper capture returned invalid control data: ${errorMessage(error)}`),
                    );
                    return;
                }
            }
            lineEnd = remainder.indexOf("\n");
        }
        if (remainder.length > MAX_CONTROL_LINE_CHARS) {
            reportControlFailure(new Error("The helper capture returned an oversized control message."));
        }
    };

    const onStderrError = (error: Error): void =>
        reportControlFailure(new Error(`The helper capture stderr stream failed: ${errorMessage(error)}`));
    const onStdinError = (error: Error): void =>
        reportControlFailure(new Error(`The helper capture stdin stream failed: ${errorMessage(error)}`));
    const onStdoutData = (chunk: Buffer): void => {
        pcmBytes += chunk.length;
        pcmRemainder = (pcmRemainder + chunk.length) % 8;
    };
    const onStdoutError = (error: Error): void =>
        reportControlFailure(new Error(`The helper capture stdout stream failed: ${errorMessage(error)}`));
    const onChildError = (error: Error): void =>
        reportControlFailure(new Error(`The helper process failed: ${errorMessage(error)}`));
    const onChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (!ready) {
            readyReject(
                new Error(`The helper exited before capture was ready (code=${code}, signal=${signal ?? "none"}).`),
            );
        }
    };

    stdin.on("error", onStdinError);
    stderr.on("data", consume);
    stderr.on("error", onStderrError);
    stdout.on("data", onStdoutData);
    stdout.on("error", onStdoutError);
    child.on("error", onChildError);
    child.on("close", onChildClose);

    const readyTimeout = setTimeout(() => {
        reportControlFailure(new Error("The helper did not become ready within 10 seconds."));
    }, READY_TIMEOUT_MS);

    try {
        await readyPromise;
        clearTimeout(readyTimeout);
        if (controlErrors.length > 0) throw controlErrors[0];
        try {
            stdin.end("stop\n");
        } catch (error) {
            reportControlFailure(new Error(`The stop command could not be sent: ${errorMessage(error)}`));
            throw controlErrors[0];
        }
        const exit = await waitForExitOrTimeout(exitPromise, STOP_TIMEOUT_MS);
        if (!exit) throw new Error("The helper did not exit within five seconds after the stop command.");
        if (exit.error) throw new Error(`The helper process failed: ${errorMessage(exit.error)}`);
        if (remainder.trim()) throw new Error("The helper capture returned an unterminated control message.");
        if (controlErrors.length > 0) throw controlErrors[0];
        if (pcmRemainder !== 0) throw new Error("Captured output ended on an incomplete stereo float32 PCM frame.");
        return { records, exit, pcmBytes };
    } finally {
        clearTimeout(readyTimeout);
        if (!childExit) terminateChild(child);
        await waitForExitOrTimeout(exitPromise, CLEANUP_TIMEOUT_MS);
        stdin.off("error", onStdinError);
        stdin.destroy();
        stdout.off("data", onStdoutData);
        stdout.off("error", onStdoutError);
        stderr.off("data", consume);
        stderr.off("error", onStderrError);
        stdout.destroy();
        stderr.destroy();
        child.off("error", onChildError);
        child.off("close", onChildClose);
        exitObserver.dispose();
    }
}

function requireSingleMessage(messages: HelperMessage[], expectedType: string): HelperMessage {
    if (messages.length !== 1 || messages[0]?.type !== expectedType) {
        throw new Error(`The helper did not return exactly one ${expectedType} message.`);
    }
    return messages[0];
}

function parseHelperMessage(line: string): HelperMessage {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("control message is not an object");
    }
    return value;
}

function helperMessage(message: HelperMessage): string {
    return typeof message.message === "string" ? message.message : "The helper reported a capture error.";
}

function observeExit(child: ChildProcess): ExitObserver {
    let onError: (error: Error) => void;
    let onClose: (code: number | null, signal: NodeJS.Signals | null) => void;
    const promise = new Promise<ExitResult>((resolve) => {
        onError = (error) => resolve({ code: null, signal: null, error });
        onClose = (code, signal) => resolve({ code, signal });
        child.on("error", onError);
        child.on("close", onClose);
    });
    return {
        promise,
        dispose: (): void => {
            child.off("error", onError);
            child.off("close", onClose);
        },
    };
}

async function waitForExitOrTimeout(exitPromise: Promise<ExitResult>, timeoutMs: number): Promise<ExitResult | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const exit = await Promise.race([exitPromise, timeout]);
    if (timer) clearTimeout(timer);
    return exit;
}

function terminateChild(child: ChildProcess): void {
    try {
        child.kill();
    } catch {
        // The bounded cleanup wait still closes the pipes if the child has already exited.
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isDirectRun(): boolean {
    const entryPath = process.argv[1];
    return Boolean(entryPath && pathToFileURL(path.resolve(entryPath)).href === import.meta.url);
}

function selectedHelperPath(): string {
    const helperArgument = process.argv.find((argument) => argument.startsWith("--helper="));
    return helperArgument?.slice("--helper=".length) || process.env.AETHER_SHARE_AUDIO_HELPER || defaultHelperPath;
}

if (isDirectRun()) {
    runWindowsShareAudioSmoke(selectedHelperPath()).catch((error: unknown) => {
        console.error(`Windows share-audio smoke failed: ${errorMessage(error)}`);
        process.exitCode = 1;
    });
}
