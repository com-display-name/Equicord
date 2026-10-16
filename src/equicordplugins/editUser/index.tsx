/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, SettingsStore } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import ErrorBoundary from "@components/ErrorBoundary";
import { Notice } from "@components/Notice";
import { EquicordDevs } from "@utils/constants";
import { Margins } from "@utils/margins";
import definePlugin, { OptionType, StartAt } from "@utils/types";
import { filters, waitFor } from "@webpack";
import { Checkbox, UserProfileStore, UserStore } from "@webpack/common";
import virtualMerge from "virtual-merge";

/**
 * A catalogue of well known Discord badges you can display on your own profile.
 * The `icon` is the badge hash Discord resolves against its CDN.
 */
const BADGES: Record<string, { id: string; description: string; icon: string; link?: string; }> = {
    staff: { id: "staff", description: "Discord Staff", icon: "5e74e9b61934fc1f67c65515d1f7e60d", link: "https://discord.com/company" },
    partner: { id: "partner", description: "Partnered Server Owner", icon: "3f9748e53446a137a052f3454e2de41e", link: "https://discord.com/partners" },
    hypesquad: { id: "hypesquad", description: "HypeSquad Events", icon: "bf01d1073931f921909045f3a39fd264", link: "https://discord.com/hypesquad" },
    bravery: { id: "hypesquad_house_1", description: "HypeSquad Bravery", icon: "8a88d63823d8a71cd5e390baa45efa02", link: "https://discord.com/settings/hypesquad-online" },
    brilliance: { id: "hypesquad_house_2", description: "HypeSquad Brilliance", icon: "011940fd013da3f7fb926e4a1cd2e618", link: "https://discord.com/settings/hypesquad-online" },
    balance: { id: "hypesquad_house_3", description: "HypeSquad Balance", icon: "3aa41de486fa12454c3761e8e223442e", link: "https://discord.com/settings/hypesquad-online" },
    bugHunter1: { id: "bug_hunter_level_1", description: "Discord Bug Hunter", icon: "2717692c7dca7289b35297368a940dd0", link: "https://support.discord.com/hc/en-us/articles/360046057772" },
    bugHunter2: { id: "bug_hunter_level_2", description: "Discord Bug Hunter", icon: "848f79194d4be5ff5f81505cbd0ce1e6", link: "https://support.discord.com/hc/en-us/articles/360046057772" },
    earlySupporter: { id: "early_supporter", description: "Early Supporter", icon: "7060786766c9c840eb3019e725d2b358", link: "https://discord.com/settings/premium" },
    verifiedDeveloper: { id: "verified_developer", description: "Early Verified Bot Developer", icon: "6df5892e0f35b051f8b61eace34f4967" },
    certifiedModerator: { id: "certified_moderator", description: "Moderator Programs Alumni", icon: "fee1624003e2fee35cb398e125dc479b", link: "https://discord.com/safety" },
    activeDeveloper: { id: "active_developer", description: "Active Developer", icon: "6bdc42827a38498929a4920da12695d9", link: "https://support-dev.discord.com/hc/en-us/articles/10113997751447" },
    premium: { id: "premium", description: "Subscriber", icon: "2ba85e8026a8614b640c2837bcdfe21b", link: "https://discord.com/settings/premium" },
};

function parseHexColor(value: string): number | null {
    const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
    return match ? parseInt(match[1], 16) : null;
}

function parseDate(value: string): number | null {
    const time = Date.parse(value.trim());
    return Number.isNaN(time) ? null : time;
}

// ---------------------------------------------------------------------------
// Cached, versioned overrides
//
// Discord's UI memoises the objects returned by the stores, so the merged
// user/profile objects must keep a stable identity between changes. Each
// cache entry is keyed by the real store object and tagged with a version
// counter that refreshOverrides() bumps whenever a setting changes.
// ---------------------------------------------------------------------------

type CachedProxy = { v: number; proxy: any; };

const userCache = new WeakMap<object, CachedProxy>();
const profileCache = new WeakMap<object, CachedProxy>();
const memberProfileCache = new WeakMap<object, CachedProxy>();

