// Copyright 2026 Gabriel
//
// SPDX-License-Identifier: MIT OR Apache-2.0
// Added to tract-linalg 0.21.4 for Aether; licensed like the rest of this crate.

//! WebAssembly SIMD (simd128) matrix-multiply kernels for f32.
//!
//! tract-linalg 0.21.4 ships optimised kernels for x86_64 and ARM only, so WebAssembly ran the scalar generic
//! kernels. These kernels keep one output row per SIMD lane and accumulate each output element exactly like the
//! generic kernels do: a separate multiply then add for every `k`, in ascending order, with no fused multiply-add.
//! IEEE single-precision arithmetic is the same in every lane as in scalar code, so the results are bit-identical
//! to the generic kernels; only the throughput changes. Everything other than the accumulation loop (bias, scaling,
//! clamping, storing) reuses the same element-wise code as the generic kernels.

use core::arch::wasm32::*;

use crate::frame::mmm::kernel::MatMatMulKer;
use crate::frame::mmm::*;
use crate::generic::mmm::{add_unicast, store};
use crate::Ops;

/// Applies every fused operation except the accumulation itself, mirroring the generic kernels' semantics.
macro_rules! fused_non_matmul {
    ($spec: expr, $ab: expr, $mr: expr, $nr: expr) => {
        match $spec {
            FusedKerSpec::Clear => $ab = [[0f32; $nr]; $mr],
            FusedKerSpec::ScalarAdd(a) => for_each(&mut $ab, |_, _, x| a + x),
            FusedKerSpec::ScalarMul(a) => for_each(&mut $ab, |_, _, x| a * x),
            FusedKerSpec::ScalarMin(m) => for_each(&mut $ab, |_, _, x| if m < x { m } else { x }),
            FusedKerSpec::ScalarMax(m) => for_each(&mut $ab, |_, _, x| if m > x { m } else { x }),
            FusedKerSpec::ScalarSub(m) => for_each(&mut $ab, |_, _, x| m - x),
            FusedKerSpec::ScalarSubF(m) => for_each(&mut $ab, |_, _, x| x - m),
            FusedKerSpec::LeakyRelu(m) => for_each(&mut $ab, |_, _, x| if x > 0f32 { x } else { m * x }),
            FusedKerSpec::PerRowMin(m) => for_each(&mut $ab, |i, _, x| {
                let a = *m.add(i);
                if a < x { a } else { x }
            }),
            FusedKerSpec::PerRowMax(m) => for_each(&mut $ab, |i, _, x| {
                let a = *m.add(i);
                if a > x { a } else { x }
            }),
            FusedKerSpec::PerRowAdd(m) => for_each(&mut $ab, |i, _, x| *m.add(i) + x),
            FusedKerSpec::PerRowMul(m) => for_each(&mut $ab, |i, _, x| *m.add(i) * x),
            FusedKerSpec::PerRowSub(m) => for_each(&mut $ab, |i, _, x| *m.add(i) - x),
            FusedKerSpec::PerRowSubF(m) => for_each(&mut $ab, |i, _, x| x - *m.add(i)),
            FusedKerSpec::PerColMin(m) => for_each(&mut $ab, |_, j, x| {
                let a = *m.add(j);
                if a < x { a } else { x }
            }),
            FusedKerSpec::PerColMax(m) => for_each(&mut $ab, |_, j, x| {
                let a = *m.add(j);
                if a > x { a } else { x }
            }),
            FusedKerSpec::PerColAdd(m) => for_each(&mut $ab, |_, j, x| *m.add(j) + x),
            FusedKerSpec::PerColMul(m) => for_each(&mut $ab, |_, j, x| *m.add(j) * x),
            FusedKerSpec::PerColSub(m) => for_each(&mut $ab, |_, j, x| *m.add(j) - x),
            FusedKerSpec::PerColSubF(m) => for_each(&mut $ab, |_, j, x| x - *m.add(j)),
            FusedKerSpec::AddRowColProducts(rows, cols) => {
                for_each(&mut $ab, |i, j, x| x + *rows.add(i) * *cols.add(j))
            }
            FusedKerSpec::AddUnicast(tile) => add_unicast::<f32, _>(&tile, &mut $ab),
            FusedKerSpec::Store(tile) => store(&tile, &$ab),
            // Quantised operations never occur in f32 kernels.
            FusedKerSpec::ShiftLeft(_)
            | FusedKerSpec::RoundingShiftRight(_, _)
            | FusedKerSpec::QScale(_, _, _) => unreachable!(),
            FusedKerSpec::Done | FusedKerSpec::AddMatMul { .. } => unreachable!(),
        }
    };
}

#[inline(always)]
unsafe fn for_each<const MR: usize, const NR: usize>(
    ab: &mut [[f32; NR]; MR],
    f: impl Fn(usize, usize, f32) -> f32,
) {
    for i in 0..MR {
        for j in 0..NR {
            ab[i][j] = f(i, j, ab[i][j]);
        }
    }
}

/// Matrix-vector kernel: 16 rows by 1 column, four rows per SIMD register.
#[derive(Copy, Clone, Debug)]
pub struct WasmMmm16x1;

