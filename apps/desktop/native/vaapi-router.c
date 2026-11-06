/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <va/va_backend.h>
// NVENC resources use the high bit so their IDs and embedded H.264 references cannot alias NVDEC resources.
#define ENCODER_ID_BIT 0x80000000U
struct route {
    VADriverContextP owner;
    struct VADriverContext encode;
    struct VADriverVTable decode;
    struct route *next;
};
static struct route *routes;
static pthread_mutex_t route_lock = PTHREAD_MUTEX_INITIALIZER;
static struct route *find(VADriverContextP ctx) {
    pthread_mutex_lock(&route_lock);
    struct route *r = routes;
    while (r && r->owner != ctx)
        r = r->next;
    pthread_mutex_unlock(&route_lock);
    return r;
}
// Retain backend handles while their VA-API callbacks can be called.
static void *nvenc_library, *nvdec_library;
static pthread_mutex_t library_lock = PTHREAD_MUTEX_INITIALIZER;
static void *open_backend(const char *path, void **slot) {
    pthread_mutex_lock(&library_lock);
    if (!*slot)
        *slot = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    void *library = *slot;
    pthread_mutex_unlock(&library_lock);
    return library;
}
static VAStatus initialize(VADriverContextP ctx, void *library) {
    if (!library)
        return VA_STATUS_ERROR_OPERATION_FAILED;
    for (int i = 24; i >= 0; --i) {
        char name[64];
        snprintf(name, sizeof(name), "__vaDriverInit_1_%d", i);
        VAStatus (*init)(VADriverContextP) = dlsym(library, name);
        if (init)
            return init(ctx);
    }
    return VA_STATUS_ERROR_OPERATION_FAILED;
}
static void *open_nvenc(void) {
    Dl_info location;
    if (!dladdr((void *)open_nvenc, &location))
        return NULL;
    char path[4096];
    if (strlen(location.dli_fname) >= sizeof(path))
        return NULL;
    strcpy(path, location.dli_fname);
    char *base = strrchr(path, '/');
    if (!base)
        return NULL;
    size_t available = sizeof(path) - (size_t)(base + 1 - path);
    if (snprintf(base + 1, available, "nvidia_nvenc_drv_video.so") >= (int)available)
        return NULL;
    return open_backend(path, &nvenc_library);
}
static void *open_nvdec(void) {
    const char *paths[] = {"/usr/lib/dri/nvidia_drv_video.so", "/usr/lib64/dri/nvidia_drv_video.so",
                           "/usr/lib/x86_64-linux-gnu/dri/nvidia_drv_video.so",
                           "/usr/lib/aarch64-linux-gnu/dri/nvidia_drv_video.so"};
    for (size_t i = 0; i < sizeof(paths) / sizeof(paths[0]); i++) {
        void *library = open_backend(paths[i], &nvdec_library);
        if (library)
            return library;
    }
    return NULL;
}
static VAStatus profiles(VADriverContextP ctx, VAProfile *p, int *n) {
    struct route *r = find(ctx);
    VAStatus s = r->decode.vaQueryConfigProfiles(ctx, p, n);
    if (s)
        return s;
    VAProfile enc[8];
    int count = 0;
    s = r->encode.vtable->vaQueryConfigProfiles(&r->encode, enc, &count);
    if (s)
        return s;
    for (int i = 0; i < count; ++i) {
        int found = 0;
        for (int j = 0; j < *n; ++j)
            if (p[j] == enc[i])
                found = 1;
        if (!found)
            p[(*n)++] = enc[i];
    }
    return VA_STATUS_SUCCESS;
}
static VAStatus entrypoints(VADriverContextP ctx, VAProfile p, VAEntrypoint *e, int *n) {
    struct route *r = find(ctx);
    VAStatus s = r->decode.vaQueryConfigEntrypoints(ctx, p, e, n);
    if (s)
        *n = 0;
    VAEntrypoint enc[4];
    int count = 0;
    VAStatus es = r->encode.vtable->vaQueryConfigEntrypoints(&r->encode, p, enc, &count);
    if (es == VA_STATUS_SUCCESS) {
        for (int i = 0; i < count; ++i) {
            int found = 0;
            for (int j = 0; j < *n; ++j)
                if (e[j] == enc[i])
                    found = 1;
            if (!found)
                e[(*n)++] = enc[i];
        }
        return VA_STATUS_SUCCESS;
    }
    return s;
}
static VAStatus get_attrs(VADriverContextP ctx, VAProfile p, VAEntrypoint e, VAConfigAttrib *a, int n) {
    struct route *r = find(ctx);
    return e == VAEntrypointEncSlice ? r->encode.vtable->vaGetConfigAttributes(&r->encode, p, e, a, n)
                                     : r->decode.vaGetConfigAttributes(ctx, p, e, a, n);
}
static VAStatus create_config(VADriverContextP ctx, VAProfile p, VAEntrypoint e, VAConfigAttrib *a, int n,
                              VAConfigID *c) {
    struct route *r = find(ctx);
    if (e != VAEntrypointEncSlice)
        return r->decode.vaCreateConfig(ctx, p, e, a, n, c);
    return r->encode.vtable->vaCreateConfig(&r->encode, p, e, a, n, c);
}
static VAStatus destroy_config(VADriverContextP ctx, VAConfigID c) {
    struct route *r = find(ctx);
    return (c & ENCODER_ID_BIT) ? r->encode.vtable->vaDestroyConfig(&r->encode, c) : r->decode.vaDestroyConfig(ctx, c);
}
static VAStatus query_config(VADriverContextP ctx, VAConfigID c, VAProfile *p, VAEntrypoint *e, VAConfigAttrib *a,
                             int *n) {
    struct route *r = find(ctx);
    return (c & ENCODER_ID_BIT) ? r->encode.vtable->vaQueryConfigAttributes(&r->encode, c, p, e, a, n)
                                : r->decode.vaQueryConfigAttributes(ctx, c, p, e, a, n);
}
static VAStatus query_surfaces(VADriverContextP ctx, VAConfigID c, VASurfaceAttrib *a, unsigned int *n) {
    struct route *r = find(ctx);
    return (c & ENCODER_ID_BIT) ? r->encode.vtable->vaQuerySurfaceAttributes(&r->encode, c, a, n)
                                : r->decode.vaQuerySurfaceAttributes(ctx, c, a, n);
}
static VAStatus terminate(VADriverContextP ctx) {
    struct route *r = find(ctx);
    VAStatus s = r->decode.vaTerminate(ctx);
    r->encode.vtable->vaTerminate(&r->encode);
    free(r->encode.vtable);
    pthread_mutex_lock(&route_lock);
    struct route **p = &routes;
    while (*p && *p != r)
        p = &(*p)->next;
    if (*p)
        *p = r->next;
    pthread_mutex_unlock(&route_lock);
    free(r);
    return s;
}
// Resource IDs retain their namespace inside parameter buffers, so dispatch never rewrites H.264 references.
#define ROUTE_RESOURCE(name, id, parameters, arguments)                                                                \
    static VAStatus route_##name parameters {                                                                          \
        struct route *r = find(ctx);                                                                                   \
        int encoding = ((id) & ENCODER_ID_BIT) != 0;                                                                   \
        VADriverContextP driver = encoding ? &r->encode : ctx;                                                         \
        struct VADriverVTable *table = encoding ? r->encode.vtable : &r->decode;                                       \
        return table->name ? table->name arguments : VA_STATUS_ERROR_UNIMPLEMENTED;                                    \
    }

