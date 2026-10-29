# @element-hq/element-web-module-api

API surface for extending Aether in a safe & predictable way.

## Using the API

Modules are loaded by Aether at runtime via a dynamic ecmascript import, but can be bundled into a webapp for deployment convenience.

The module's default export MUST be a class which accepts a single argument, an instance of `ModuleApi`.
This class must also bear a static property `moduleApiVersion` which is a semver range string
and a `load` method which is called when the module is to be loaded.

```typescript
import type { Module, Api, ModuleFactory } from "@element-hq/element-web-module-api";

class ExampleModule implements Module {
    public static readonly moduleApiVersion = "^2.0.0";

    public constructor(private api: Api) {}

    public async load(): Promise<void> {
        // Your extension code goes here
    }
}

export default ExampleModule satisfies ModuleFactory;
```

### Accessing application configuration

The `api` object passed to the module constructor provides access to the application configuration.
You can extend the Config types using declaration merging, though please ensure that you do not trust the types you specify,
and opt for runtime validation due to the dynamic nature of the configuration.

```typescript
// ...
declare module "@element-hq/element-web-module-api" {
    interface Config {
        "this.is.my.config.key": string;
    }
}

class ExampleModule implements Module {
    // ...
    public async load(): Promise<void> {
        const configValue = this.api.config.get("this.is.my.config.key");
        // Your extension code goes here
    }
}
// ...
```

## License

See [upstream notices](../../NOTICE.md#packages-module-api) and the repository license texts.
