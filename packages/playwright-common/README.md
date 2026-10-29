# @element-hq/element-web-playwright-common

Set of Playwright & testcontainers utilities to make it easier to write tests for Aether, Aether Modules & Aether desktop.

The main export includes a number of fixtures and custom assertions as documented in JSDoc.

The `lib/testcontainers` export contains the following modules:

- `SynapseContainer` - A testcontainer for running a Synapse server
- `MatrixAuthenticationServiceContainer` - A testcontainer for running a Matrix Authentication Service
- `MailpitContainer` - A testcontainer for running a Mailpit SMTP server

There are a number of utils available in the `lib/utils` export.

## License

See [upstream notices](../../NOTICE.md#packages-playwright-common) and the repository license texts.