ROUTE_RESOURCE(vaCreateContext, config_id,
               (VADriverContextP ctx, VAConfigID config_id, int picture_width, int picture_height, int flag,
                VASurfaceID *render_targets, int num_render_targets, VAContextID *context),
               (driver, config_id, picture_width, picture_height, flag, render_targets, num_render_targets, context))

ROUTE_RESOURCE(vaDestroyContext, context, (VADriverContextP ctx, VAContextID context), (driver, context))

ROUTE_RESOURCE(vaCreateBuffer, context,
               (VADriverContextP ctx, VAContextID context, VABufferType type, unsigned int size,
                unsigned int num_elements, void *data, VABufferID *buf_id),
               (driver, context, type, size, num_elements, data, buf_id))

ROUTE_RESOURCE(vaBufferSetNumElements, buf_id, (VADriverContextP ctx, VABufferID buf_id, unsigned int num_elements),
               (driver, buf_id, num_elements))

static VAStatus route_vaMapBuffer(VADriverContextP ctx, VABufferID buf_id, void **pbuf) {
    struct route *r = find(ctx);
    if ((buf_id)&ENCODER_ID_BIT) {
        if (!r->encode.vtable->vaMapBuffer)
            return VA_STATUS_ERROR_UNIMPLEMENTED;
        return r->encode.vtable->vaMapBuffer(&r->encode, buf_id, pbuf);
    }
    if (!r->decode.vaMapBuffer)
        return r->decode.vaMapBuffer2 ? r->decode.vaMapBuffer2(ctx, buf_id, pbuf, 0) : VA_STATUS_ERROR_UNIMPLEMENTED;
    return r->decode.vaMapBuffer(ctx, buf_id, pbuf);
}

