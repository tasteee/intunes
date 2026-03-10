import fs from 'fs'
import os from 'os'
import path from 'path'
import BetterSqlite3 from 'better-sqlite3'

type Database = ReturnType<typeof BetterSqlite3>

import type { AttachmentListOptionsT, ChatsListOptionsT, ManifestFileRowT, MessageListOptionsT } from './types'

export const SMS_DB_PATH = 'Library/SMS/sms.db'
export const ATTACHMENTS_PATH = 'Library/SMS/Attachments'

const HOME_DIR = os.homedir()
const APP_DATA_DIR = process.env.APPDATA || path.join(HOME_DIR, 'AppData', 'Roaming')
const WINDOWS_ITUNES_BACKUP_PATH = path.join(HOME_DIR, 'Apple', 'MobileSync', 'Backup')
const ITUNES_BACKUP_PATH = path.join(APP_DATA_DIR, 'Apple Computer', 'MobileSync', 'Backup')

export const DEFAULT_CHAT_LIST_OPTIONS: Required<Pick<ChatsListOptionsT, 'limit' | 'offset'>> = {
	limit: 500,
	offset: 0
}

export const DEFAULT_MESSAGE_LIST_OPTIONS: MessageListOptionsT = {}

export const DEFAULT_ATTACHMENT_LIST_OPTIONS: Required<Pick<AttachmentListOptionsT, 'offset' | 'limit'>> = {
	offset: 0,
	limit: 100000
}

export const getManifestPath = (backupPath: string): string => {
	return path.join(backupPath, 'Manifest.db')
}

export const getManifestDb = (backupPath: string): Database => {
	return new BetterSqlite3(getManifestPath(backupPath), { readonly: true })
}

const getManifestRow = (manifestDb: Database) => {
	const manifestQuery = manifestDb.prepare(`
		SELECT fileID
		FROM Files
		WHERE relativePath = ?
		LIMIT 1
	`)

	return manifestQuery.get(SMS_DB_PATH) as { fileID: string } | undefined
}

export const getAttachmentManifestRows = (manifestDb: Database): ManifestFileRowT[] => {
	const manifestQuery = manifestDb.prepare(`
		SELECT fileID, relativePath
		FROM Files
		WHERE relativePath LIKE ?
	`)

	return manifestQuery.all(`${ATTACHMENTS_PATH}/%`) as ManifestFileRowT[]
}

export const findSmsDbPath = (backupPath: string): string => {
	const manifestDb = getManifestDb(backupPath)
	const manifestRow = getManifestRow(manifestDb)
	manifestDb.close()

	if (!manifestRow) return ''

	const targetFileId = manifestRow.fileID
	const targetSubdirectory = targetFileId.slice(0, 2)
	const primaryDatabasePath = path.join(backupPath, targetSubdirectory, targetFileId)
	if (fs.existsSync(primaryDatabasePath)) return primaryDatabasePath

	const fallbackDatabasePath = path.join(backupPath, targetFileId)
	if (fs.existsSync(fallbackDatabasePath)) return fallbackDatabasePath

	return ''
}

export const getWindowsBackupPaths = (): string[] => {
	return [WINDOWS_ITUNES_BACKUP_PATH, ITUNES_BACKUP_PATH].filter((candidatePath) => fs.existsSync(candidatePath))
}