impl MatMatMulKer<f32> for WasmMmm16x1 {
    fn name() -> &'static str {
        "wasm_simd128_f32_16x1"
    }
    fn mr() -> usize {
        16
    }
    fn nr() -> usize {
        1
    }
    fn alignment_bytes_packed_a() -> usize {
        16
    }
    fn alignment_bytes_packed_b() -> usize {
        4
    }
    fn end_padding_packed_a() -> usize {
        0
    }
    fn end_padding_packed_b() -> usize {
        0
    }
    #[inline(never)]
    fn kernel(spec: &[FusedKerSpec<f32>]) -> isize {
        unsafe {
            let mut ab = [[0f32; 1]; 16];
            let mut pnl = spec.as_ptr();
            loop {
                match *pnl {
                    FusedKerSpec::Done => break,
                    FusedKerSpec::AddMatMul { k, pa, pb, .. } => {
                        let a = pa as *const f32;
                        let b = pb as *const f32;
                        let p = ab.as_mut_ptr() as *mut v128;
                        let (mut c0, mut c1, mut c2, mut c3) =
                            (v128_load(p), v128_load(p.add(1)), v128_load(p.add(2)), v128_load(p.add(3)));
                        for i in 0..k {
                            let bv = f32x4_splat(*b.add(i));
                            let ap = a.add(16 * i) as *const v128;
                            c0 = f32x4_add(c0, f32x4_mul(v128_load(ap), bv));
                            c1 = f32x4_add(c1, f32x4_mul(v128_load(ap.add(1)), bv));
                            c2 = f32x4_add(c2, f32x4_mul(v128_load(ap.add(2)), bv));
                            c3 = f32x4_add(c3, f32x4_mul(v128_load(ap.add(3)), bv));
                        }
                        v128_store(p, c0);
                        v128_store(p.add(1), c1);
                        v128_store(p.add(2), c2);
                        v128_store(p.add(3), c3);
                    }
                    other => fused_non_matmul!(other, ab, 16, 1),
                }
                pnl = pnl.add(1);
            }
        }
        0
    }
}

/// Matrix-matrix kernel: 16 rows by 4 columns, four rows per SIMD register and one register set per column.
#[derive(Copy, Clone, Debug)]
pub struct WasmMmm16x4;

impl MatMatMulKer<f32> for WasmMmm16x4 {
    fn name() -> &'static str {
        "wasm_simd128_f32_16x4"
    }
    fn mr() -> usize {
        16
    }
    fn nr() -> usize {
        4
    }
    fn alignment_bytes_packed_a() -> usize {
        16
    }
    fn alignment_bytes_packed_b() -> usize {
        16
    }
    fn end_padding_packed_a() -> usize {
        0
    }
    fn end_padding_packed_b() -> usize {
        0
    }
    #[inline(never)]
    fn kernel(spec: &[FusedKerSpec<f32>]) -> isize {
        unsafe {
            let mut ab = [[0f32; 4]; 16];
            let mut pnl = spec.as_ptr();
            loop {
                match *pnl {
                    FusedKerSpec::Done => break,
                    FusedKerSpec::AddMatMul { k, pa, pb, .. } => {
                        let a = pa as *const f32;
                        let b = pb as *const f32;
                        // c[q][j] holds rows 4q..4q+3 of column j.
                        let mut c = [[f32x4_splat(0.0); 4]; 4];
                        for q in 0..4 {
                            for j in 0..4 {
                                c[q][j] = f32x4(ab[4 * q][j], ab[4 * q + 1][j], ab[4 * q + 2][j], ab[4 * q + 3][j]);
                            }
                        }
                        for i in 0..k {
                            let ap = a.add(16 * i) as *const v128;
                            let (a0, a1, a2, a3) =
                                (v128_load(ap), v128_load(ap.add(1)), v128_load(ap.add(2)), v128_load(ap.add(3)));
                            let bp = b.add(4 * i);
                            for j in 0..4 {
                                let bv = f32x4_splat(*bp.add(j));
                                c[0][j] = f32x4_add(c[0][j], f32x4_mul(a0, bv));
                                c[1][j] = f32x4_add(c[1][j], f32x4_mul(a1, bv));
                                c[2][j] = f32x4_add(c[2][j], f32x4_mul(a2, bv));
                                c[3][j] = f32x4_add(c[3][j], f32x4_mul(a3, bv));
                            }
                        }
                        for q in 0..4 {
                            for j in 0..4 {
                                ab[4 * q][j] = f32x4_extract_lane::<0>(c[q][j]);
                                ab[4 * q + 1][j] = f32x4_extract_lane::<1>(c[q][j]);
                                ab[4 * q + 2][j] = f32x4_extract_lane::<2>(c[q][j]);
                                ab[4 * q + 3][j] = f32x4_extract_lane::<3>(c[q][j]);
                            }
                        }
                    }
                    other => fused_non_matmul!(other, ab, 16, 4),
                }
                pnl = pnl.add(1);
            }
        }
        0
    }
}

/// Uses the SIMD kernels for f32 matrix products; other types keep the generic kernels.
pub fn plug(ops: &mut Ops) {
    ops.mmm_f32_impls = vec![WasmMmm16x4::mmm()];
    ops.mmm_f32 = Box::new(|_, _, _| WasmMmm16x4::mmm());
    ops.mmv_f32 = Box::new(|_, _| WasmMmm16x1::mmm());
}
