# Windows

## Requirements to build

Aether builds Windows x64 installers through the [desktop workflow](https://github.com/chopin014/Aether/actions/workflows/aether-desktop.yaml).

If you want to build Aether desktop on Windows, make sure that the following tools are installed on your system.

- [Git for Windows](https://git-scm.com/download/win)
- [Node](https://nodejs.org) (see `apps/desktop/.node-version` for the version we build with)
- [pnpm](https://pnpm.io/installation)

You can install the above tools using [Chocolatey](https://chocolatey.org/install):

```cmd
choco install --no-progress -y git nodejs-lts pnpm
```

Once installed make sure all those utilities are accessible in your `PATH`.

Native modules are consumed as prebuilt binaries, so no compiler toolchain is required.
See [native-node-modules.md](./native-node-modules.md) for details, including how to
inspect or rebuild native dependencies.