let overrideVersion = 0;
let userOverrides: Record<string, any> = {};
let profileOverrides: Record<string, any> = {};
let memberProfileOverrides: Record<string, any> = {};
let avatarUrl = "";
let joinDateMs: number | null = null;

function refreshOverrides() {
    const s = settings.store;

    const u: Record<string, any> = {};
    if (s.username) u.username = s.username;
    if (s.globalName) u.globalName = s.globalName;
    userOverrides = u;

    const p: Record<string, any> = {};
    if (s.bio) p.bio = s.bio;
    if (s.pronouns) p.pronouns = s.pronouns;
    if (s.accentColor) {
        const color = parseHexColor(s.accentColor);
        if (color != null) p.accentColor = color;
    }

    // Badges are only rendered from the global user profile, so keep them out
    // of the guild member profile overrides to avoid displaying them twice.
    profileOverrides = { ...p };
    if (s.badges?.length) {
        profileOverrides.badges = s.badges
            .map(key => BADGES[key])
            .filter(Boolean);
    }
    memberProfileOverrides = p;

    avatarUrl = s.avatar?.trim() || "";
    joinDateMs = s.joinDate ? parseDate(s.joinDate) : null;

    overrideVersion++;
}

function getEdited(real: any, overrides: Record<string, any>, cache: WeakMap<object, CachedProxy>) {
    if (!real) return real;
    if (!Object.keys(overrides).length) return real;

    const entry = cache.get(real);
    if (entry && entry.v === overrideVersion) return entry.proxy;

    const proxy = virtualMerge(real, overrides);
    cache.set(real, { v: overrideVersion, proxy });
    return proxy;
}

// ---------------------------------------------------------------------------
// Store / util patching
//
// Everything is patched lazily via waitFor so start() works no matter how
// far Discord's own modules have loaded. stop() restores the originals.
// ---------------------------------------------------------------------------

let patched = false;
const appliedPatches = new Set<string>();
const restoreFns: Array<() => void> = [];

let origGetCurrentUser: any;
let userStore: any;

function getMyId(): string | undefined {
    // Read through the original method to avoid recursing into our own patch
    return origGetCurrentUser?.call(userStore)?.id;
}

function isMe(userId?: string) {
    const myId = getMyId();
    return !!userId && !!myId && userId === myId;
}

function patchMethod(target: any, key: string, makeWrapper: (orig: any) => any) {
    if (!target || typeof target[key] !== "function") return;

    const hadOwn = Object.hasOwn(target, key);
    const orig = target[key];
    target[key] = makeWrapper(orig);

    restoreFns.push(() => {
        if (hadOwn) target[key] = orig;
        else delete target[key];
    });
}

function once(key: string, apply: () => void) {
    if (!patched || appliedPatches.has(key)) return;
    appliedPatches.add(key);
    apply();
}

function patch() {
    if (patched) return;
    patched = true;

    waitFor(filters.byStoreName("UserStore"), store => once("userStore", () => {
        userStore = store;

        patchMethod(store, "getCurrentUser", orig => {
            origGetCurrentUser = orig;
            return function (this: any) {
                return getEdited(orig.apply(this, arguments), userOverrides, userCache);
            };
        });

        patchMethod(store, "getUser", orig => function (this: any, userId: string) {
            const user = orig.apply(this, arguments);
            return isMe(userId) ? getEdited(user, userOverrides, userCache) : user;
        });
    }));

    waitFor(filters.byStoreName("UserProfileStore"), store => once("userProfileStore", () => {
        patchMethod(store, "getUserProfile", orig => function (this: any, userId: string) {
            const profile = orig.apply(this, arguments);
            return isMe(userId) ? getEdited(profile, profileOverrides, profileCache) : profile;
        });

        patchMethod(store, "getGuildMemberProfile", orig => function (this: any, userId: string) {
            const profile = orig.apply(this, arguments);
            return isMe(userId) ? getEdited(profile, memberProfileOverrides, memberProfileCache) : profile;
        });
    }));

    // "Member Since" is derived from the snowflake of the profile's user id
    waitFor(["fromTimestamp", "extractTimestamp"], mod => once("snowflakeUtils", () => {
        patchMethod(mod, "extractTimestamp", orig => function (this: any, snowflake: string) {
            if (joinDateMs != null && isMe(snowflake)) return joinDateMs;
            return orig.apply(this, arguments);
        });
    }));

    waitFor(["getUserAvatarURL", "getGuildBannerURL"], mod => once("iconUtils", () => {
        patchMethod(mod, "getUserAvatarURL", orig => function (this: any, user: any) {
            if (avatarUrl && isMe(user?.id)) return avatarUrl;
            return orig.apply(this, arguments);
        });
    }));
}

