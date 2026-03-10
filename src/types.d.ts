export type ManifestFileRowT = {
	fileID: string
	relativePath: string
}

export type IntunesT = {
	backups: BackupsT
}

export type BackupListOptionsT = {}

export type BackupsT = {
	list(options?: BackupListOptionsT): BackupT[]
	get(id: string): BackupT
	convert(id: string): BackupConvertResultT
}

export type BackupT = {
	id: string // iTunes backup folder name
	deviceName: string
	deviceType: 'iPhone' | 'iPad' | 'iPod' | 'Unknown'
	iosVersion: string
	createdAt: Date
	modifiedAt: Date
	sizeOnDisk: number // bytes
	path: string // absolute folder path
	manifestPath: string // absolute file path to Manifest.db
	chats: ChatsT
	messages: MessagesT // global message-level access
	attachments: AttachmentsT // global attachment-level access
	convert(): BackupConvertResultT
}

export type AuthorRoleT = 'me' | 'participant' | 'system'

export type ConvertedParticipantT = {
	id: string
	value: string
	normalized: string
	isMe: boolean
	chatIds: string[]
}

export type ConvertedReactionT = {
	id: string
	messageId: string
	actor: string
	actorParticipantId: string | null
	isByMe: boolean
	emoji: string
	createdAt: string | null
	authorRole: AuthorRoleT
}

export type ConvertedMessageT = {
	id: string
	guid: string | null
	chatId: string
	participantId: string | null
	sender: string | null
	isFromMe: boolean
	authorRole: AuthorRoleT
	text: string | null
	subject: string | null
	service: 'iMessage' | 'SMS' | 'MMS' | 'Unknown'
	sentAt: string | null
	deliveredAt: string | null
	readAt: string | null
	isEdited: boolean
	isDeleted: boolean
	isSystem: boolean
	isTapback: boolean
	replyToMessageId: string | null
	threadId: string | null
	hasAttachments: boolean
	attachmentIds: string[]
	reactionIds: string[]
}

export type ConvertedAttachmentT = {
	id: string
	filename: string
	transferName: string
	mimeType: string
	size: number
	createdAt: string | null
	dataPath: string
	thumbnailPath: string | null
	previewPath: string | null
	chatId: string | null
	messageId: string | null
	participantId: string | null
	isFromMe: boolean
	authorRole: AuthorRoleT
	reactionIds: string[]
	backupId: string
	path: string
}

export type ConvertedChatT = {
	id: string
	displayName: string
	isGroup: boolean
	participantIds: string[]
	messageIds: string[]
	attachmentIds: string[]
	reactionIds: string[]
	days: Record<string, string[]>
}

export type ConvertedWarningT = {
	code: string
	message: string
	id?: string
}

export type ConvertedOrphansT = {
	messages: string[]
	attachments: string[]
	reactions: string[]
}

export type BackupConvertResultT = {
	id: string
	path: string
	deviceName: string
	deviceType: 'iPhone' | 'iPad' | 'iPod' | 'Unknown'
	iosVersion: string
	createdAt: string | null
	modifiedAt: string | null
	sizeOnDisk: number
	manifestPath: string
	formatVersion: string
	exportedAt: string
	totalChats: number
	totalMessages: number
	totalAttachments: number
	totalReactions: number
	totalParticipants: number
	warningsCount: number
	orphansCount: number
	participants: Record<string, ConvertedParticipantT>
	messages: Record<string, ConvertedMessageT>
	reactions: Record<string, ConvertedReactionT>
	attachments: Record<string, ConvertedAttachmentT>
	chats: ConvertedChatT[]
	warnings: ConvertedWarningT[]
	orphans: ConvertedOrphansT
}

export type ChatsListOptionsT = {
	limit?: number
	offset?: number
	search?: string // match participant or displayName
}

// Backward-compatible alias; prefer ChatsListOptionsT.
export type ChatListOptionsT = ChatsListOptionsT

export type ChatsT = {
	list(options?: ChatsListOptionsT): ChatT[]
	get(id: string): ChatT
}

export type HandleT = {
	id: string
	value: string // phone/email
	normalized: string
}

export type HandlesT = {
	list(): HandleT[]
	get(id: string): HandleT
	find(query: string): HandleT[] // match value or normalized
}

export type ObjectExportOptionsT = {
	format: string // json, csv, pdf, markdown, yaml html, text
	outputPath: string
}

export type ChatExportOptionsT = ObjectExportOptionsT & {
	fromDate?: Date
	toDate?: Date
}

export type ChatT = {
	id: string // chat_identifier / ROWID wrapper
	displayName: string // best-effort (group name, handle, etc.)
	isGroup: boolean
	participants: HandleT[] // phone numbers / emails
	messageCount: number
	messageDates: string[] // unique message day strings in YYYY-MM-DD format
	lastMessageAt: Date | null
	messages: MessagesT
	attachments: AttachmentsT
	export(options: ChatExportOptionsT): boolean
}

export type MessageListOptionsT = {
	limit?: number
	date?: Date | string
	fromDate?: Date
	toDate?: Date
	hasAttachment?: boolean
	minAttachments?: number
	maxAttachments?: number
}

export type MessagesT = {
	list(filter?: MessageListOptionsT): MessageT[]
	get(id: string): MessageT
}

export type ReactionT = {
	id: string
	messageId: string
	actor: string
	emoji: string
	createdAt: Date
}

export type MessageT = {
	id: string
	guid?: string // Apple GUID if present
	chatId: string
	sender: string | null
	isFromMe: boolean
	text: string | null
	subject?: string | null // MMS subject
	service: 'iMessage' | 'SMS' | 'MMS' | 'Unknown'

	sentAt: Date | null
	deliveredAt?: Date | null
	readAt?: Date | null

	isEdited?: boolean
	isDeleted?: boolean
	isSystem?: boolean // join/leave events
	isTapback?: boolean

	replyToMessageId?: string
	threadId?: string

	hasAttachments: boolean
	attachments: AttachmentT[]
	attachmentIds: string[]
	reactions?: ReactionT[]
}

export type AttachmentT = {
	id: string // guid / ROWID wrapper
	filename: string
	transferName: string
	mimeType: string
	size: number // bytes
	createdAt: Date
	dataPath: string // absolute file path to the attachment data
	thumbnailPath?: string // absolute file path to the thumbnail (if image/video)
	previewPath?: string // absolute file path to the preview (if image/video)
	chatId?: string
	messageId?: string
	backupId: string
	path: string // absolute path on disk within backup
}

export type AttachmentListOptionsT = {
	limit?: number
	offset?: number
	type?: string // 'image', 'video', 'audio', 'other'
	extension?: string | string[] // 'jpg', ['jpg','png', 'm4a', etc]
	fromDate?: Date
	toDate?: Date
	minSize?: number
	maxSize?: number
}

// Within a Backup: all attachments.
// Within a Chat: scoped attachments.
// Within a Message: that message’s attachments.
export type AttachmentsT = {
	list(options?: AttachmentListOptionsT): AttachmentT[]
	get(id: string): AttachmentT | null

	// Convenience: stream or copy out to disk
	createReadStream(id: string): ReadableStream
	saveToFile(id: string, destPath: string): Promise<void>
}

export function Backup(backupPath: string): BackupT

export const intunes: IntunesT
