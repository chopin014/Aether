# Media handling

Surely media should be as easy as just putting a URL into an `img` and calling it good, right?
Not quite. Matrix uses something called a Matrix Content URI (better known as MXC URI) to identify
content, which is then converted to a regular HTTPS URL on the homeserver. However, sometimes that
URL can change depending on deployment considerations.

Use the media helpers in `apps/web/src/customisations/Media.ts` for conversions from MXC URIs to HTTPS URLs.
This keeps authenticated downloads and deployment-specific media routing consistent.

For development, there are currently two functions available: `mediaFromMxc` and `mediaFromContent`.
The `mediaFromMxc` function should be self-explanatory. `mediaFromContent` takes an event content as
a parameter and will automatically parse out the source media and thumbnail. Both functions return
a `Media` object with a number of options on it, such as getting various common HTTPS URLs for the
media.

**It is extremely important that all media calls are put through this customisation endpoint.** So
much so it's a lint rule to avoid accidental use of the wrong functions.
