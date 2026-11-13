/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { updateMessage } from "@api/MessageUpdater";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { PencilIcon, ResetIcon } from "@components/Icons";
import { EquicordDevs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, Message, RenderModalProps } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, Menu, MessageActions, MessageStore, Modal, openModal, SelectedChannelStore, TextArea, UserStore, useState } from "@webpack/common";

interface LocalEdit {
    channelId: string;
    originalContent: string;
    originalEditedTimestamp: Date | null;
    newContent: string;
}

const localEdits = new Map<string, LocalEdit>();

// Discord's EDIT chat input type requires SEND_MESSAGES by default, even though
// it only edits a message. Relax that check while the plugin is enabled so the
// native edit box also opens in read-only channels.
const ChatInputTypes = findByPropsLazy("FORM", "NORMAL");
let originalEditRequireSendMessages: boolean | undefined;

const settings = definePluginSettings({
    useNativeEditBox: {
        type: OptionType.BOOLEAN,
        description: "Use Discord's default edit box instead of a modal. This also works in channels where you cannot send messages",
        default: true
    },
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

function applyLocalEdit(message: Message, channelId: string, newContent: string) {
    const stored = localEdits.get(message.id);
    const originalContent = stored?.originalContent ?? message.content ?? "";
    const originalEditedTimestamp = stored?.originalEditedTimestamp ?? message.editedTimestamp ?? null;

    // Setting the text back to the original content removes the local edit
    if (newContent === originalContent) {
        if (stored) {
            localEdits.delete(message.id);
            updateMessage(channelId, message.id, {
                content: originalContent,
                editedTimestamp: originalEditedTimestamp
            });
        }
        return;
    }

    const edit = stored ?? {
        channelId,
        originalContent,
        originalEditedTimestamp,
        newContent
    };

    edit.newContent = newContent;
    localEdits.set(message.id, edit);

    updateMessage(channelId, message.id, {
        content: newContent,
        editedTimestamp: editedTimestampFor(edit)
    });
}

function EditMessageModal({ modalProps, message, channel }: { modalProps: RenderModalProps; message: Message; channel: Channel; }) {
    const [content, setContent] = useState(getDisplayContent(message));

    return (
        <Modal
            {...modalProps}
            size="md"
            title="Edit Message (Local)"
            subtitle="This edit is only visible to you and is reverted on relaunch."
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                {
                    text: "Save",
                    variant: "primary",
                    onClick: () => {
                        applyLocalEdit(message, channel.id, content);
                        modalProps.onClose();
                    }
                }
            ]}
        >
            <TextArea
                value={content}
                onChange={setContent}
                placeholder="Message content"
                autosize
                autoFocus
            />
        </Modal>
    );
}

function enableNativeEditBoxInReadOnlyChannels() {
    const editType = ChatInputTypes.EDIT;
    if (editType?.permissions) {
        originalEditRequireSendMessages ??= editType.permissions.requireSendMessages;
        editType.permissions.requireSendMessages = false;
    }
}

function startEditing(message: Message, channel: Channel) {
    // The native edit box only exists for the currently selected channel. If the
    // message is from somewhere else (e.g. a search result), use the modal.
    if (settings.store.useNativeEditBox && SelectedChannelStore.getChannelId() === channel.id) {
        enableNativeEditBoxInReadOnlyChannels();
        MessageActions.startEditMessage(channel.id, message.id, getDisplayContent(message));
        return;
    }

    openModal(modalProps => (
        <ErrorBoundary>
            <EditMessageModal modalProps={modalProps} message={message} channel={channel} />
        </ErrorBoundary>
    ));
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
            label="Edit Message (Local)"
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
    authors: [EquicordDevs.n71],
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
                label: "Edit Message (Local)",
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

        applyLocalEdit(message, channelId, messageObj.content ?? "");

        // Cancel the API request. Discord leaves the edit box open on a cancelled
        // edit, so close it again after the submit handler has finished.
        setTimeout(() => MessageActions.endEditMessage(channelId), 0);

        return { cancel: true };
    },

    stop() {
        // Restore the original permission check
        if (originalEditRequireSendMessages !== undefined) {
            ChatInputTypes.EDIT.permissions.requireSendMessages = originalEditRequireSendMessages;
            originalEditRequireSendMessages = undefined;
        }

        // Restore original contents
        for (const [messageId, edit] of [...localEdits]) {
            resetEdit(edit.channelId, messageId);
        }
    }
});
