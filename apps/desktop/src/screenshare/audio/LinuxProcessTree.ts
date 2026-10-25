/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import type { LinuxAudioProcessInfo, LinuxShareAudioDependencies } from "./LinuxShareAudioDependencies.js";

/** Reads a process and each parent up to PID 1; null means ownership could not be verified. */
export async function readLinuxProcessAncestry(
    pid: number,
    dependencies: LinuxShareAudioDependencies,
): Promise<LinuxAudioProcessInfo[] | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;

    const result: LinuxAudioProcessInfo[] = [];
    const visited = new Set<number>();
    let currentPid = pid;
    for (let depth = 0; depth < 256; depth++) {
        if (visited.has(currentPid)) return null;
        visited.add(currentPid);

        const processInfo = await dependencies.readProcessInfo(currentPid);
        if (!processInfo || processInfo.pid !== currentPid) return null;
        result.push(processInfo);
        if (processInfo.pid === 1 || processInfo.parentPid === 0) return result;
        if (!Number.isSafeInteger(processInfo.parentPid) || processInfo.parentPid <= 0) return null;
        currentPid = processInfo.parentPid;
    }
    return null;
}