static VAStatus route_vaMapBuffer2(VADriverContextP ctx, VABufferID buf_id, void **pbuf, uint32_t flags) {
    struct route *r = find(ctx);
    if ((buf_id)&ENCODER_ID_BIT) {
        if (!r->encode.vtable->vaMapBuffer2)
            return VA_STATUS_ERROR_UNIMPLEMENTED;
        return r->encode.vtable->vaMapBuffer2(&r->encode, buf_id, pbuf, flags);
    }
    if (!r->decode.vaMapBuffer2)
        return r->decode.vaMapBuffer ? r->decode.vaMapBuffer(ctx, buf_id, pbuf) : VA_STATUS_ERROR_UNIMPLEMENTED;
    return r->decode.vaMapBuffer2(ctx, buf_id, pbuf, flags);
}

ROUTE_RESOURCE(vaUnmapBuffer, buf_id, (VADriverContextP ctx, VABufferID buf_id), (driver, buf_id))

ROUTE_RESOURCE(vaDestroyBuffer, buffer_id, (VADriverContextP ctx, VABufferID buffer_id), (driver, buffer_id))

ROUTE_RESOURCE(vaBufferInfo, buf_id,
               (VADriverContextP ctx, VABufferID buf_id, VABufferType *type, unsigned int *size,
                unsigned int *num_elements),
               (driver, buf_id, type, size, num_elements))

ROUTE_RESOURCE(vaBeginPicture, context, (VADriverContextP ctx, VAContextID context, VASurfaceID render_target),
               (driver, context, render_target))

ROUTE_RESOURCE(vaRenderPicture, context,
               (VADriverContextP ctx, VAContextID context, VABufferID *buffers, int num_buffers),
               (driver, context, buffers, num_buffers))

ROUTE_RESOURCE(vaEndPicture, context, (VADriverContextP ctx, VAContextID context), (driver, context))

ROUTE_RESOURCE(vaSyncSurface, render_target, (VADriverContextP ctx, VASurfaceID render_target), (driver, render_target))

static VAStatus route_vaSyncSurface2(VADriverContextP ctx, VASurfaceID surface, uint64_t timeout_ns) {
    struct route *r = find(ctx);
    if ((surface)&ENCODER_ID_BIT) {
        if (!r->encode.vtable->vaSyncSurface2)
            return VA_STATUS_ERROR_UNIMPLEMENTED;
        return r->encode.vtable->vaSyncSurface2(&r->encode, surface, timeout_ns);
    }
    if (!r->decode.vaSyncSurface2)
        return r->decode.vaSyncSurface ? r->decode.vaSyncSurface(ctx, surface) : VA_STATUS_ERROR_UNIMPLEMENTED;
    return r->decode.vaSyncSurface2(ctx, surface, timeout_ns);
}

ROUTE_RESOURCE(vaSyncBuffer, buf_id, (VADriverContextP ctx, VABufferID buf_id, uint64_t timeout_ns),
               (driver, buf_id, timeout_ns))

ROUTE_RESOURCE(vaQuerySurfaceStatus, render_target,
               (VADriverContextP ctx, VASurfaceID render_target, VASurfaceStatus *status),
               (driver, render_target, status))

