/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

const SingleEntryPlugin = require("webpack/lib/SingleEntryPlugin");

module.exports = function () {};

module.exports.pitch = function pitch(request) {
    const callback = this.async();
    const filename = "microphone-gate.[contenthash:8].worklet.js";
    const compiler = this._compilation.createChildCompiler("microphone-gate", {
        filename,
        chunkFilename: `[id].${filename}`,
        namedChunkFilename: null,
    });
    new SingleEntryPlugin(this.context, `!!${request}`, "main").apply(compiler);
    compiler.runAsChild((error, entries) => {
        if (error) return callback(error);
        const filename = entries[0] && [...entries[0].files][0];
        if (!filename) return callback(new Error("The microphone worklet did not produce a module"));
        callback(
            null,
            `export const microphoneGateWorkletUrl = __webpack_public_path__ + ${JSON.stringify(filename)};`,
        );
    });
};
