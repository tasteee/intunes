import fs from 'node:fs'
import path from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import plist from 'plist'

import { ATTACHMENTS_PATH, getAttachmentManifestRows, getManifestDb, getManifestPath, getWindowsBackupPaths } from './core'

import type {
	BackupConvertResultT,
	ConvertedAttachmentT,
	ConvertedChatT,
	ConvertedOrphansT,
	ConvertedParticipantT,
	ConvertedReactionT,
	ConvertedWarningT
} from './types'

type Database = ReturnType<typeof BetterSqlite3>

type ChatRowT = {
	rowid: number
	display_name: string | null
	chat_identifier: string | null
}

type HandleRowT = {
	id: string | null
}

type MessageRowT = {
	rowid: number
	guid: string | null
	chat_id: number | null
	sender: string | null
	is_from_me: number | null
	text: string | null
	subject: string | null
	service: string | null
	date: number | null
	date_delivered: number | null
	date_read: number | null
	item_type: number | null
	attachment_ids: string | null
}

type ReactionRowT = {
	rowid: number
	sender: string | null
	is_from_me: number | null
	text: string | null
	date: number | null
	associated_message_guid: string | null
	associated_message_type: number | null
}

type AttachmentRowT = {
	rowid: number
	filename: string | null
	transfer_name: string | null
	mime_type: string | null
	total_bytes: number | null
	message_id: number | null
	chat_id: number | null
	message_date: number | null
}

const CHAT_PAGE_SIZE = 500
const appleEpochMs = Date.UTC(2001, 0, 1)

const warning = (code: string, message: string, id?: string): ConvertedWarningT => ({
	code,
	message,
	id
})

const toIsoFromDate = (value: Date | null | undefined): string | null => {
	if (!(value instanceof Date)) return null
	if (Number.isNaN(value.getTime())) return null
	return value.toISOString()
}

const toIsoFromAppleRaw = (raw: unknown): string | null => {
	if (raw === null || raw === undefined) return null
	const value = Number(raw)
	if (!Number.isFinite(value) || value <= 0) return null

	const secondsFromAppleEpoch = value > 1e12 ? value / 1e9 : value
	return new Date(appleEpochMs + secondsFromAppleEpoch * 1000).toISOString()
}

const toDayKeyFromIso = (iso: string | null): string | null => {
	if (typeof iso !== 'string') return null
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return null
	const year = date.getFullYear()
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
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

const normalizeReactionTarget = (value: unknown): string | null => {
	if (value === null || value === undefined) return null
	const normalized = String(value).trim().toLowerCase()
	return normalized.length > 0 ? normalized : null
}

const extractBaseGuid = (associatedGuid: unknown): string | null => {
	if (typeof associatedGuid !== 'string' || associatedGuid.length === 0) return null

	const guidParts = associatedGuid
		.split('/')
		.map((part) => part.trim())
		.filter(Boolean)

	const guidLikePart = guidParts.find((part) => /^[0-9A-Fa-f-]{8,}$/.test(part))
	if (guidLikePart) return guidLikePart
	return guidParts[0] ?? null
}

const legacyReactionCodeMap: Record<number, string> = {
	2000: '❤️',
	2001: '👍',
	2002: '👎',
	2003: '😂',
	2004: '‼️',
	2005: '❓'
}

const mapReactionCodeToEmoji = (code: unknown): string | null => {
	const numericCode = Number(code)
	if (!Number.isFinite(numericCode)) return null
	if (numericCode >= 3000 && numericCode < 4000) return null
	return legacyReactionCodeMap[numericCode] ?? null
}

const extractEmojiFromReactionText = (text: unknown): string | null => {
	if (typeof text !== 'string' || text.length === 0) return null

	const reactedMatch = text.match(/Reacted\s+(.+?)\s+to\b/i)
	if (reactedMatch && reactedMatch[1]) return reactedMatch[1].trim()

	const namedReactionMap: Record<string, string> = {
		loved: '❤️',
		liked: '👍',
		disliked: '👎',
		laughed: '😂',
		emphasized: '‼️',
		questioned: '❓'
	}

	const namedReactionMatch = text.match(/^(Loved|Liked|Disliked|Laughed|Emphasized|Questioned)\b/i)
	if (namedReactionMatch && namedReactionMatch[1]) return namedReactionMap[namedReactionMatch[1].toLowerCase()] ?? null

	const removedReactionMatch = text.match(/^Removed\s+(.+?)\s+from\b/i)
	if (removedReactionMatch && removedReactionMatch[1]) return removedReactionMatch[1].trim()

	const firstEmojiMatch = text.match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/u)
	return firstEmojiMatch ? firstEmojiMatch[0] : null
}