ROUTE_RESOURCE(vaDeriveImage, surface, (VADriverContextP ctx, VASurfaceID surface, VAImage *image),
               (driver, surface, image))

ROUTE_RESOURCE(vaCreateImage, ENCODER_ID_BIT,
               (VADriverContextP ctx, VAImageFormat *format, int width, int height, VAImage *image),
               (driver, format, width, height, image))

ROUTE_RESOURCE(vaDestroyImage, image, (VADriverContextP ctx, VAImageID image), (driver, image))

ROUTE_RESOURCE(vaSetImagePalette, image, (VADriverContextP ctx, VAImageID image, unsigned char *palette),
               (driver, image, palette))

ROUTE_RESOURCE(vaGetImage, surface,
               (VADriverContextP ctx, VASurfaceID surface, int x, int y, unsigned int width, unsigned int height,
                VAImageID image),
               (driver, surface, x, y, width, height, image))

ROUTE_RESOURCE(vaPutImage, surface,
               (VADriverContextP ctx, VASurfaceID surface, VAImageID image, int src_x, int src_y,
                unsigned int src_width, unsigned int src_height, int dest_x, int dest_y, unsigned int dest_width,
                unsigned int dest_height),
               (driver, surface, image, src_x, src_y, src_width, src_height, dest_x, dest_y, dest_width, dest_height))

static VAStatus route_vaDestroySurfaces(VADriverContextP ctx, VASurfaceID *surface_list, int num_surfaces) {
    struct route *r = find(ctx);
    for (int i = 1; i < num_surfaces; i++) {
        if ((surface_list[i] & ENCODER_ID_BIT) != (surface_list[0] & ENCODER_ID_BIT))
            return VA_STATUS_ERROR_INVALID_SURFACE;
    }
    if ((num_surfaces ? surface_list[0] : 0) & ENCODER_ID_BIT) {
        if (!r->encode.vtable->vaDestroySurfaces)
            return VA_STATUS_ERROR_UNIMPLEMENTED;
        return r->encode.vtable->vaDestroySurfaces(&r->encode, surface_list, num_surfaces);
    }
    if (!r->decode.vaDestroySurfaces)
        return VA_STATUS_ERROR_UNIMPLEMENTED;
    return r->decode.vaDestroySurfaces(ctx, surface_list, num_surfaces);
}

ROUTE_RESOURCE(vaExportSurfaceHandle, surface_id,
               (VADriverContextP ctx, VASurfaceID surface_id, uint32_t mem_type, uint32_t flags, void *descriptor),
               (driver, surface_id, mem_type, flags, descriptor))

ROUTE_RESOURCE(vaAcquireBufferHandle, buf_id, (VADriverContextP ctx, VABufferID buf_id, VABufferInfo *buf_info),
               (driver, buf_id, buf_info))

ROUTE_RESOURCE(vaReleaseBufferHandle, buf_id, (VADriverContextP ctx, VABufferID buf_id), (driver, buf_id))

