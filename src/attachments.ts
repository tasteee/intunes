import fs from 'fs'
import path from 'path'
import BetterSqlite3 from 'better-sqlite3'

type Database = ReturnType<typeof BetterSqlite3>

import { ATTACHMENTS_PATH, DEFAULT_ATTACHMENT_LIST_OPTIONS, getAttachmentManifestRows, getManifestDb } from './core'

import type { AttachmentListOptionsT, AttachmentT, AttachmentsT } from './types'

type AttachmentScopeT = {
	chatId?: number
	messageId?: number
}

export const createAttachments = (
	db: Database,
	backupId: string,
	backupPath: string,
	scope: AttachmentScopeT = {}
): AttachmentsT => {
	let manifestAttachmentPathByRelativePath: Map<string, string> | null = null
	const appleEpochMs = Date.UTC(2001, 0, 1)

	const normalizeAppleDate = (raw: unknown): Date | null => {
		if (raw === null || raw === undefined) return null
		const value = Number(raw)
		if (!Number.isFinite(value) || value <= 0) return null

		const secondsFromAppleEpoch = value > 1e12 ? value / 1e9 : value
		return new Date(appleEpochMs + secondsFromAppleEpoch * 1000)
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

	const ensureAttachmentPathIndex = (): Map<string, string> => {
		if (manifestAttachmentPathByRelativePath) {
			return manifestAttachmentPathByRelativePath
		}

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

		manifestAttachmentPathByRelativePath = pathByRelativePath
		return pathByRelativePath
	}

	const resolveAttachmentDataPath = (filename: unknown): string => {
		const relativePath = toRelativeAttachmentPath(filename)
		if (!relativePath) return ''

		const pathByRelativePath = ensureAttachmentPathIndex()
		return pathByRelativePath.get(relativePath) || ''
	}

	const toAttachmentType = (mimeType: string): string => {
		if (mimeType.startsWith('image/')) return 'image'
		if (mimeType.startsWith('video/')) return 'video'
		if (mimeType.startsWith('audio/')) return 'audio'
		return 'other'
	}

	const getFileExtension = (filename: string): string => {
		const ext = path.extname(filename).toLowerCase()
		return ext.startsWith('.') ? ext.slice(1) : ext
	}

	const matchesTypeAndExtensionFilters = (attachment: AttachmentT, options: AttachmentListOptionsT): boolean => {
		if (typeof options.type === 'string' && options.type.length > 0) {
			if (toAttachmentType(attachment.mimeType).toLowerCase() !== options.type.toLowerCase()) {
				return false
			}
		}

		if (options.extension !== undefined) {
			const extensionFilter = Array.isArray(options.extension)
				? options.extension.map((value) => String(value).toLowerCase().replace(/^\./, ''))
				: [String(options.extension).toLowerCase().replace(/^\./, '')]

			const extension = getFileExtension(attachment.transferName || attachment.filename)
			if (!extensionFilter.includes(extension)) return false
		}

		return true
	}

	const matchesDateFilters = (createdAt: Date, options: AttachmentListOptionsT): boolean => {
		if (options.fromDate instanceof Date && createdAt < options.fromDate) return false
		if (options.toDate instanceof Date && createdAt > options.toDate) return false
		return true
	}

	const buildAttachmentFromRow = (row: any): AttachmentT => {
		const filename = typeof row.filename === 'string' ? row.filename : ''
		const transferName =
			typeof row.transfer_name === 'string' && row.transfer_name.length > 0
				? row.transfer_name
				: path.basename(filename || `attachment-${row.rowid}`)

		const mimeType = typeof row.mime_type === 'string' ? row.mime_type : ''
		const size = Number(row.total_bytes) || 0
		const createdAt = normalizeAppleDate(row.message_date) ?? new Date(0)
		const dataPath = resolveAttachmentDataPath(row.filename)

		return {
			id: String(row.rowid),
			filename,
			transferName,
			mimeType,
			size,
			createdAt,
			dataPath,
			backupId,
			path: dataPath,
			chatId: row.chat_id !== null && row.chat_id !== undefined ? String(row.chat_id) : undefined,
			messageId: row.message_id !== null && row.message_id !== undefined ? String(row.message_id) : undefined
		}
	}

	const list = (options: AttachmentListOptionsT = DEFAULT_ATTACHMENT_LIST_OPTIONS): AttachmentT[] => {
		const normalizedOptions = {
			...DEFAULT_ATTACHMENT_LIST_OPTIONS,
			...options
		}

		const where: string[] = []
		const params: Array<string | number> = []

		if (scope.chatId !== undefined) {
			where.push('cmj.chat_id = ?')
			params.push(scope.chatId)
		}

		if (scope.messageId !== undefined) {
			where.push('maj.message_id = ?')
			params.push(scope.messageId)
		}

		if (typeof normalizedOptions.minSize === 'number') {
			where.push('COALESCE(a.total_bytes, 0) >= ?')
			params.push(normalizedOptions.minSize)
		}

		if (typeof normalizedOptions.maxSize === 'number') {
			where.push('COALESCE(a.total_bytes, 0) <= ?')
			params.push(normalizedOptions.maxSize)
		}

		const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''

		const stmt = db.prepare(`
			SELECT
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
			${whereSql}
			ORDER BY m.date DESC, a.ROWID DESC
		`)

		const rows = stmt.all(...params) as Array<any>
		const uniqueRowsById = new Map<string, any>()
		for (const row of rows) {
			const key = String(row.rowid)
			if (!uniqueRowsById.has(key)) uniqueRowsById.set(key, row)
		}

		const attachments = Array.from(uniqueRowsById.values())
			.map((row) => buildAttachmentFromRow(row))
			.filter((attachment) => matchesTypeAndExtensionFilters(attachment, normalizedOptions))
			.filter((attachment) => matchesDateFilters(attachment.createdAt, normalizedOptions))

		const offset =
			Number.isInteger(normalizedOptions.offset) && normalizedOptions.offset >= 0
				? normalizedOptions.offset
				: DEFAULT_ATTACHMENT_LIST_OPTIONS.offset

		const limit =
			Number.isInteger(normalizedOptions.limit) && normalizedOptions.limit > 0 ? normalizedOptions.limit : undefined

		if (limit === undefined) return attachments.slice(offset)
		return attachments.slice(offset, offset + limit)
	}

	const get = (id: string): AttachmentT | null => {
		const numericId = Number(id)
		if (!Number.isInteger(numericId) || numericId <= 0) return null

		const where: string[] = ['a.ROWID = ?']
		const params: Array<string | number> = [numericId]

		if (scope.chatId !== undefined) {
			where.push('cmj.chat_id = ?')
			params.push(scope.chatId)
		}

		if (scope.messageId !== undefined) {
			where.push('maj.message_id = ?')
			params.push(scope.messageId)
		}

		const stmt = db.prepare(`
			SELECT
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
			WHERE ${where.join(' AND ')}
			ORDER BY m.date DESC
			LIMIT 1
		`)

		const row = stmt.get(...params) as any
		if (!row) return null
		return buildAttachmentFromRow(row)
	}

	const createReadStream = (id: string) => {
		const attachment = get(id)
		if (!attachment || !attachment.dataPath) {
			throw new Error(`Attachment ${id} not found`)
		}

		return fs.createReadStream(attachment.dataPath) as any
	}

	const saveToFile = async (id: string, destPath: string): Promise<void> => {
		const attachment = get(id)
		if (!attachment || !attachment.dataPath) {
			throw new Error(`Attachment ${id} not found`)
		}

		await fs.promises.copyFile(attachment.dataPath, destPath)
	}

	return {
		list,
		get,
		createReadStream,
		saveToFile
	}
}