const toRelativeAttachmentPath = (filename: unknown): string | null => {
	if (typeof filename !== 'string' || filename.length === 0) return null

	const normalized = filename.replaceAll('\\', '/').trim()
	if (normalized.length === 0) return null

	const markerIndex = normalized.indexOf(`${ATTACHMENTS_PATH}/`)
	if (markerIndex >= 0) return normalized.slice(markerIndex)
	if (normalized.startsWith('~/')) return normalized.slice(2)
	return null
}

const resolveBackupPath = (id: string): string => {
	const normalizedId = id.trim()
	if (normalizedId.length === 0) throw new Error('Backup id is required')

	for (const basePath of getWindowsBackupPaths()) {
		const candidate = path.join(basePath, normalizedId)
		if (fs.existsSync(path.join(candidate, 'Info.plist'))) {
			return candidate
		}
	}

	throw new Error(`Backup ${id} not found`)
}

const getSmsDbPathFromManifest = (backupPath: string): string => {
	const manifestDb = getManifestDb(backupPath)
	const row = manifestDb.prepare(`SELECT fileID FROM Files WHERE relativePath = 'Library/SMS/sms.db' LIMIT 1`).get() as
		| { fileID: string }
		| undefined
	manifestDb.close()

	if (!row?.fileID) {
		throw new Error(`sms.db file id not found in Manifest.db for ${backupPath}`)
	}

	const subdirectory = row.fileID.slice(0, 2)
	const primaryPath = path.join(backupPath, subdirectory, row.fileID)
	if (fs.existsSync(primaryPath)) return primaryPath

	const fallbackPath = path.join(backupPath, row.fileID)
	if (fs.existsSync(fallbackPath)) return fallbackPath

	throw new Error(`sms.db not found in backup ${backupPath}`)
}

const getBackupInfo = (
	backupPath: string
): {
	deviceName: string
	iosVersion: string
	createdAt: string | null
	modifiedAt: string | null
	sizeOnDisk: number
	manifestPath: string
} => {
	const infoPlistPath = path.join(backupPath, 'Info.plist')
	let deviceName = 'Unknown'
	let iosVersion = 'Unknown'

	if (fs.existsSync(infoPlistPath)) {
		try {
			const info = plist.parse(fs.readFileSync(infoPlistPath, 'utf8')) as Record<string, unknown>
			if (typeof info['Device Name'] === 'string') deviceName = info['Device Name']
			if (typeof info['Product Version'] === 'string') iosVersion = info['Product Version']
		} catch {
			// Keep defaults when plist parse fails.
		}
	}

	const backupStats = fs.statSync(backupPath)
	return {
		deviceName,
		iosVersion,
		createdAt: toIsoFromDate(backupStats.birthtime),
		modifiedAt: toIsoFromDate(backupStats.mtime),
		sizeOnDisk: 0,
		manifestPath: getManifestPath(backupPath)
	}
}

const loadChats = (db: Database): ChatRowT[] => {
	const chats: ChatRowT[] = []
	let offset = 0

	while (true) {
		const page = db
			.prepare(
				`SELECT c.ROWID as rowid, c.display_name, c.chat_identifier
				 FROM chat c
				 ORDER BY c.ROWID DESC
				 LIMIT ? OFFSET ?`
			)
			.all(CHAT_PAGE_SIZE, offset) as ChatRowT[]

		if (page.length === 0) break
		chats.push(...page)
		offset += page.length
		if (page.length < CHAT_PAGE_SIZE) break
	}

	return chats
}

const getParticipantsForChat = (db: Database, chatRowId: number): string[] => {
	const rows = db
		.prepare(
			`SELECT h.id
			 FROM chat_handle_join chj
			 INNER JOIN handle h ON h.ROWID = chj.handle_id
			 WHERE chj.chat_id = ?
			 ORDER BY h.id`
		)
		.all(chatRowId) as HandleRowT[]

	return uniqueIds(rows.map((row) => (typeof row.id === 'string' ? row.id : '')).filter((value) => value.length > 0))
}