function unpatch() {
    if (!patched) return;
    patched = false;
    appliedPatches.clear();

    for (const restore of restoreFns.splice(0).reverse()) restore();
}

function emitStoreChanges() {
    try { UserStore?.emitChange(); } catch { /* the store isn't loaded yet */ }
    try { UserProfileStore?.emitChange(); } catch { /* the store isn't loaded yet */ }
}

function onSettingsChange() {
    refreshOverrides();
    // Nudge the stores so already rendered UI picks up the new values
    emitStoreChanges();
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

function BadgeSetting() {
    const { badges } = settings.use(["badges"]);
    const selected: string[] = badges ?? [];

    const toggle = (key: string) => {
        settings.store.badges = selected.includes(key)
            ? selected.filter(k => k !== key)
            : [...selected, key];
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Object.entries(BADGES).map(([key, badge]) => (
                <Checkbox
                    key={key}
                    value={selected.includes(key)}
                    onChange={() => toggle(key)}
                    size={20}
                >
                    <BaseText size="sm">{badge.description}</BaseText>
                </Checkbox>
            ))}
        </div>
    );
}

const settings = definePluginSettings({
    username: {
        type: OptionType.STRING,
        description: "Override your @username (leave empty to keep your real one)",
        placeholder: "username",
    },
    globalName: {
        type: OptionType.STRING,
        description: "Override your display name (leave empty to keep your real one)",
        placeholder: "Display Name",
    },
    badges: {
        type: OptionType.COMPONENT,
        default: [] as string[],
        component: ErrorBoundary.wrap(BadgeSetting, { noop: true }),
    },
    joinDate: {
        type: OptionType.STRING,
        description: "Override the 'Member Since' date, e.g. 2015-01-01 (leave empty to keep your real one)",
        placeholder: "2015-01-01",
    },
    avatar: {
        type: OptionType.STRING,
        description: "Override your avatar with an image URL or data URI (leave empty to keep your real one)",
        placeholder: "https://example.com/avatar.png",
    },
    bio: {
        type: OptionType.STRING,
        description: "Override your profile bio",
        multiline: true,
        placeholder: "Bio",
    },
    pronouns: {
        type: OptionType.STRING,
        description: "Override your pronouns",
        placeholder: "they/them",
    },
    accentColor: {
        type: OptionType.STRING,
        description: "Override your profile accent color as a hex value, e.g. #5865f2",
        placeholder: "#5865f2",
    },
});

export default definePlugin({
    name: "EditUser",
    description: "Clientside-only editor for your own profile. Change your username, display name, badges, join date, avatar, bio, pronouns and accent color - only you see the changes.",
    tags: ["Appearance", "Customisation", "Utility"],
    authors: [EquicordDevs.nobody],
    startAt: StartAt.Init,
    settings,

    settingsAboutComponent: () => (
        <Notice.Info className={Margins.bottom8}>
            Everything this plugin changes is <strong>local only</strong>. Your real profile is never
            modified and nothing is sent to Discord's servers.
        </Notice.Info>
    ),

    start() {
        refreshOverrides();
        patch();
        SettingsStore.addPrefixChangeListener(`plugins.${settings.pluginName}`, onSettingsChange);
        emitStoreChanges();
    },

    stop() {
        SettingsStore.removePrefixChangeListener(`plugins.${settings.pluginName}`, onSettingsChange);
        unpatch();
        // Force a re-render so the real values come back
        emitStoreChanges();
    },
});
