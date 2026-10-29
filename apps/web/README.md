# Aether renderer

# Important Security Notes

## Separate domains

We do not recommend running Aether from the same domain name as your Matrix
homeserver. The reason is the risk of XSS (cross-site-scripting)
vulnerabilities that could occur if someone caused Aether to load and render
malicious user generated content from a Matrix API which then had trusted
access to Aether (or other apps) due to sharing the same domain.

We have put some coarse mitigations into place to try to protect against this
situation, but it's still not good practice to do it in the first place. See
<https://github.com/element-hq/element-web/issues/1977> for more details.

## Configuration best practices

Unless you have special requirements, you will want to add the following to
your web server configuration when hosting Aether:

- The `X-Frame-Options: SAMEORIGIN` header, to prevent Aether from being
  framed and protect from [clickjacking][owasp-clickjacking].
- The `frame-ancestors 'self'` directive to your `Content-Security-Policy`
  header, as the modern replacement for `X-Frame-Options` (though both should be
  included since not all browsers support it yet, see
  [this][owasp-clickjacking-csp]).
- The `X-Content-Type-Options: nosniff` header, to [disable MIME
  sniffing][mime-sniffing].
- The `X-XSS-Protection: 1; mode=block;` header, for basic XSS protection in
  legacy browsers.

[mime-sniffing]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Basics_of_HTTP/MIME_types#mime_sniffing
[owasp-clickjacking-csp]: https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html#content-security-policy-frame-ancestors-examples
[owasp-clickjacking]: https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html

If you are using nginx, this would look something like the following:

```
add_header X-Frame-Options SAMEORIGIN;
add_header X-Content-Type-Options nosniff;
add_header X-XSS-Protection "1; mode=block";
add_header Content-Security-Policy "frame-ancestors 'self'";
```

For Apache, the configuration looks like:

```
Header set X-Frame-Options SAMEORIGIN
Header set X-Content-Type-Options nosniff
Header set X-XSS-Protection "1; mode=block"
Header set Content-Security-Policy "frame-ancestors 'self'"
```

Note: In case you are already setting a `Content-Security-Policy` header
elsewhere, you should modify it to include the `frame-ancestors` directive
instead of adding that last line.

# Building from source

This workspace contains Aether's renderer. Its internal Nx name is `element-web`.
Use the [developer guide](../../developer_guide.md) to install dependencies and the
[desktop guide](../../docs/desktop-ui.md) to build and run it inside Aether.

From the repository root, build the renderer with:

```sh
pnpm --filter @element-hq/web-shared-components build
pnpm exec nx run element-web:build
```

Output is written to `apps/web/webapp`. For browser deployment from source, see
[installation](../../docs/install.md). Aether's desktop configuration lives at
`apps/desktop/config.desktop.json`.

# config.json

Aether supports a variety of settings to configure default servers, behaviour, themes, etc.
See the [configuration docs](../../docs/config.md) for more details.

# Labs Features

Some features of Aether may be enabled by flags in the `Labs` section of the settings.
Some of these features are described in [labs.md](../../docs/labs.md).

# Caching requirements

Aether requires the following URLs not to be cached, when/if you are serving Aether from your own webserver:

```
/config.*.json
/i18n
/version
/index.html
```

We also recommend that you force browsers to re-validate any cached copy of Aether on page load by configuring your
webserver to return `Cache-Control: no-cache` for `/`. This ensures the browser will fetch a new version of Aether on
the next page load after it's been deployed. Note that this is already configured for you in the nginx config of our
Dockerfile.

# Development

Please read through the following:

1. [Developer guide](../../developer_guide.md)
2. [Code style](../../code_style.md)
3. [Contribution guide](../../CONTRIBUTING.md)

# Extending Aether with Modules

Aether supports a module system that allows you to extend or modify functionality at runtime. Modules are loaded dynamically and provide a safe, predictable API for customization.

## What are modules?

Modules are extensions that can add or modify Aether's functionality. They are:

- Built using the [`@element-hq/element-web-module-api`](../../packages/module-api/README.md)
- Loaded in EW via [config.json](../../docs/config.md#modules)