const loadMessages = (db: Database): MessageRowT[] => {
	return db
		.prepare(
			`SELECT
				m.ROWID as rowid,
				m.guid,
				cmj.chat_id,
				h.id as sender,
				m.is_from_me,
				m.text,
				m.subject,
				m.service,
				m.date,
				m.date_delivered,
				m.date_read,
				m.item_type,
				(SELECT GROUP_CONCAT(attachment_id) FROM message_attachment_join maj2 WHERE maj2.message_id = m.ROWID) as attachment_ids
			FROM message m
			LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
			LEFT JOIN handle h ON h.ROWID = m.handle_id
			WHERE COALESCE(m.associated_message_type, 0) <= 0
			ORDER BY m.date DESC`
		)
		.all() as MessageRowT[]
}

const loadReactionRows = (db: Database): ReactionRowT[] => {
	return db
		.prepare(
			`SELECT
				m.ROWID as rowid,
				h.id as sender,
				m.is_from_me,
				m.text,
				m.date,
				m.associated_message_guid,
				m.associated_message_type
			FROM message m
			LEFT JOIN handle h ON h.ROWID = m.handle_id
			WHERE m.associated_message_guid IS NOT NULL
			  AND m.associated_message_guid != ''
			  AND COALESCE(m.associated_message_type, 0) > 0
			ORDER BY m.date ASC`
		)
		.all() as ReactionRowT[]
}

const loadAttachments = (db: Database): AttachmentRowT[] => {
	const rows = db
		.prepare(
			`SELECT
				a.ROWID as rowid,
				a.filename,
				a.transfer_name,
				a.mime_type,
				a.total_bytes,
				maj.message_id,
				cmj.chat_id,
				m.date as message_date
			FROM attachment a
			LEFT JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
			LEFT JOIN message m ON m.ROWID = maj.message_id
			LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
			ORDER BY m.date DESC, a.ROWID DESC`
		)
		.all() as AttachmentRowT[]

	const deduped = new Map<string, AttachmentRowT>()
	for (const row of rows) {
		const id = String(row.rowid)
		if (!deduped.has(id)) deduped.set(id, row)
	}
	return Array.from(deduped.values())
}

const buildAttachmentPathIndex = (backupPath: string): Map<string, string> => {
	const manifestDb = getManifestDb(backupPath)
	const rows = getAttachmentManifestRows(manifestDb)
	manifestDb.close()

	const pathByRelativePath = new Map<string, string>()
	for (const row of rows) {
		const subdirectory = row.fileID.slice(0, 2)
		const primaryPath = path.join(backupPath, subdirectory, row.fileID)
		const fallbackPath = path.join(backupPath, row.fileID)
		const resolvedPath = fs.existsSync(primaryPath) ? primaryPath : fallbackPath
		pathByRelativePath.set(row.relativePath, resolvedPath)
	}

	return pathByRelativePath
}

