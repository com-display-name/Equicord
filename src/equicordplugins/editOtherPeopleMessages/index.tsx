/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { updateMessage } from "@api/MessageUpdater";
import { definePluginSettings } from "@api/Settings";
import { PencilIcon, ResetIcon } from "@components/Icons";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, Message } from "@vencord/discord-types";
import { ChannelStore, Menu, MessageActions, MessageStore, UserStore } from "@webpack/common";

interface LocalEdit {
    channelId: string;
    originalContent: string;
    originalEditedTimestamp: Date | null;
    newContent: string;
}

const localEdits = new Map<string, LocalEdit>();

// Returns the stored edit, capturing the pre-edit originals on first local change
function ensureStored(message: Message, channelId: string): LocalEdit {
    let stored = localEdits.get(message.id);
    if (!stored) {
        stored = {
            channelId,
            originalContent: message.content ?? "",
            originalEditedTimestamp: message.editedTimestamp ?? null,
            newContent: message.content ?? ""
        };
        localEdits.set(message.id, stored);
    }
    return stored;
}

const settings = definePluginSettings({
    showResetOption: {
        type: OptionType.BOOLEAN,
        description: "Show a \"Reset Edited Message\" option to restore the original content of locally edited messages",
        default: true
    },
    showForOwnMessages: {
        type: OptionType.BOOLEAN,
        description: "Also show the local \"Edit Message\" entry on your own messages",
        default: false
    },
    showEditedTag: {
        type: OptionType.BOOLEAN,
        description: "Show the \"(edited)\" tag on messages you edited locally",
        default: true
    }
});

function getDisplayContent(message: Message): string {
    return localEdits.get(message.id)?.newContent ?? message.content ?? "";
}

function startEditing(message: Message, channel: Channel) {
    MessageActions.startEditMessage(channel.id, message.id, getDisplayContent(message));
}

function resetEdit(channelId: string, messageId: string) {
    const stored = localEdits.get(messageId);
    if (!stored) return;
    localEdits.delete(messageId);
    updateMessage(channelId, messageId, {
        content: stored.originalContent,
        editedTimestamp: stored.originalEditedTimestamp
    });
}

function editedTimestampFor(stored: LocalEdit): Date | null {
    return settings.store.showEditedTag ? new Date() : stored.originalEditedTimestamp;
}

function closeEditBox() {
    const active = document.activeElement;
    const target = (active && active !== document.body
        ? active
        : document.querySelector("[data-slate-editor=true]")) as HTMLElement | null;
    if (!target) return;

    const ev = new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        bubbles: true,
        cancelable: true
    });
    // Some handlers check the legacy props
    Object.defineProperties(ev, {
        keyCode: { value: 27 },
        which: { value: 27 }
    });
    target.dispatchEvent(ev);
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    // Guard against double-insertion (e.g. both "message" and "message-actions" patches hitting the same menu)
    if (findGroupChildrenByChildId("edit-other-message", children)) return;

    const { message, channel } = props as { message?: Message; channel?: Channel; };
    if (!message || !channel) return;

    const meId = UserStore.getCurrentUser()?.id;
    if (!meId) return;

    const isOwn = message.author?.id === meId;
    if (isOwn && !settings.store.showForOwnMessages) return;

    // Only allow editing sent messages (skip sending/failed states)
    if ((message as Message).state && (message as Message).state !== "SENT") return;

    const isEdited = localEdits.has(message.id);

    const editItem = (
        <Menu.MenuItem
            id="edit-other-message"
            key="edit-other-message"
            label={isOwn ? "Edit Message (Local)" : "Edit Message"}
            icon={PencilIcon}
            leadingAccessory={{ type: "icon", icon: PencilIcon }}
            action={() => startEditing(message, channel)}
        />
    );

    const resetItem = isEdited && settings.store.showResetOption ? (
        <Menu.MenuItem
            id="reset-other-message-edit"
            key="reset-other-message-edit"
            label="Reset Edited Message"
            color="danger"
            icon={ResetIcon}
            leadingAccessory={{ type: "icon", icon: ResetIcon }}
            action={() => resetEdit(channel.id, message.id)}
        />
    ) : null;

    const items = [editItem, resetItem].filter(x => x != null);

    const group = findGroupChildrenByChildId("edit", children)
        ?? findGroupChildrenByChildId("delete", children)
        ?? findGroupChildrenByChildId("reply", children)
        ?? findGroupChildrenByChildId("copy-text", children);

    if (group) {
        const editIdx = group.findIndex(c => c?.props?.id === "edit");
        if (editIdx !== -1) {
            group.splice(editIdx + 1, 0, ...items);
            return;
        }

        const deleteIdx = group.findIndex(c => c?.props?.id === "delete");
        if (deleteIdx !== -1) {
            group.splice(deleteIdx, 0, ...items);
            return;
        }

        group.unshift(...items);
        return;
    }

    children.push(...items);
};

export default definePlugin({
    name: "EditOtherPeopleMessages",
    description: "Edit other people's messages locally (reverted on relaunch)",
    tags: ["Chat", "Utility"],
    authors: [EquicordDevs.displayname],
    settings,
    dependencies: ["MessageUpdaterAPI", "MessagePopoverAPI"],

    contextMenus: {
        "message": messageContextMenuPatch,
        "message-actions": messageContextMenuPatch
    },

    messagePopoverButton: {
        icon: PencilIcon,
        render(message) {
            const meId = UserStore.getCurrentUser()?.id;
            if (!meId) return null;

            const isOwn = message.author?.id === meId;
            if (isOwn && !settings.store.showForOwnMessages) return null;

            if (message.state && message.state !== "SENT") return null;

            const channel = ChannelStore.getChannel(message.channel_id);
            if (!channel) return null;

            return {
                label: isOwn ? "Edit Message (Local)" : "Edit Message",
                icon: PencilIcon,
                message,
                channel,
                onClick: () => startEditing(message, channel)
            };
        }
    },

    flux: {
        MESSAGE_DELETE({ id }: { id: string; }) {
            localEdits.delete(id);
        },
        MESSAGE_DELETE_BULK({ ids }: { ids: string[]; }) {
            for (const id of ids) localEdits.delete(id);
        },
        MESSAGE_UPDATE({ message }: { message: { id: string; content?: string | null; }; }) {
            // A real content update from the server overwrites our local edit, so drop the stored entry.
            // Ignore embed-only updates where content is null.
            if (message?.content != null && localEdits.has(message.id)) localEdits.delete(message.id);
        }
    },

    async onBeforeMessageEdit(channelId: string, messageId: string, messageObj: { content: string; }) {
        const message = MessageStore.getMessage(channelId, messageId) as Message | undefined;
        if (!message) return;

        const meId = UserStore.getCurrentUser()?.id;
        // Let real edits of your own messages go through normally
        if (message.author?.id === meId) return;

        const newContent = messageObj.content ?? "";
        const stored = ensureStored(message, channelId);
        const currentContent = stored.newContent ?? message.content ?? "";

        // No change, just exit edit mode without an API call
        if (newContent === currentContent) return { cancel: true };

        stored.newContent = newContent;

        updateMessage(channelId, messageId, {
            content: newContent,
            editedTimestamp: editedTimestampFor(stored)
        });

        // Cancelling the edit makes MessageEventsAPI return {shouldClear:false},
        // which leaves the native edit box open. Close it the same way pressing
        // Escape would, after the box has refocused.
        setTimeout(closeEditBox, 50);

        return { cancel: true };
    },

    stop() {
        // Restore original contents
        for (const [messageId, edit] of [...localEdits]) {
            resetEdit(edit.channelId, messageId);
        }
    }
});
