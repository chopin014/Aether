#!/usr/bin/env bash
# Copyright 2026 Gabriel
#
# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
# Please see LICENSE in the repository root for full details.

# Rebuilds src/audio/desktop/denoiser/aether-denoiser.wasm from this crate in a pinned Rust container, so the
# result does not depend on the local toolchain. Needs Docker (or Podman as `docker`).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../src/audio/desktop/denoiser/aether-denoiser.wasm"
image="rust:1.99.1"

docker run --rm \
    -v "$here":/src \
    -v aether-denoiser-cargo:/usr/local/cargo/registry \
    -w /src \
    -e RUSTFLAGS="-C target-feature=+simd128" \
    "$image" \
    bash -c "rustup target add wasm32-unknown-unknown && cargo build --locked --release --target wasm32-unknown-unknown && chown -R $(id -u):$(id -g) target"

cp "$here/target/wasm32-unknown-unknown/release/aether_denoiser.wasm" "$out"
ls -l "$out"