export const converter = (id: string): BackupConvertResultT => {
	const backupPath = resolveBackupPath(id)
	const smsDbPath = getSmsDbPathFromManifest(backupPath)
	const db = new BetterSqlite3(smsDbPath, { readonly: true })

	try {
		const { deviceName, iosVersion, createdAt, modifiedAt, sizeOnDisk, manifestPath } = getBackupInfo(backupPath)
		const chats = loadChats(db)
		const messages = loadMessages(db)
		const reactionRows = loadReactionRows(db)
		const attachments = loadAttachments(db)
		const attachmentPathIndex = buildAttachmentPathIndex(backupPath)

		const participants: Record<string, ConvertedParticipantT> = {
			me: {
				id: 'me',
				value: 'me',
				normalized: 'me',
				isMe: true,
				chatIds: []
			}
		}

		const includeParticipant = (participantId: string, chatId?: string): void => {
			const normalized = participantId.trim()
			if (normalized.length === 0) return

			const existing = participants[normalized]
			if (!existing) {
				participants[normalized] = {
					id: normalized,
					value: normalized,
					normalized: normalized.toLowerCase(),
					isMe: normalized === 'me',
					chatIds: chatId ? [chatId] : []
				}
				return
			}

			if (chatId && !existing.chatIds.includes(chatId)) {
				existing.chatIds.push(chatId)
			}
		}

		const warnings: ConvertedWarningT[] = []
		const orphans: ConvertedOrphansT = {
			messages: [],
			attachments: [],
			reactions: []
		}

		const messagesById: Record<string, any> = {}
		const reactionsById: Record<string, ConvertedReactionT> = {}
		const attachmentsById: Record<string, ConvertedAttachmentT> = {}
		const chatById: Record<string, ConvertedChatT> = {}

		for (const chat of chats) {
			const chatId = String(chat.rowid)
			const chatParticipantIds = getParticipantsForChat(db, chat.rowid)
			for (const participantId of chatParticipantIds) includeParticipant(participantId, chatId)

			const displayName =
				typeof chat.display_name === 'string' && chat.display_name.trim().length > 0
					? chat.display_name.trim()
					: chat.chat_identifier || `Chat ${chatId}`

			chatById[chatId] = {
				id: chatId,
				displayName,
				isGroup: chatParticipantIds.length > 1,
				participantIds: uniqueIds(chatParticipantIds),
				messageIds: [],
				attachmentIds: [],
				reactionIds: [],
				days: {}
			}
		}

		const messageToChat = new Map<string, string>()
		const messageToParticipant = new Map<string, string>()
		const reactionTargetToMessageId = new Map<string, string>()

		for (const row of messages) {
			const messageId = String(row.rowid)
			const chatId = row.chat_id !== null ? String(row.chat_id) : ''
			const isFromMe = Boolean(row.is_from_me)
			const participantId = isFromMe ? 'me' : row.sender || null
			if (participantId) includeParticipant(participantId, chatId || undefined)

			const attachmentIds =
				typeof row.attachment_ids === 'string' && row.attachment_ids.length > 0
					? uniqueIds(row.attachment_ids.split(',').map((value) => value.trim()))
					: []

			const service = row.service === 'iMessage' || row.service === 'SMS' || row.service === 'MMS' ? row.service : 'Unknown'

			const convertedMessage = {
				id: messageId,
				guid: row.guid || null,
				chatId,
				participantId,
				sender: row.sender,
				isFromMe,
				authorRole: isFromMe ? 'me' : participantId ? 'participant' : 'system',
				text: row.text,
				subject: row.subject || null,
				service,
				sentAt: toIsoFromAppleRaw(row.date),
				deliveredAt: toIsoFromAppleRaw(row.date_delivered),
				readAt: toIsoFromAppleRaw(row.date_read),
				isEdited: false,
				isDeleted: false,
				isSystem: Boolean(row.item_type && row.item_type !== 0),
				isTapback: false,
				replyToMessageId: null,
				threadId: null,
				hasAttachments: attachmentIds.length > 0,
				attachmentIds,
				reactionIds: []
			}

			messagesById[messageId] = convertedMessage

			const normalizedMessageId = normalizeReactionTarget(messageId)
			if (normalizedMessageId) reactionTargetToMessageId.set(normalizedMessageId, messageId)
			const normalizedGuid = normalizeReactionTarget(row.guid)
			if (normalizedGuid) reactionTargetToMessageId.set(normalizedGuid, messageId)

			if (!chatId || !chatById[chatId]) {
				orphans.messages.push(messageId)
				warnings.push(warning('ORPHAN_MESSAGE_CHAT', `Message ${messageId} has unknown chatId ${chatId || 'null'}`, messageId))
			} else {
				chatById[chatId].messageIds.push(messageId)
				const dayKey = toDayKeyFromIso(convertedMessage.sentAt)
				if (dayKey) {
					if (!chatById[chatId].days[dayKey]) chatById[chatId].days[dayKey] = []
					chatById[chatId].days[dayKey].push(messageId)
				}
			}

			if (participantId) messageToParticipant.set(messageId, participantId)
			if (chatId) messageToChat.set(messageId, chatId)
		}

		for (const row of reactionRows) {
			const reactionId = String(row.rowid)
			const target = normalizeReactionTarget(extractBaseGuid(row.associated_message_guid))
			if (!target) {
				orphans.reactions.push(reactionId)
				warnings.push(warning('ORPHAN_REACTION_MESSAGE', `Reaction ${reactionId} has no target message`, reactionId))
				continue
			}

			const targetMessageId = reactionTargetToMessageId.get(target)
			if (!targetMessageId || !messagesById[targetMessageId]) {
				orphans.reactions.push(reactionId)
				warnings.push(warning('ORPHAN_REACTION_MESSAGE', `Reaction ${reactionId} references missing message`, reactionId))
				continue
			}

			const emoji = mapReactionCodeToEmoji(row.associated_message_type) ?? extractEmojiFromReactionText(row.text)
			if (!emoji) continue

			const isByMe = Boolean(row.is_from_me)
			const actorParticipantId = isByMe ? 'me' : row.sender || null
			if (actorParticipantId) includeParticipant(actorParticipantId, messagesById[targetMessageId].chatId || undefined)

			const convertedReaction: ConvertedReactionT = {
				id: reactionId,
				messageId: targetMessageId,
				actor: row.sender || (isByMe ? 'me' : 'unknown'),
				actorParticipantId,
				isByMe,
				emoji,
				createdAt: toIsoFromAppleRaw(row.date),
				authorRole: isByMe ? 'me' : actorParticipantId ? 'participant' : 'system'
			}

			reactionsById[reactionId] = convertedReaction
			messagesById[targetMessageId].reactionIds.push(reactionId)

			const chatId = messagesById[targetMessageId].chatId
			if (chatId && chatById[chatId]) {
				chatById[chatId].reactionIds.push(reactionId)
			}
		}

		for (const row of attachments) {
			const attachmentId = String(row.rowid)
			const messageId = row.message_id !== null ? String(row.message_id) : null
			const chatId = row.chat_id !== null ? String(row.chat_id) : messageId ? (messageToChat.get(messageId) ?? null) : null
			const participantId = messageId ? (messageToParticipant.get(messageId) ?? null) : null
			if (participantId) includeParticipant(participantId, chatId || undefined)

			const filename = row.filename || ''
			const relativePath = toRelativeAttachmentPath(filename)
			const dataPath = relativePath ? (attachmentPathIndex.get(relativePath) ?? '') : ''

			const transferName =
				typeof row.transfer_name === 'string' && row.transfer_name.length > 0
					? row.transfer_name
					: path.basename(filename || `attachment-${attachmentId}`)

			const convertedAttachment: ConvertedAttachmentT = {
				id: attachmentId,
				filename,
				transferName,
				mimeType: row.mime_type || '',
				size: Number(row.total_bytes) || 0,
				createdAt: toIsoFromAppleRaw(row.message_date),
				dataPath,
				thumbnailPath: null,
				previewPath: null,
				chatId,
				messageId,
				participantId,
				isFromMe: participantId === 'me',
				authorRole: participantId === 'me' ? 'me' : participantId ? 'participant' : 'system',
				reactionIds: [],
				backupId: id,
				path: dataPath
			}

			attachmentsById[attachmentId] = convertedAttachment

			if (!chatId) {
				orphans.attachments.push(attachmentId)
				warnings.push(warning('ORPHAN_ATTACHMENT_CHAT', `Attachment ${attachmentId} has no resolvable chat`, attachmentId))
				continue
			}

			if (!chatById[chatId]) {
				orphans.attachments.push(attachmentId)
				warnings.push(
					warning('ORPHAN_ATTACHMENT_UNKNOWN_CHAT', `Attachment ${attachmentId} chat ${chatId} is unknown`, attachmentId)
				)
				continue
			}

			chatById[chatId].attachmentIds.push(attachmentId)
		}

		const finalMessages = Object.fromEntries(
			Object.entries(messagesById).map(([messageId, message]) => {
				const uniqueReactionIds = uniqueIds(message.reactionIds)
				return [
					messageId,
					{
						...message,
						reactionIds: uniqueReactionIds,
						attachmentIds: uniqueIds(message.attachmentIds),
						hasAttachments: uniqueIds(message.attachmentIds).length > 0
					}
				]
			})
		)

		const convertedChats = Object.values(chatById).map((chat) => ({
			...chat,
			participantIds: uniqueIds(chat.participantIds),
			messageIds: uniqueIds(chat.messageIds),
			attachmentIds: uniqueIds(chat.attachmentIds),
			reactionIds: uniqueIds(chat.reactionIds),
			days: Object.fromEntries(Object.entries(chat.days).map(([day, messageIds]) => [day, uniqueIds(messageIds)]))
		}))

		const result: BackupConvertResultT = {
			id,
			path: backupPath,
			deviceName,
			deviceType: 'Unknown',
			iosVersion,
			createdAt,
			modifiedAt,
			sizeOnDisk,
			manifestPath,
			formatVersion: '1.0',
			exportedAt: new Date().toISOString(),
			totalChats: convertedChats.length,
			totalMessages: Object.keys(finalMessages).length,
			totalAttachments: Object.keys(attachmentsById).length,
			totalReactions: Object.keys(reactionsById).length,
			totalParticipants: Object.keys(participants).length,
			warningsCount: warnings.length,
			orphansCount: orphans.messages.length + orphans.attachments.length + orphans.reactions.length,
			participants,
			messages: finalMessages,
			reactions: reactionsById,
			attachments: attachmentsById,
			chats: convertedChats,
			warnings,
			orphans
		}

		return result
	} finally {
		db.close()
	}
}
