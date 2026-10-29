/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { posix } from "node:path";
import { withMermaid } from "vitepress-plugin-mermaid";

// Files outside the documentation source are read on GitHub rather than emitted as docs pages.
function resolveRepositoryLink(href: string, currentPath: string): string {
    if (!href.startsWith("../")) return href;
    const [file, fragment] = href.split("#", 2);
    const target = posix.normalize(posix.join("docs", posix.dirname(currentPath), file));
    if (target.startsWith("docs/")) return href;
    return `https://github.com/chopin014/Aether/blob/main/${target}${fragment ? `#${fragment}` : ""}`;
}

export default withMermaid({
    title: "Aether docs",
    description: "Build, configure, and contribute to Aether.",
    srcExclude: ["changelogs/**"],
    markdown: {
        config: (md) => {
            const defaultRender = md.renderer.rules.link_open;
            md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
                const token = tokens[idx];
                const href = token.attrGet("href");
                if (href) token.attrSet("href", resolveRepositoryLink(href, env.relativePath));
                return defaultRender
                    ? defaultRender(tokens, idx, options, env, self)
                    : self.renderToken(tokens, idx, options);
            };
        },
    },
    themeConfig: {
        nav: [
            { text: "Documentation", link: "/" },
            { text: "Source", link: "https://github.com/chopin014/Aether" },
        ],
        search: { provider: "local" },
        sidebar: [
            {
                text: "Aether",
                items: [
                    { text: "Introduction", link: "/" },
                    { text: "Installation", link: "/install" },
                    { text: "Desktop status and development", link: "/desktop-ui" },
                    { text: "Releases and updates", link: "/aether-releases" },
                    { text: "Repository layout", link: "/monorepo" },
                ],
            },
            {
                text: "Configuration",
                items: [
                    { text: "Configuration reference", link: "/config" },
                    { text: "Encryption", link: "/e2ee" },
                    { text: "Authentication", link: "/oauth" },
                    { text: "Themes", link: "/theming" },
                    { text: "Labs", link: "/labs" },
                    { text: "Custom home page", link: "/custom-home" },
                ],
            },
            {
                text: "Development",
                items: [
                    { text: "MVVM", link: "/MVVM" },
                    { text: "Playwright", link: "/playwright" },
                    { text: "Feature flags", link: "/feature-flags" },
                    { text: "Translation guide", link: "/translating" },
                    { text: "Translation tooling", link: "/translating-dev" },
                    { text: "Debugging", link: "/debugging" },
                    { text: "Native debugging", link: "/gdb" },
                    { text: "Memory profiling", link: "/memory-profiles-and-leaks" },
                    { text: "Native Node modules", link: "/native-node-modules" },
                    { text: "Windows requirements", link: "/windows-requirements" },
                ],
            },
            {
                text: "Architecture",
                items: [
                    { text: "App loading", link: "/app-load" },
                    { text: "Settings", link: "/settings" },
                    { text: "Room list", link: "/room-list" },
                    { text: "Message composer", link: "/ciderEditor" },
                    { text: "Icons", link: "/icons" },
                    { text: "Local echo", link: "/local-echo-dev" },
                    { text: "Media", link: "/media-handling" },
                    { text: "Scrolling", link: "/scrolling" },
                    { text: "User content", link: "/usercontent" },
                    { text: "Widget layouts", link: "/widget-layouts" },
                ],
            },
        ],
        socialLinks: [{ icon: "github", link: "https://github.com/chopin014/Aether" }],
    },
});
