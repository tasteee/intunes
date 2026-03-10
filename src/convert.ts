import type {
	BackupT,
	ChatT,
	HandleT,
	BackupConvertResultT,
	ConvertedAttachmentT,
	ConvertedMessageT,
	ConvertedParticipantT,
	ConvertedReactionT,
	ConvertedWarningT,
	ConvertedOrphansT,
	ConvertedChatT
} from './types'

const CHAT_PAGE_SIZE = 500

const toIso = (value: Date | null | undefined): string | null => {
	if (!(value instanceof Date)) return null
	if (Number.isNaN(value.getTime())) return null
	return value.toISOString()
}

const toDayKey = (value: Date | null | undefined): string | null => {
	if (!(value instanceof Date)) return null
	if (Number.isNaN(value.getTime())) return null

	const year = value.getFullYear()
	const month = String(value.getMonth() + 1).padStart(2, '0')
	const day = String(value.getDate()).padStart(2, '0')
	return `${year}-${month}-${day}`
}

const uniqueIds = (values: string[]): string[] => {
	const set = new Set<string>()
	for (const value of values) {
		if (typeof value !== 'string') continue
		const normalized = value.trim()
		if (normalized.length === 0) continue
		set.add(normalized)
	}
	return Array.from(set)
}

const warning = (code: string, message: string, id?: string): ConvertedWarningT => ({
	code,
	message,
	id
})

const getAllChats = (backup: BackupT): ChatT[] => {
	const chats: ChatT[] = []
	let offset = 0

	while (true) {
		const page = backup.chats.list({ limit: CHAT_PAGE_SIZE, offset })
		if (page.length === 0) break

		chats.push(...page)
		offset += page.length

		if (page.length < CHAT_PAGE_SIZE) break
	}

	return chats
}

const includeParticipant = (
	participants: Record<string, ConvertedParticipantT>,
	participant: HandleT,
	chatId?: string
): void => {
	const existing = participants[participant.id]
	if (!existing) {
		participants[participant.id] = {
			id: participant.id,
			value: participant.value,
			normalized: participant.normalized,
			isMe: false,
			chatIds: chatId ? [chatId] : []
		}
		return
	}

	if (chatId && !existing.chatIds.includes(chatId)) {
		existing.chatIds.push(chatId)
	}
}

