// index.ts
import fs from 'fs'
import path from 'path'

import { getWindowsBackupPaths } from './core'
import { getBackup } from './backup'

import type { BackupT, IntunesT } from './types'

const backups = (() => {
	const backupDirs = getWindowsBackupPaths()

	const list = (): BackupT[] => {
		const foundBackups: BackupT[] = []

		for (const dir of backupDirs) {
			const folders = fs
				.readdirSync(dir, { withFileTypes: true })
				.filter((dirent) => dirent.isDirectory())
				.map((dirent) => path.join(dir, dirent.name))

			for (const folder of folders) {
				if (fs.existsSync(path.join(folder, 'Info.plist'))) {
					foundBackups.push(getBackup(folder))
				}
			}
		}

		return foundBackups
	}

	const get = (id: string): BackupT => {
		const backup = list().find((candidate) => candidate.id === id)
		if (!backup) throw new Error(`Backup ${id} not found`)
		return backup
	}

	const convert = (id: string) => {
		return get(id).convert()
	}

	return { list, get, convert }
})()

const intunes: IntunesT = (() => {
	return { backups }
})()

export { getBackup as Backup, intunes }
