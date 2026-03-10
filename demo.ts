import { intunes } from './src'

const backups = intunes.backups.list()
console.log(`Found ${backups.length} iTunes backup(s) on this system.`)

if (!backups[0]) {
	console.error('No iTunes backups found on this system.')
	process.exit(1)
}

console.log(backups[0])

const backupId = backups[0].id
const backup = intunes.backups.get(backupId)
const chats = backup.chats.list()
console.log(`Found ${chats.length} chat(s) in backup ${backupId}.`)

if (chats.length > 0) {
	for (const chat of chats) {
		console.log(`chat: ${chat.id} has ${chat.messageCount} messages.`)
	}
}

const chat = backup.chats.get(String(2))

if (!chat) {
	console.error(`Chat with id ${String(2)} not found in backup ${backupId}`)
	process.exit(1)
}

const messages = backup.messages.list()
console.log(`Found ${messages.length} message(s) in backup ${backupId}.`)

const attachments = backup.attachments.list()
console.log(`Found ${attachments.length} attachment(s) in backup ${backupId}.`)