export const convertBackupToTree = (backup: BackupT): BackupConvertResultT => {
	const chats = getAllChats(backup)
	const allMessages = backup.messages.list()
	const allAttachments = backup.attachments.list({
		offset: 0,
		limit: Number.MAX_SAFE_INTEGER
	})

	const participants: Record<string, ConvertedParticipantT> = {
		me: {
			id: 'me',
			value: 'me',
			normalized: 'me',
			isMe: true,
			chatIds: []
		}
	}

	const messagesById: Record<string, ConvertedMessageT> = {}
	const reactionsById: Record<string, ConvertedReactionT> = {}
	const attachmentsById: Record<string, ConvertedAttachmentT> = {}
	const chatById: Record<string, ConvertedChatT> = {}

	const messageToChat = new Map<string, string>()
	const messageToParticipant = new Map<string, string>()
	const warnings: ConvertedWarningT[] = []
	const orphans: ConvertedOrphansT = {
		messages: [],
		attachments: [],
		reactions: []
	}

	for (const chat of chats) {
		const chatParticipantIds: string[] = []
		for (const participant of chat.participants) {
			includeParticipant(participants, participant, chat.id)
			chatParticipantIds.push(participant.id)
		}

		chatById[chat.id] = {
			id: chat.id,
			displayName: chat.displayName,
			isGroup: chat.isGroup,
			participantIds: uniqueIds(chatParticipantIds),
			messageIds: [],
			attachmentIds: [],
			reactionIds: [],
			days: {}
		}
	}

	for (const message of allMessages) {
		const participantId = message.isFromMe ? 'me' : message.sender || null
		if (participantId && participantId !== 'me') {
			const handle: HandleT = {
				id: participantId,
				value: participantId,
				normalized: participantId.toLowerCase()
			}
			includeParticipant(participants, handle, message.chatId)
		}

		const reactionIds: string[] = []
		for (const reaction of message.reactions || []) {
			const isByMe = reaction.actor === 'me'
			const actorParticipantId = isByMe ? 'me' : reaction.actor || null
			if (actorParticipantId && actorParticipantId !== 'me') {
				const actorHandle: HandleT = {
					id: actorParticipantId,
					value: actorParticipantId,
					normalized: actorParticipantId.toLowerCase()
				}
				includeParticipant(participants, actorHandle, message.chatId)
			}

			reactionsById[reaction.id] = {
				id: reaction.id,
				messageId: message.id,
				actor: reaction.actor,
				actorParticipantId,
				isByMe,
				emoji: reaction.emoji,
				createdAt: toIso(reaction.createdAt),
				authorRole: isByMe ? 'me' : actorParticipantId ? 'participant' : 'system'
			}
			reactionIds.push(reaction.id)
		}

		messagesById[message.id] = {
			id: message.id,
			guid: message.guid || null,
			chatId: message.chatId,
			participantId,
			sender: message.sender,
			isFromMe: message.isFromMe,
			authorRole: message.isFromMe ? 'me' : participantId ? 'participant' : 'system',
			text: message.text,
			subject: message.subject || null,
			service: message.service,
			sentAt: toIso(message.sentAt),
			deliveredAt: toIso(message.deliveredAt),
			readAt: toIso(message.readAt),
			isEdited: Boolean(message.isEdited),
			isDeleted: Boolean(message.isDeleted),
			isSystem: Boolean(message.isSystem),
			isTapback: Boolean(message.isTapback),
			replyToMessageId: message.replyToMessageId || null,
			threadId: message.threadId || null,
			hasAttachments: message.hasAttachments,
			attachmentIds: uniqueIds(message.attachmentIds || []),
			reactionIds: uniqueIds(reactionIds)
		}

		const convertedChat = chatById[message.chatId]
		if (!convertedChat) {
			warnings.push(warning('ORPHAN_MESSAGE_CHAT', `Message ${message.id} has unknown chatId ${message.chatId}`, message.id))
			orphans.messages.push(message.id)
		} else {
			convertedChat.messageIds.push(message.id)
			convertedChat.reactionIds.push(...reactionIds)
			const dayKey = toDayKey(message.sentAt)
			if (dayKey) {
				if (!convertedChat.days[dayKey]) convertedChat.days[dayKey] = []
				convertedChat.days[dayKey].push(message.id)
			}
		}

		if (participantId) {
			messageToParticipant.set(message.id, participantId)
		}
		messageToChat.set(message.id, message.chatId)
	}

	for (const attachment of allAttachments) {
		const chatId = attachment.chatId || (attachment.messageId ? messageToChat.get(attachment.messageId) || null : null)
		const participantId = attachment.messageId ? messageToParticipant.get(attachment.messageId) || null : null
		const isFromMe = participantId === 'me'
		const reactionIds: string[] = []

		attachmentsById[attachment.id] = {
			id: attachment.id,
			filename: attachment.filename,
			transferName: attachment.transferName,
			mimeType: attachment.mimeType,
			size: attachment.size,
			createdAt: toIso(attachment.createdAt),
			dataPath: attachment.dataPath,
			thumbnailPath: attachment.thumbnailPath || null,
			previewPath: attachment.previewPath || null,
			chatId,
			messageId: attachment.messageId || null,
			participantId,
			isFromMe,
			authorRole: isFromMe ? 'me' : participantId ? 'participant' : 'system',
			reactionIds,
			backupId: attachment.backupId,
			path: attachment.path
		}

		if (!chatId) {
			orphans.attachments.push(attachment.id)
			warnings.push(warning('ORPHAN_ATTACHMENT_CHAT', `Attachment ${attachment.id} has no resolvable chat`, attachment.id))
			continue
		}

		if (!chatById[chatId]) {
			orphans.attachments.push(attachment.id)
			warnings.push(
				warning('ORPHAN_ATTACHMENT_UNKNOWN_CHAT', `Attachment ${attachment.id} chat ${chatId} is unknown`, attachment.id)
			)
			continue
		}

		chatById[chatId].attachmentIds.push(attachment.id)
	}

	for (const reactionId of Object.keys(reactionsById)) {
		const reaction = reactionsById[reactionId]
		if (!reaction) continue
		if (messagesById[reaction.messageId]) continue

		orphans.reactions.push(reactionId)
		warnings.push(
			warning('ORPHAN_REACTION_MESSAGE', `Reaction ${reactionId} references missing message ${reaction.messageId}`, reactionId)
		)
	}

	const convertedChats = Object.values(chatById).map((chat) => ({
		...chat,
		participantIds: uniqueIds(chat.participantIds),
		messageIds: uniqueIds(chat.messageIds),
		attachmentIds: uniqueIds(chat.attachmentIds),
		reactionIds: uniqueIds(chat.reactionIds),
		days: Object.fromEntries(Object.entries(chat.days).map(([day, messageIds]) => [day, uniqueIds(messageIds)]))
	}))

	return {
		id: backup.id,
		path: backup.path,
		deviceName: backup.deviceName,
		deviceType: backup.deviceType,
		iosVersion: backup.iosVersion,
		createdAt: toIso(backup.createdAt),
		modifiedAt: toIso(backup.modifiedAt),
		sizeOnDisk: backup.sizeOnDisk,
		manifestPath: backup.manifestPath,
		formatVersion: '1.0',
		exportedAt: new Date().toISOString(),
		totalChats: convertedChats.length,
		totalMessages: Object.keys(messagesById).length,
		totalAttachments: Object.keys(attachmentsById).length,
		totalReactions: Object.keys(reactionsById).length,
		totalParticipants: Object.keys(participants).length,
		warningsCount: warnings.length,
		orphansCount: orphans.messages.length + orphans.attachments.length + orphans.reactions.length,
		participants,
		messages: messagesById,
		reactions: reactionsById,
		attachments: attachmentsById,
		chats: convertedChats,
		warnings,
		orphans
	}
}
