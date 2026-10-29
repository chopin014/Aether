# Contributing to Aether

Aether is an open-source desktop app for communities on Matrix. Contributions to its interface, calling,
accessibility, translations, documentation, and reliability are welcome.

Use [Aether issues](https://github.com/chopin014/Aether/issues) for bugs, questions, and feature proposals.
For a substantial change, describe the problem and proposed behavior in an issue before starting work.
Include your operating system, Aether version, and steps to reproduce when reporting a bug.

## Development

Read the [developer guide](developer_guide.md) to set up the repository and run the desktop app.
Follow the [code style](code_style.md) and use [MVVM](docs/MVVM.md) for new UI.
Linux and Windows are the first release targets. Keep Matrix permissions, encryption, verification, and
account recovery working when changing the interface.

## Pull requests

1. Create a focused branch from `main` in your fork.
2. Make one coherent change, with tests for behavior changes and updated documentation where needed.
3. Run the checks relevant to your change. See the [developer guide](developer_guide.md#validation).
4. Open a pull request against `chopin014/Aether` on `main`.

Use a short, descriptive title. Explain the problem, resulting behavior, and how you tested the change.
Link related issues and include before/after screenshots for visible changes.
Review changed screenshot baselines and explain every difference; see the [Playwright guide](docs/playwright.md).
Keep commits focused and use imperative subjects without conventional-commit prefixes.

You are responsible for understanding and validating everything you submit, including changes made with AI assistance.

## Translations

See the [translation guide](docs/translating.md) to improve a language and the
[translation developer guide](docs/translating-dev.md) when adding or changing UI strings.

## Licensing and attribution

Contribute only work you have the right to submit under the applicable project licenses.
No contributor license agreement is required for Aether contributions.
Keep existing copyright, license, and third-party notices intact. For new files, use your own name or organization
as the copyright holder and follow the header guidance in [code_style.md](code_style.md).
See [NOTICE.md](NOTICE.md) for inherited notices and the license texts in the repository root.
