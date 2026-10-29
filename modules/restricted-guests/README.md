# @element-hq/element-web-module-restricted-guests

Restricted Guests module for Aether.

Supports the following configuration options under the configuration key `io.element.element-web-modules.restricted-guests`:

| Key                       | Type    | Description                                                                                                                                     |
| ------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| guest_user_homeserver_url | string  | URL of the homeserver on which to register the guest, must be running the synapse module.                                                       |
| guest_user_prefix         | string  | Prefix to apply to all guests registered via the module, defaults to `@guest-`.                                                                 |
| skip_single_sign_on       | boolean | If true, the user will be forwarded to the login page instead of to the SSO login. This is only required if the home server has no SSO support. |

## Knocking ("ask to join") has to be enabled

In order to make the feature work, **knocking has to be enabled** via config.json

```
"features": {
  "feature_ask_to_join": true
}
```

## Facilitating how users can obtain the room link

If you want to make it more obvious to users how to copy the link, you can modify the link a user gets from "Copy link" in the right sidebar by using `permalink_prefix` in config.json. If you don't do that, users will have to copy the URL from the address bar.

## License

See [upstream notices](../../NOTICE.md#modules-restricted-guests) and the repository license texts.
