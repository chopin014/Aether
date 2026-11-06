/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

#include "vaapi-router.c"
#include <assert.h>

static int selected_backend;

static VAStatus encoder_map(VADriverContextP ctx, VABufferID buffer, void **data) {
    (void)ctx;
    (void)data;
    assert(buffer == (ENCODER_ID_BIT | 7));
    selected_backend = 1;
    return VA_STATUS_SUCCESS;
}

static VAStatus decoder_map(VADriverContextP ctx, VABufferID buffer, void **data, uint32_t flags) {
    (void)ctx;
    (void)data;
    assert(buffer == 7 && flags == 0);
    selected_backend = 2;
    return VA_STATUS_SUCCESS;
}

static VAStatus encoder_surfaces(VADriverContextP ctx, unsigned int format, unsigned int width, unsigned int height,
                                 VASurfaceID *surfaces, unsigned int count, VASurfaceAttrib *attrs, unsigned int n) {
    (void)ctx;
    (void)format;
    (void)width;
    (void)height;
    (void)attrs;
    (void)n;
    assert(count == 1);
    *surfaces = ENCODER_ID_BIT | 3;
    selected_backend = 1;
    return VA_STATUS_SUCCESS;
}

static VAStatus decoder_surfaces(VADriverContextP ctx, unsigned int format, unsigned int width, unsigned int height,
                                 VASurfaceID *surfaces, unsigned int count, VASurfaceAttrib *attrs, unsigned int n) {
    (void)ctx;
    (void)format;
    (void)width;
    (void)height;
    (void)attrs;
    (void)n;
    assert(count == 1);
    *surfaces = 3;
    selected_backend = 2;
    return VA_STATUS_SUCCESS;
}

int main(void) {
    struct VADriverContext context = {0};
    struct VADriverVTable encoder = {0};
    struct route route = {.owner = &context, .encode = {.vtable = &encoder}};
    routes = &route;
    encoder.vaMapBuffer = encoder_map;
    route.decode.vaMapBuffer2 = decoder_map;
    assert(route_vaMapBuffer(&context, ENCODER_ID_BIT | 7, NULL) == VA_STATUS_SUCCESS);
    assert(selected_backend == 1);
    // Newer NVDEC drivers expose MapBuffer2 only; legacy callers still need to map decoder buffers.
    assert(route_vaMapBuffer(&context, 7, NULL) == VA_STATUS_SUCCESS);
    assert(selected_backend == 2);
    assert(route_vaSyncBuffer(&context, ENCODER_ID_BIT | 7, 0) == VA_STATUS_ERROR_UNIMPLEMENTED);

    encoder.vaCreateSurfaces2 = encoder_surfaces;
    route.decode.vaCreateSurfaces2 = decoder_surfaces;
    VASurfaceAttrib usage = {
        .type = VASurfaceAttribUsageHint,
        .value = {.type = VAGenericValueTypeInteger, .value = {.i = VA_SURFACE_ATTRIB_USAGE_HINT_ENCODER}}};
    VASurfaceID surface;
    assert(route_vaCreateSurfaces2(&context, VA_RT_FORMAT_YUV420, 1280, 720, &surface, 1, &usage, 1) ==
           VA_STATUS_SUCCESS);
    assert(selected_backend == 1 && surface == (ENCODER_ID_BIT | 3));
    assert(route_vaCreateSurfaces2(&context, VA_RT_FORMAT_YUV420, 1280, 720, &surface, 1, NULL, 0) ==
           VA_STATUS_SUCCESS);
    assert(selected_backend == 2 && surface == 3);
    return 0;
}
