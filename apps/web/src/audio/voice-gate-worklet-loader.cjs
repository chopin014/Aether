/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// Like recorder-worklet-loader, compile an independent script with webpack's public asset path.
const SingleEntryPlugin = require("webpack/lib/SingleEntryPlugin");

module.exports = function () {};
module.exports.pitch = function (request) {
    const callback = this.async();
    const compiler = this._compilation.createChildCompiler("voice-gate-worklet", {
        filename: "voice-gate.[contenthash].worklet.js",
        chunkFilename: "[id].voice-gate.[contenthash].worklet.js",
    });
    new SingleEntryPlugin(this.context, `!!${request}`, "main").apply(compiler);
    compiler.runAsChild((error, entries) => {
        if (error) return callback(error);
        const filename = entries[0] && [...entries[0].files][0];
        if (!filename) return callback(new Error("Voice gate worklet compilation emitted no asset"));
        callback(null, `module.exports = __webpack_public_path__ + ${JSON.stringify(filename)};`);
    });
};
