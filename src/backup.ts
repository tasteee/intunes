import fs from 'fs'
import path from 'path'
import plist from 'plist'
import BetterSqlite3 from 'better-sqlite3'

type Database = ReturnType<typeof BetterSqlite3>

import { findSmsDbPath, getManifestPath } from './core'
import { createAttachments } from './attachments'
import { createChats } from './chats'
import { createMessages } from './messages'
import { convertBackupToTree } from './convert'

import type { BackupT } from './types'

export const getBackup = (backupPath: string): BackupT => {
	const id = path.basename(backupPath)
	const smsDbPath = findSmsDbPath(backupPath)

	const infoPlistPath = path.join(backupPath, 'Info.plist')
	let deviceName = 'Unknown'
	let iosVersion = 'Unknown'

	if (fs.existsSync(infoPlistPath)) {
		try {
			const info: any = plist.parse(fs.readFileSync(infoPlistPath, 'utf8'))
			deviceName = info['Device Name'] || 'Unknown'
			iosVersion = info['Product Version'] || 'Unknown'
		} catch {
			console.warn(`Could not parse Info.plist for ${id}`)
		}
	}

	if (!fs.existsSync(smsDbPath)) {
		throw new Error(`sms.db not found for backup ${id}`)
	}

	const smsDb = new BetterSqlite3(smsDbPath, { readonly: true })
	const backupStats = fs.statSync(backupPath)
	const chats = createChats(smsDb, id, backupPath)
	const messages = createMessages(smsDb, id, backupPath)
	const attachments = createAttachments(smsDb, id, backupPath)

	const backup: BackupT = {
		id,
		path: backupPath,
		deviceName,
		iosVersion,
		sizeOnDisk: 0,
		deviceType: 'Unknown',
		createdAt: backupStats.birthtime,
		modifiedAt: backupStats.mtime,
		manifestPath: getManifestPath(backupPath),
		chats,
		messages,
		attachments,
		convert: () => convertBackupToTree(backup)
	}

	return backup
}
