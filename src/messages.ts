import BetterSqlite3 from 'better-sqlite3'

type Database = ReturnType<typeof BetterSqlite3>

import { DEFAULT_MESSAGE_LIST_OPTIONS } from './core'
import { createAttachments } from './attachments'
import { createReaction } from './reaction'

import type { AttachmentT, MessageListOptionsT, MessagesT, ReactionT } from './types'

export const createMessages = (db: Database, backupId: string, backupPath: string, chatId?: number): MessagesT => {
	const attachments = createAttachments(db, backupId, backupPath, { chatId })
	const appleEpochMs = Date.UTC(2001, 0, 1)

	const legacyReactionCodeMap: Record<number, string> = {
		2000: '❤️',
		2001: '👍',
		2002: '👎',
		2003: '😂',
		2004: '‼️',
		2005: '❓'
	}

	const normalizeAppleDate = (raw: unknown): Date | null => {
		if (raw === null || raw === undefined) return null
		const value = Number(raw)
		if (!Number.isFinite(value) || value <= 0) return null

		const secondsFromAppleEpoch = value > 1e12 ? value / 1e9 : value
		return new Date(appleEpochMs + secondsFromAppleEpoch * 1000)
	}

	const getDateBounds = (input: Date | string): { start: Date; end: Date } => {
		if (input instanceof Date) {
			if (Number.isNaN(input.getTime())) throw new Error('Invalid date filter')
			return {
				start: new Date(input.getFullYear(), input.getMonth(), input.getDate(), 0, 0, 0, 0),
				end: new Date(input.getFullYear(), input.getMonth(), input.getDate(), 23, 59, 59, 999)
			}
		}

		if (typeof input !== 'string') throw new Error('Invalid date filter')
		const trimmed = input.trim()
		const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
		if (!match) throw new Error(`Invalid date: ${input}. Expected YYYY-MM-DD`)

		const year = Number(match[1])
		const month = Number(match[2])
		const day = Number(match[3])
		const start = new Date(year, month - 1, day, 0, 0, 0, 0)
		if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
			throw new Error(`Invalid date: ${input}`)
		}

		const end = new Date(year, month - 1, day, 23, 59, 59, 999)
		return { start, end }
	}

	const messageDateSecondsSql = `
		(
			CASE
				WHEN m.date > 1000000000000 THEN m.date / 1000000000.0
				ELSE m.date
			END
		)
	`

	const pushDateRangeFilter = (where: string[], params: Array<string | number>, start: Date, end: Date): void => {
		const startSeconds = (start.getTime() - appleEpochMs) / 1000
		const endSeconds = (end.getTime() - appleEpochMs) / 1000

		where.push(`${messageDateSecondsSql} BETWEEN ? AND ?`)
		params.push(startSeconds, endSeconds)
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

	const normalizeReactionTarget = (value: unknown): string | null => {
		if (value === null || value === undefined) return null
		const normalized = String(value).trim().toLowerCase()
		return normalized.length > 0 ? normalized : null
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
		if (namedReactionMatch && namedReactionMatch[1]) {
			return namedReactionMap[namedReactionMatch[1].toLowerCase()] ?? null
		}

		const removedReactionMatch = text.match(/^Removed\s+(.+?)\s+from\b/i)
		if (removedReactionMatch && removedReactionMatch[1]) return removedReactionMatch[1].trim()

		const firstEmojiMatch = text.match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/u)
		return firstEmojiMatch ? firstEmojiMatch[0] : null
	}

	const buildReactionFromRow = (row: any): ReactionT | null => {
		if (!(typeof row.associated_message_guid === 'string' && row.associated_message_guid.length > 0)) {
			return null
		}

		const emoji = mapReactionCodeToEmoji(row.associated_message_type) ?? extractEmojiFromReactionText(row.text)
		if (!emoji) return null

		const createdAt = normalizeAppleDate(row.date) ?? new Date(0)
		const actor = row.sender || (row.is_from_me ? 'me' : 'unknown')
		return createReaction(String(row.rowid), '', actor, emoji, createdAt)
	}

	const getReactionRowsForScope = (): Array<any> => {
		const where: string[] = [
			'm.associated_message_guid IS NOT NULL',
			"m.associated_message_guid != ''",
			'COALESCE(m.associated_message_type, 0) > 0'
		]
		const params: Array<string | number> = []

		if (chatId !== undefined) {
			where.push('cmj.chat_id = ?')
			params.push(chatId)
		}

		const stmt = db.prepare(`
			SELECT
				m.ROWID as rowid,
				h.id as sender,
				m.is_from_me,
				m.text,
				m.date,
				m.associated_message_guid,
				m.associated_message_type
			FROM message m
			LEFT JOIN handle h ON h.ROWID = m.handle_id
			LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
			WHERE ${where.join(' AND ')}
			ORDER BY m.date ASC
		`)

		return stmt.all(...params) as Array<any>
	}

	const populateReactions = (messages: Array<any>): void => {
		if (messages.length === 0) return

		const reactionTargetToMessageId = new Map<string, string>()
		for (const message of messages) {
			const normalizedId = normalizeReactionTarget(message.id)
			if (normalizedId) reactionTargetToMessageId.set(normalizedId, message.id)

			const normalizedGuid = normalizeReactionTarget(message.guid)
			if (normalizedGuid) reactionTargetToMessageId.set(normalizedGuid, message.id)
		}

		if (reactionTargetToMessageId.size === 0) {
			for (const message of messages) message.reactions = []
			return
		}

		const messageById = new Map(messages.map((message) => [message.id, message]))
		const reactionRows = getReactionRowsForScope()

		for (const reactionRow of reactionRows) {
			const target = normalizeReactionTarget(extractBaseGuid(reactionRow.associated_message_guid))
			if (!target) continue

			const targetMessageId = reactionTargetToMessageId.get(target)
			if (!targetMessageId) continue

			const targetMessage = messageById.get(targetMessageId)
			if (!targetMessage) continue

			const reaction = buildReactionFromRow(reactionRow)
			if (!reaction) continue

			targetMessage.reactions.push(
				createReaction(reaction.id, targetMessage.id, reaction.actor, reaction.emoji, reaction.createdAt)
			)
		}
	}

	const getReactionsForMessage = (messageId: string, messageGuid: string | undefined): ReactionT[] => {
		const message = {
			id: messageId,
			guid: messageGuid,
			reactions: [] as ReactionT[]
		}

		populateReactions([message])
		return message.reactions
	}

	const resolveAttachmentsById = (attachmentIds: string[]): AttachmentT[] => {
		if (attachmentIds.length === 0) return []

		return attachmentIds
			.map((attachmentId) => attachments.get(attachmentId))
			.filter((attachment): attachment is AttachmentT => attachment !== null)
	}

	const list = (options: MessageListOptionsT = DEFAULT_MESSAGE_LIST_OPTIONS) => {
		const normalizedOptions = {
			...DEFAULT_MESSAGE_LIST_OPTIONS,
			...options
		}

		const limit =
			Number.isInteger(normalizedOptions.limit) && (normalizedOptions.limit as number) > 0
				? (normalizedOptions.limit as number)
				: null

		const where: string[] = ['COALESCE(m.associated_message_type, 0) <= 0']
		const params: Array<string | number> = []

		if (chatId !== undefined) {
			where.push('cmj.chat_id = ?')
			params.push(chatId)
		}

		if (typeof normalizedOptions.hasAttachment === 'boolean') {
			where.push(
				normalizedOptions.hasAttachment
					? '(SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) > 0'
					: '(SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) = 0'
			)
		}

		if (typeof normalizedOptions.minAttachments === 'number') {
			where.push('(SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) >= ?')
			params.push(normalizedOptions.minAttachments)
		}

		if (typeof normalizedOptions.maxAttachments === 'number') {
			where.push('(SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) <= ?')
			params.push(normalizedOptions.maxAttachments)
		}

		if (normalizedOptions.date !== undefined) {
			const bounds = getDateBounds(normalizedOptions.date)
			pushDateRangeFilter(where, params, bounds.start, bounds.end)
		}

		if (normalizedOptions.fromDate instanceof Date) {
			if (Number.isNaN(normalizedOptions.fromDate.getTime())) throw new Error('Invalid fromDate filter')
			const fromSeconds = (normalizedOptions.fromDate.getTime() - appleEpochMs) / 1000
			where.push(`${messageDateSecondsSql} >= ?`)
			params.push(fromSeconds)
		}

		if (normalizedOptions.toDate instanceof Date) {
			if (Number.isNaN(normalizedOptions.toDate.getTime())) throw new Error('Invalid toDate filter')
			const toSeconds = (normalizedOptions.toDate.getTime() - appleEpochMs) / 1000
			where.push(`${messageDateSecondsSql} <= ?`)
			params.push(toSeconds)
		}

		const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
		const stmt = db.prepare(`
			SELECT
				m.ROWID as rowid,
				m.guid,
				cmj.chat_id as chat_id,
				h.id as sender,
				m.is_from_me,
				m.text,
				m.subject,
				m.service,
				m.date,
				m.date_delivered,
				m.date_read,
				m.item_type,
				m.associated_message_guid,
				m.associated_message_type,
				(SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) as attachment_count,
				(SELECT GROUP_CONCAT(attachment_id) FROM message_attachment_join maj2 WHERE maj2.message_id = m.ROWID) as attachment_ids
			FROM message m
			LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
			LEFT JOIN handle h ON h.ROWID = m.handle_id
			${whereSql}
			ORDER BY m.date DESC
			${limit ? 'LIMIT ?' : ''}
		`)

		const rows = stmt.all(...(limit ? [...params, limit] : params)) as Array<any>

		const messages = rows.map((row: any) => {
			const sentAt = normalizeAppleDate(row.date)
			const deliveredAt = normalizeAppleDate(row.date_delivered)
			const readAt = normalizeAppleDate(row.date_read)

			const attachmentIds =
				typeof row.attachment_ids === 'string' && row.attachment_ids.length > 0
					? row.attachment_ids.split(',').map((id: string) => id.trim())
					: []

			const service = row.service === 'iMessage' || row.service === 'SMS' || row.service === 'MMS' ? row.service : 'Unknown'
			const resolvedAttachments = resolveAttachmentsById(attachmentIds)

			return {
				id: String(row.rowid),
				guid: row.guid || undefined,
				chatId: String(chatId ?? row.chat_id ?? ''),
				sender: row.sender || null,
				isFromMe: Boolean(row.is_from_me),
				text: row.text || null,
				subject: row.subject || null,
				service,
				sentAt,
				deliveredAt,
				readAt,
				isSystem: row.item_type !== 0,
				isTapback: false,
				hasAttachments: resolvedAttachments.length > 0,
				reactions: [] as ReactionT[],
				attachments: resolvedAttachments,
				attachmentIds
			}
		})

		populateReactions(messages)
		return messages
	}

	const get = (id: string) => {
		const numericId = Number(id)
		if (!Number.isInteger(numericId) || numericId <= 0) return null as any

		const where: string[] = ['m.ROWID = ?', 'COALESCE(m.associated_message_type, 0) <= 0']
		const params: Array<string | number> = [numericId]

		if (chatId !== undefined) {
			where.push('cmj.chat_id = ?')
			params.push(chatId)
		}

		const stmt = db.prepare(`
			SELECT
				m.ROWID as rowid,
				m.guid,
				cmj.chat_id as chat_id,
				h.id as sender,
				m.is_from_me,
				m.text,
				m.subject,
				m.service,
				m.date,
				m.date_delivered,
				m.date_read,
				m.item_type,
				m.associated_message_guid,
				m.associated_message_type,
				(SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) as attachment_count,
				(SELECT GROUP_CONCAT(attachment_id) FROM message_attachment_join maj2 WHERE maj2.message_id = m.ROWID) as attachment_ids
			FROM message m
			LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
			LEFT JOIN handle h ON h.ROWID = m.handle_id
			WHERE ${where.join(' AND ')}
			LIMIT 1
		`)

		const row = stmt.get(...params) as any
		if (!row) return null as any

		const attachmentIds =
			typeof row.attachment_ids === 'string' && row.attachment_ids.length > 0
				? row.attachment_ids.split(',').map((attachmentId: string) => attachmentId.trim())
				: []

		const service = row.service === 'iMessage' || row.service === 'SMS' || row.service === 'MMS' ? row.service : 'Unknown'
		const reactions = getReactionsForMessage(String(row.rowid), row.guid || undefined)
		const resolvedAttachments = resolveAttachmentsById(attachmentIds)

		return {
			id: String(row.rowid),
			guid: row.guid || undefined,
			chatId: String(chatId ?? row.chat_id ?? ''),
			sender: row.sender || null,
			isFromMe: Boolean(row.is_from_me),
			text: row.text || null,
			subject: row.subject || null,
			service,
			sentAt: normalizeAppleDate(row.date),
			deliveredAt: normalizeAppleDate(row.date_delivered),
			readAt: normalizeAppleDate(row.date_read),
			isSystem: row.item_type !== 0,
			isTapback: false,
			hasAttachments: resolvedAttachments.length > 0,
			reactions,
			attachments: resolvedAttachments,
			attachmentIds
		} as any
	}

	return {
		list,
		get
	}
}
