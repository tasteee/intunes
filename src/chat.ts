import BetterSqlite3 from 'better-sqlite3'

type Database = ReturnType<typeof BetterSqlite3>

import { createAttachments } from './attachments'
import { createMessages } from './messages'

import type { ChatExportOptionsT, ChatT, HandleT } from './types'

export const createChat = (
	db: Database,
	backupId: string,
	backupPath: string,
	rowId: number,
	displayName: string,
	chatIdentifier: string | null,
	participants: HandleT[],
	messageCount: number
): ChatT => {
	const chatId = String(rowId)
	const messages = createMessages(db, backupId, backupPath, rowId)

	const getMessageDates = (): string[] => {
		const stmt = db.prepare(`
			SELECT DISTINCT
				strftime(
					'%Y-%m-%d',
					978307200 + (
						CASE
							WHEN m.date > 1000000000000 THEN m.date / 1000000000.0
							ELSE m.date
						END
					),
					'unixepoch',
					'localtime'
				) as message_date
			FROM message m
			INNER JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
			WHERE cmj.chat_id = ?
				AND COALESCE(m.associated_message_type, 0) <= 0
				AND m.date IS NOT NULL
				AND m.date > 0
			ORDER BY message_date DESC
		`)

		const rows = stmt.all(rowId) as Array<{ message_date: string | null }>
		return rows
			.map((row) => row.message_date)
			.filter((messageDate): messageDate is string => typeof messageDate === 'string' && messageDate.length > 0)
	}

	const messageDates = getMessageDates()

	const exportChat = (_options: ChatExportOptionsT): boolean => {
		return false
	}

	return {
		id: chatId,
		displayName: displayName || 'Unknown',
		isGroup: Boolean(chatIdentifier?.includes('chat')),
		participants,
		messageCount: Number(messageCount) || 0,
		messageDates,
		lastMessageAt: null,
		messages,
		attachments: createAttachments(db, backupId, backupPath, { chatId: rowId }),
		export: exportChat
	}
}
