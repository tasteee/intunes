import fs from 'node:fs/promises'
import path from 'node:path'

import { converter } from './src/converter.ts'

const main = async (): Promise<void> => {
	if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
		throw new Error(
			'Bun runtime is not supported for this demo on Windows because better-sqlite3 fails to load. Run with Node instead: node --experimental-strip-types demo.ts'
		)
	}

	const { intunes } = await import('./src/index.ts')

	const backups = intunes.backups.list()
	if (!backups.length) throw new Error('No backups found')
	const firstBackup = backups[0]
	if (!firstBackup) throw new Error('No backups found')

	const backupId = firstBackup.id
	const fullTree = converter(backupId)

	const outputPath = path.join(process.cwd(), `backup-${backupId}-sample.json`)
	await fs.writeFile(outputPath, JSON.stringify(fullTree, null, 2), 'utf8')

	console.log(`Saved full conversion JSON to ${outputPath}`)
	console.log(
		JSON.stringify(
			{
				backupId,
				counts: {
					chats: fullTree.totalChats,
					messages: fullTree.totalMessages,
					reactions: fullTree.totalReactions,
					attachments: fullTree.totalAttachments,
					participants: fullTree.totalParticipants
				}
			},
			null,
			2
		)
	)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
