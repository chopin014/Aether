# @element-hq/element-web-shared-utils

Standalone, utilities shared by Aether projects.

The package provides:

- string-based HTML sanitization and URL validation for untrusted
  Matrix-compatible formatted content
- copying plain text to the clipboard
- email address validation

It is designed to work in Aether as well as in external JavaScript and
TypeScript packages.

## Usage

```ts
import { isUrlPermitted, sanitizeHtml } from "@element-hq/element-web-shared-utils";

const safeHtml = sanitizeHtml(untrustedHtml);
const canOpen = isUrlPermitted(untrustedUrl);
```

The package does not import React or depend on Aether application code.

## Rendering transforms

The default sanitizer applies the shared Aether rendering and safety
policy, including safe link handling, MXC-only images, and removal of inline
styles. The `transformTags` option is a trusted application extension point:
providing a transform for a tag replaces that tag's shared rendering transform.
Applications should only use this for a deliberately narrower or explicitly
trusted rendering context. Anchor URL validation and the sanitizer's attribute
and URL checks remain active.

## License

See [upstream notices](../../NOTICE.md#packages-shared-utils) and the repository license texts.
