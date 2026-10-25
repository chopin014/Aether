/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/** A capture child with stdout and stderr pipes and no stdin pipe. */
export type LinuxAudioChildProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Process details read from procfs to check application and exclusion ancestry. */
export interface LinuxAudioProcessInfo {
    pid: number;
    parentPid: number;
    startTime: string;
    name: string;
}

/** Injectable OS operations used by the Linux provider and its unit tests. */
export interface LinuxShareAudioDependencies {
    execute: (executable: string, args: readonly string[], timeoutMs?: number) => Promise<string>;
    spawn: (executable: string, args: readonly string[]) => LinuxAudioChildProcess;
    readProcessInfo: (pid: number) => Promise<LinuxAudioProcessInfo | null>;
    environment: Readonly<Record<string, string | undefined>>;
    xpropExecutable: string;
    pactlExecutable: string;
    parecExecutable: string;
    /** Overrides the default three-second capture readiness deadline. */
    captureReadyTimeoutMs?: number;
}

/** Creates a stable UTF-8 CLI environment without dropping PulseAudio or desktop session variables. */
export function createLinuxAudioCommandEnvironment(
    environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
    return { ...environment, LC_ALL: "C.UTF-8" };
}
