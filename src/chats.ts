import BetterSqlite3 from 'better-sqlite3'

type Database = ReturnType<typeof BetterSqlite3>

import { DEFAULT_CHAT_LIST_OPTIONS } from './core'
import { createChat } from './chat'

import type { ChatsListOptionsT, ChatsT, ChatT, HandleT } from './types'

export const createChats = (db: Database, backupId: string, backupPath: string): ChatsT => {
	const getParticipants = (chatRowId: number): HandleT[] => {
		const participantsStmt = db.prepare(`
			SELECT h.id
			FROM chat_handle_join chj
			INNER JOIN handle h ON h.ROWID = chj.handle_id
			WHERE chj.chat_id = ?
			ORDER BY h.id
		`)

		return (participantsStmt.all(chatRowId) as Array<{ id: string | null }>)
			.filter((participantRow) => typeof participantRow.id === 'string' && participantRow.id.length > 0)
			.map((participantRow) => ({
				id: participantRow.id as string,
				value: participantRow.id as string,
				normalized: (participantRow.id as string).toLowerCase()
			}))
	}

	const list = (options: ChatsListOptionsT = {}): ChatT[] => {
		const normalizedOptions = {
			...DEFAULT_CHAT_LIST_OPTIONS,
			...options
		}

		const limit =
			Number.isInteger(normalizedOptions.limit) && normalizedOptions.limit > 0
				? normalizedOptions.limit
				: DEFAULT_CHAT_LIST_OPTIONS.limit
		const offset =
			Number.isInteger(normalizedOptions.offset) && normalizedOptions.offset >= 0
				? normalizedOptions.offset
				: DEFAULT_CHAT_LIST_OPTIONS.offset

		const stmt = db.prepare(`
			SELECT
				c.ROWID,
				c.display_name,
				c.chat_identifier,
				(
					SELECT COUNT(*)
					FROM chat_message_join cmj
					WHERE cmj.chat_id = c.ROWID
				) as message_count
			FROM chat c
			ORDER BY c.ROWID DESC
			LIMIT ? OFFSET ?
		`)

		const rows = stmt.all(limit, offset) as Array<any>

		return rows.map((row) => {
			const participants = getParticipants(row.ROWID)
			return createChat(
				db,
				backupId,
				backupPath,
				row.ROWID,
				row.display_name || '',
				row.chat_identifier || null,
				participants,
				Number(row.message_count) || 0
			)
		})
	}

	const get = (id: string): ChatT => {
		const numericId = Number(id)
		if (!Number.isInteger(numericId) || numericId <= 0) {
			throw new Error(`Invalid chat id: ${id}`)
		}

		const stmt = db.prepare(`
			SELECT
				c.ROWID,
				c.display_name,
				c.chat_identifier,
				(
					SELECT COUNT(*)
					FROM chat_message_join cmj
					WHERE cmj.chat_id = c.ROWID
				) as message_count
			FROM chat c
			WHERE c.ROWID = ?
			LIMIT 1
		`)

		const row = stmt.get(numericId) as any
		if (!row) throw new Error(`Chat ${id} not found`)

		const participants = getParticipants(row.ROWID)
		return createChat(
			db,
			backupId,
			backupPath,
			row.ROWID,
			row.display_name || '',
			row.chat_identifier || null,
			participants,
			Number(row.message_count) || 0
		)
	}

	return {
		list,
		get
	}
}
