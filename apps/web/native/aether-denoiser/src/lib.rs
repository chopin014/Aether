// Copyright 2026 Gabriel
//
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
// Please see LICENSE in the repository root for full details.

//! DeepFilterNet3 noise suppression with a plain C interface, so an audio worklet can call it without
//! JavaScript glue or allocating while it runs: the caller allocates two frame buffers once and reuses them.

use df::tract::{DfParams, DfTract, RuntimeParams};
use ndarray::{ArrayView2, ArrayViewMut2};

/// Allocates `len` zeroed samples that live as long as the module. Used once for each frame buffer.
#[no_mangle]
pub extern "C" fn denoiser_alloc(len: usize) -> *mut f32 {
    Box::leak(vec![0f32; len].into_boxed_slice()).as_mut_ptr()
}

/// Loads the built-in model at 48 kHz, mono. Noise is reduced by at most `atten_lim_db`; 100 or more is unlimited.
#[no_mangle]
pub extern "C" fn denoiser_create(atten_lim_db: f32) -> *mut DfTract {
    let params = RuntimeParams::default_with_ch(1).with_atten_lim(atten_lim_db);
    let df = DfTract::new(DfParams::default(), &params).expect("could not load DeepFilterNet");
    Box::into_raw(Box::new(df))
}

/// The number of samples [`denoiser_process`] takes and returns at a time (10 ms).
///
/// # Safety
/// `st` must come from [`denoiser_create`].
#[no_mangle]
pub unsafe extern "C" fn denoiser_frame_length(st: *mut DfTract) -> usize {
    (*st).hop_size
}

/// # Safety
/// `st` must come from [`denoiser_create`].
#[no_mangle]
pub unsafe extern "C" fn denoiser_set_atten_lim(st: *mut DfTract, atten_lim_db: f32) {
    (*st).set_atten_lim(atten_lim_db)
}

/// Denoises one frame. The output is delayed by the model's look-ahead, while the returned estimate of how far
/// speech stands above the noise, in dB, describes the newest input: it leads the output by about 30 ms.
///
/// # Safety
/// `st` must come from [`denoiser_create`]; `input` and `output` must each hold a frame and must not overlap.
#[no_mangle]
pub unsafe extern "C" fn denoiser_process(st: *mut DfTract, input: *const f32, output: *mut f32) -> f32 {
    let df = &mut *st;
    let n = df.hop_size;
    let input = ArrayView2::from_shape((1, n), std::slice::from_raw_parts(input, n)).unwrap();
    let output = ArrayViewMut2::from_shape((1, n), std::slice::from_raw_parts_mut(output, n)).unwrap();
    df.process(input, output).expect("DeepFilterNet could not process a frame")
}

/// A fixed xorshift sequence. Hash map seeds are the only consumer, and they need no secrecy here.
fn fill_random(buf: &mut [u8]) -> Result<(), getrandom::Error> {
    static mut STATE: u64 = 0x9e37_79b9_7f4a_7c15;
    for byte in buf {
        // SAFETY: the module runs on the single audio thread of its worklet.
        unsafe {
            STATE ^= STATE << 13;
            STATE ^= STATE >> 7;
            STATE ^= STATE << 17;
            *byte = STATE as u8;
        }
    }
    Ok(())
}
getrandom::register_custom_getrandom!(fill_random);
