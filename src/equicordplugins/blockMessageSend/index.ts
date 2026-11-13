/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2026 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { definePluginSettings } from "@api/Settings";
import { EquicordDevs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { RestAPI, showToast } from "@webpack/common";

const logger = new Logger("BlockMessageSend");

const DISCORD_HOST = /(?:^|\.)discord\.com$/i;
const MESSAGE_PATH = /^(?:\/api\/v\d+)?\/channels\/[^/]+\/messages(?:\/[^/]+)?\/?$/i;
const COLLECTION_PATH = /\/messages\/?$/i;

const settings = definePluginSettings({
    blockMode: {
        type: OptionType.SELECT,
        description: "Which message requests should be blocked",
        options: [
            { label: "Sending messages only (recommended)", value: "send", default: true },
            { label: "Sending, editing and deleting messages", value: "modify" },
            { label: "All requests, including loading messages", value: "all" }
        ]
    },
    showToast: {
        type: OptionType.BOOLEAN,
        description: "Show a notification when a request is blocked",
        default: true
    }
});

let originalFetch: typeof globalThis.fetch | undefined;
const originalRestMethods = new Map<string, (...args: any[]) => Promise<any>>();
let lastToastAt = 0;

function notifyBlocked() {
    if (!settings.store.showToast) return;
    if (Date.now() - lastToastAt < 2000) return;

    lastToastAt = Date.now();
    try {
        showToast({
            text: "Message request blocked by BlockMessageSend",
            variant: "critical",
            duration: 2500
        });
    } catch (e) {
        logger.warn("Failed to show toast", e);
    }
}

function blockedError() {
    notifyBlocked();
    return new Error("This request was blocked by the BlockMessageSend plugin");
}

function shouldBlock(method: string, url: string) {
    let parsed: URL;
    try {
        // Relative URLs (used by Discord's RestAPI) are resolved against discord.com
        parsed = new URL(url, "https://discord.com");
    } catch {
        return false;
    }

    if (!DISCORD_HOST.test(parsed.hostname)) return false;
    if (!MESSAGE_PATH.test(parsed.pathname)) return false;

    method = method.toUpperCase();
    const mode = settings.store.blockMode;

    if (mode === "all") return true;

    const isCollection = COLLECTION_PATH.test(parsed.pathname);

    if (mode === "send") return isCollection && method === "POST";

    // "modify": block sending, editing and deleting, but keep loading history working
    return (isCollection && method === "POST") || method === "PATCH" || method === "DELETE";
}

function getMethod(input: RequestInfo | URL, init?: RequestInit) {
    if (init?.method) return init.method;
    if (typeof Request !== "undefined" && input instanceof Request) return input.method;
    return (input as Request)?.method ?? "GET";
}

function getUrl(input: RequestInfo | URL) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (typeof Request !== "undefined" && input instanceof Request) return input.url;
    return (input as Request)?.url ?? String(input);
}

function patchFetch() {
    if (originalFetch) return;

    originalFetch = globalThis.fetch;

    globalThis.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
        if (shouldBlock(getMethod(input, init), getUrl(input))) {
            return Promise.reject(blockedError());
        }

        return originalFetch!.call(this, input, init);
    };
}

function patchRestAPI() {
    // Discord's internal RestAPI may already be used through a captured reference,
    // which is why fetch is patched as well. Patching this catches the common case
    // without relying on Discord holding on to a specific fetch implementation.
    for (const [name, method] of [
        ["get", "GET"],
        ["post", "POST"],
        ["patch", "PATCH"],
        ["put", "PUT"],
        ["del", "DELETE"]
    ] as const) {
        const original = RestAPI[name];
        if (typeof original !== "function") continue;

        try {
            (RestAPI as any)[name] = function (data: { url?: string; } | string) {
                const url = typeof data === "string" ? data : data?.url;
                if (url && shouldBlock(method, url)) {
                    return Promise.reject(blockedError());
                }

                return original.apply(this, arguments as any);
            };
            originalRestMethods.set(name, original);
        } catch (e) {
            logger.warn(`Failed to patch RestAPI.${name}`, e);
        }
    }
}

export default definePlugin({
    name: "BlockMessageSend",
    description: "Blocks outgoing requests to Discord's message endpoints, preventing you from sending messages",
    tags: ["Chat", "Utility"],
    authors: [EquicordDevs.n71],
    settings,

    start() {
        patchFetch();
        patchRestAPI();
    },

    stop() {
        if (originalFetch) {
            globalThis.fetch = originalFetch;
            originalFetch = undefined;
        }

        for (const [name, original] of originalRestMethods) {
            try {
                (RestAPI as any)[name] = original;
            } catch (e) {
                logger.warn(`Failed to restore RestAPI.${name}`, e);
            }
        }
        originalRestMethods.clear();
    }
});
