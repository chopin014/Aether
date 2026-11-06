/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

use nvidia_video_codec_sdk::sys::nvEncodeAPI as nv;
use std::sync::OnceLock;

// Load the user's driver at runtime; building the bridge needs neither an NVIDIA GPU nor its proprietary libraries.
fn symbol(name: &'static std::ffi::CStr) -> *mut libc::c_void {
    static LIBRARY: OnceLock<usize> = OnceLock::new();
    let library = *LIBRARY.get_or_init(|| unsafe {
        libc::dlopen(c"libnvidia-encode.so.1".as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) as usize
    });
    if library == 0 {
        return std::ptr::null_mut();
    }
    // The handle stays open for the lifetime of the encoder's function table.
    unsafe { libc::dlsym(library as *mut libc::c_void, name.as_ptr()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn NvEncodeAPICreateInstance(table: *mut nv::NV_ENCODE_API_FUNCTION_LIST) -> nv::NVENCSTATUS {
    let address = symbol(c"NvEncodeAPICreateInstance");
    if address.is_null() {
        return nv::NVENCSTATUS::NV_ENC_ERR_NO_ENCODE_DEVICE;
    }
    let create: unsafe extern "C" fn(*mut nv::NV_ENCODE_API_FUNCTION_LIST) -> nv::NVENCSTATUS =
        unsafe { std::mem::transmute(address) };
    unsafe { create(table) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn NvEncodeAPIGetMaxSupportedVersion(version: *mut u32) -> nv::NVENCSTATUS {
    let address = symbol(c"NvEncodeAPIGetMaxSupportedVersion");
    if address.is_null() {
        return nv::NVENCSTATUS::NV_ENC_ERR_NO_ENCODE_DEVICE;
    }
    let get: unsafe extern "C" fn(*mut u32) -> nv::NVENCSTATUS = unsafe { std::mem::transmute(address) };
    unsafe { get(version) }
}