static VAStatus route_vaCreateSurfaces2(VADriverContextP ctx, unsigned int format, unsigned int width,
                                        unsigned int height, VASurfaceID *surfaces, unsigned int count,
                                        VASurfaceAttrib *attrs, unsigned int num_attrs) {
    struct route *r = find(ctx);
    unsigned int usage = 0;
    for (unsigned int i = 0; i < num_attrs; i++)
        if (attrs[i].type == VASurfaceAttribUsageHint)
            usage = attrs[i].value.value.i;
    if (usage & VA_SURFACE_ATTRIB_USAGE_HINT_ENCODER)
        return r->encode.vtable->vaCreateSurfaces2(&r->encode, format, width, height, surfaces, count, attrs,
                                                   num_attrs);
    return r->decode.vaCreateSurfaces2(ctx, format, width, height, surfaces, count, attrs, num_attrs);
}
// Combine the installed NVDEC backend with bundled NVENC encoding on one VA display.
__attribute__((visibility("default"))) VAStatus __vaDriverInit_1_0(VADriverContextP ctx) {
    void *encoder = open_nvenc();
    if (!encoder)
        return VA_STATUS_ERROR_OPERATION_FAILED;
    void *decoder = open_nvdec();
    if (!decoder)
        return initialize(ctx, encoder);
    VAStatus s = initialize(ctx, decoder);
    if (s)
        return initialize(ctx, encoder);
    struct route *r = calloc(1, sizeof(*r));
    if (!r) {
        ctx->vtable->vaTerminate(ctx);
        return VA_STATUS_ERROR_ALLOCATION_FAILED;
    }
    r->owner = ctx;
    r->decode = *ctx->vtable;
    r->encode = *ctx;
    r->encode.pDriverData = NULL;
    r->encode.vtable = calloc(1, sizeof(struct VADriverVTable));
    if (!r->encode.vtable) {
        ctx->vtable->vaTerminate(ctx);
        free(r);
        return VA_STATUS_ERROR_ALLOCATION_FAILED;
    }
    s = initialize(&r->encode, encoder);
    if (s) {
        free(r->encode.vtable);
        free(r);
        return VA_STATUS_SUCCESS;
    }
    ctx->max_profiles += r->encode.max_profiles;
    ctx->max_entrypoints += r->encode.max_entrypoints;
    if (ctx->max_attributes < r->encode.max_attributes)
        ctx->max_attributes = r->encode.max_attributes;
    ctx->str_vendor = "Aether NVIDIA VAAPI";
    pthread_mutex_lock(&route_lock);
    r->next = routes;
    routes = r;
    pthread_mutex_unlock(&route_lock);
    ctx->vtable->vaQueryConfigProfiles = profiles;
    ctx->vtable->vaQueryConfigEntrypoints = entrypoints;
    ctx->vtable->vaGetConfigAttributes = get_attrs;
    ctx->vtable->vaCreateConfig = create_config;
    ctx->vtable->vaDestroyConfig = destroy_config;
    ctx->vtable->vaQueryConfigAttributes = query_config;
    ctx->vtable->vaQuerySurfaceAttributes = query_surfaces;
    ctx->vtable->vaTerminate = terminate;
    ctx->vtable->vaCreateContext = route_vaCreateContext;
    ctx->vtable->vaDestroyContext = route_vaDestroyContext;
    ctx->vtable->vaCreateBuffer = route_vaCreateBuffer;
    ctx->vtable->vaBufferSetNumElements = route_vaBufferSetNumElements;
    ctx->vtable->vaMapBuffer = route_vaMapBuffer;
    ctx->vtable->vaMapBuffer2 = route_vaMapBuffer2;
    ctx->vtable->vaUnmapBuffer = route_vaUnmapBuffer;
    ctx->vtable->vaDestroyBuffer = route_vaDestroyBuffer;
    ctx->vtable->vaBufferInfo = route_vaBufferInfo;
    ctx->vtable->vaBeginPicture = route_vaBeginPicture;
    ctx->vtable->vaRenderPicture = route_vaRenderPicture;
    ctx->vtable->vaEndPicture = route_vaEndPicture;
    ctx->vtable->vaSyncSurface = route_vaSyncSurface;
    ctx->vtable->vaSyncSurface2 = route_vaSyncSurface2;
    ctx->vtable->vaSyncBuffer = route_vaSyncBuffer;
    ctx->vtable->vaQuerySurfaceStatus = route_vaQuerySurfaceStatus;
    ctx->vtable->vaDeriveImage = route_vaDeriveImage;
    ctx->vtable->vaCreateImage = route_vaCreateImage;
    ctx->vtable->vaDestroyImage = route_vaDestroyImage;
    ctx->vtable->vaSetImagePalette = route_vaSetImagePalette;
    ctx->vtable->vaGetImage = route_vaGetImage;
    ctx->vtable->vaPutImage = route_vaPutImage;
    ctx->vtable->vaDestroySurfaces = route_vaDestroySurfaces;
    ctx->vtable->vaExportSurfaceHandle = route_vaExportSurfaceHandle;
    ctx->vtable->vaAcquireBufferHandle = route_vaAcquireBufferHandle;
    ctx->vtable->vaReleaseBufferHandle = route_vaReleaseBufferHandle;
    ctx->vtable->vaCreateSurfaces2 = route_vaCreateSurfaces2;
    return VA_STATUS_SUCCESS;
}
