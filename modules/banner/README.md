# @element-hq/element-web-module-banner

Banner module for Aether.
Allows rendering a top bar with slide out left panel menu.

Supports the following configuration options:

| Key          | Type   | Description                                                                                    |
| ------------ | ------ | ---------------------------------------------------------------------------------------------- |
| logo_url     | string | URL to the logo to render in the banner                                                        |
| heading_href | string | URL to send the user to when clicking the logo or title in the banner                          |
| title        | string | The title to render next to the logo, falls back to top level `brand` variable if unspecified. |
| menu         | `Menu` | Data to render in the banner menu                                                              |

The `Menu` type is fulfilled by the following discriminated union:

### Univention menu

| Key     | Type         | Description                                                                                                              |
| ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| type    | "univention" | The type for this menu config                                                                                            |
| ics_url | string       | URL to the UCS Intercom Service, https://docs.software-univention.de/intercom-service/latest/architecture.html#endpoints |

### Static menu

| Key        | Type         | Description                      |
| ---------- | ------------ | -------------------------------- |
| type       | "static"     | The type for this menu config    |
| categories | `[]Category` | Categories to render in the menu |

The `Category` type is fulfilled by the following interface:

| Key   | Type     | Description                      |
| ----- | -------- | -------------------------------- |
| name  | string   | The name of this category        |
| links | `[]Link` | Links to render in this category |

The `Link` type is fulfilled by the following interface:

| Key      | Type             | Description                             |
| -------- | ---------------- | --------------------------------------- |
| icon_uri | string           | URL to the icon to render for this link |
| name     | string           | The name to render for this link        |
| link_url | string           | The URL to link to                      |
| target   | string, optional | The `target` to use for this link       |

### All menus additionally support the following optional keys:

| Key         | Type             | Description                                                               |
| ----------- | ---------------- | ------------------------------------------------------------------------- |
| logo_url    | string, optional | URL to the logo to render in the menu, defaults to banner logo if omitted |
| logo_href   | string, optional | URL to send the user to when clicking the logo in the menu                |
| logo_height | number, optional | Height of the logo in pixels, defaults to 32 if omitted                   |

## Theming

Most of the styles can be configured via the `theme` variable in the top level config. All values are optional strings.
The following theme variables are used by this module:

| Key                              | Default                                      | Description                                                   |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| textColor                        | var(--cpd-color-text-primary)                | Colour of the banner text and menu button text                |
| subheadingColor                  | var(--cpd-color-text-secondary)              | Colour of the subheading text in the menu                     |
| bannerBackgroundColor            | var(--cpd-color-bg-canvas-default)           | Background colour of the banner                               |
| bannerHeight                     | 60px                                         | Height of the banner                                          |
| triggerWidth                     | 69px                                         | Width of the trigger button                                   |
| triggerBackgroundColor           | var(--cpd-color-bg-subtle-secondary)         | Background colour of the trigger button                       |
| triggerBackgroundColorHover      | var(--cpd-color-bg-accent-hovered)           | Background colour of the trigger button when hovered          |
| triggerBackgroundColorPressed    | var(--cpd-color-bg-accent-pressed)           | Background colour of the trigger button when pressed          |
| triggerColor                     | var(--cpd-color-icon-primary)                | Colour of the trigger button icon                             |
| triggerColorContrast             | var(--cpd-color-icon-on-solid-primary)       | Colour of the trigger button icon when hovered/pressed        |
| menuWidth                        | 320px                                        | Width of the popover menu when open                           |
| menuBackgroundColor              | var(--cpd-color-bg-canvas-default)           | Background colour of the popover menu                         |
| menuButtonColor                  | var(--cpd-color-text-primary)                | Colour of the button text inside the menu                     |
| menuButtonBackgroundColorHover   | var(--cpd-color-bg-action-secondary-hovered) | Background colour of the buttons inside the menu when hovered |
| menuButtonBackgroundColorPressed | var(--cpd-color-bg-action-secondary-pressed) | Background colour of the buttons inside the menu when pressed |

## License

See [upstream notices](../../NOTICE.md#modules-banner) and the repository license texts.
