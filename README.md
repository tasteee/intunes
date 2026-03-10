# intunes

Read iMessage data from local iTunes/Apple device backups on Windows.

## Install

```bash
npm add intunes
# or
bun add intunes
# or
yarn add intunes
```

## Platform And Scope

- Targets Windows backup locations.
- Read-only access to backup metadata, chats, messages, reactions, and attachments.
- Main backup scan path: `%APPDATA%/Apple Computer/MobileSync/Backup`.

## Quick Start

```ts
import { intunes } from 'intunes'

const backups = intunes.backups.list()
if (!backups.length) throw new Error('No backups found')

const backup = intunes.backups.get(backups[0].id)

const chats = backup.chats.list({ limit: 25 })
const firstChat = chats[0]

const messages = firstChat.messages.list({ hasAttachment: true })
const firstMessage = messages[0]

const attachments = backup.attachments.list({ type: 'image', limit: 10 })

console.log({
	backup: backup.id,
	chatCount: chats.length,
	firstMessageId: firstMessage?.id,
	attachmentCount: attachments.length
})
```

## API Reference

### `intunes`

Top-level singleton export.

| Property  | Type      | Description                   |
| --------- | --------- | ----------------------------- |
| `backups` | `Backups` | Access and open local backups |

### `Backups`

#### `backups.list(options?) => Backup[]`

Returns all backup folders that contain `Info.plist`.

Options type:

```ts
type BackupListOptionsT = {}
```

#### `backups.get(id: string) => Backup`

Returns backup by folder name.

Throws:

- `Error` if backup is not found.

#### `backups.convert(id: string) => BackupConvertResult`

Builds a normalized JSON tree for a backup id.

Notes:

- Canonical objects are keyed by id at the backup root (`participants`, `messages`, `attachments`, `reactions`).
- Chat records reference related entities by id arrays.
- Includes explicit ownership fields for local user clarity (`isFromMe`, `isByMe`, `authorRole`).
- Includes `warnings` and `orphans` buckets for unresolved links.

### `Backup`

Represents one backup.

| Property      | Type                        | Description                           |
| ------------- | --------------------------- | ------------------------------------- |
| `id`          | `string`                    | Backup folder name                    |
| `path`        | `string`                    | Absolute path to backup folder        |
| `deviceName`  | `string`                    | From `Info.plist`, fallback `Unknown` |
| `iosVersion`  | `string`                    | From `Info.plist`, fallback `Unknown` |
| `sizeOnDisk`  | `number`                    | Currently initialized to `0`          |
| `chats`       | `Chats`                     | Chat accessor scoped to this backup   |
| `messages`    | `Messages`                  | Message accessor across all chats     |
| `attachments` | `Attachments`               | Attachment accessor across all chats  |
| `convert`     | `() => BackupConvertResult` | Build normalized backup JSON tree     |

Construction behavior:

- Locates `sms.db` through `Manifest.db` mapping.
- Opens SQLite in read-only mode.
- Throws `Error` if the SMS database cannot be resolved.

#### `backup.convert() => BackupConvertResult`

Builds the same normalized JSON tree as `backups.convert(id)` for the already-open backup instance.

### `Chats`

#### `chats.list(options?) => Chat[]`

Returns chats ordered by `ROWID DESC`.

Options type:

```ts
type ChatsListOptionsT = {
	limit?: number
	offset?: number
	search?: string
}
```

Defaults:

- `limit: 500`
- `offset: 0`

Notes:

- Invalid/non-positive `limit` falls back to default.
- Invalid/negative `offset` falls back to default.
- `search` exists in the type but is currently not applied in query logic.

#### `chats.get(id: string) => Chat`

Returns one chat by numeric ROWID.

Throws:

- `Error` for invalid/non-positive id.
- `Error` if not found.

### `Chat`

| Property        | Type           | Description                          |
| --------------- | -------------- | ------------------------------------ |
| `id`            | `string`       | Chat ROWID                           |
| `displayName`   | `string`       | Chat name or `Unknown`               |
| `isGroup`       | `boolean`      | Heuristic based on `chat_identifier` |
| `participants`  | `Handle[]`     | Participant handles in chat          |
| `messageCount`  | `number`       | Count via `chat_message_join`        |
| `messageDates`  | `string[]`     | Unique message days (`YYYY-MM-DD`)   |
| `lastMessageAt` | `Date \| null` | Currently initialized as `null`      |
| `messages`      | `Messages`     | Messages scoped to this chat         |
| `attachments`   | `Attachments`  | Attachments scoped to this chat      |

#### `chat.export(options: ChatExportOptionsT) => boolean`

Current behavior: placeholder implementation that returns `false`.

### `Messages`

Available as:

- `backup.messages` for global access.
- `chat.messages` for chat-scoped access.

#### `messages.list(options?) => Message[]`

Returns messages ordered by `m.date DESC` and excludes reaction rows (`associated_message_type > 0`).
Each returned message has `reactions` populated.

Options type:

```ts
type MessageListOptionsT = {
	limit?: number
	date?: Date | string
	fromDate?: Date
	toDate?: Date
	hasAttachment?: boolean
	minAttachments?: number
	maxAttachments?: number
}
```

Defaults:

- Empty defaults object (no filters applied).

Examples:

- Last message in a chat: `chat.messages.list({ limit: 1 })[0]`
- All messages for a specific day: `chat.messages.list({ date: '2026-03-10' })`

#### `messages.get(id: string) => Message | null`

Returns one message by numeric ROWID (scoped if called through `chat.messages`).

Behavior:

- Returns `null` if id is invalid/non-positive.
- Returns `null` if message is not found.
- Includes `reactions` array.

### `Message`

| Property         | Type                                        | Description                                  |
| ---------------- | ------------------------------------------- | -------------------------------------------- |
| `id`             | `string`                                    | Message ROWID                                |
| `guid`           | `string \| undefined`                       | Apple GUID when present                      |
| `chatId`         | `string`                                    | Chat id context                              |
| `sender`         | `string \| null`                            | Handle id when present                       |
| `isFromMe`       | `boolean`                                   | Sent by backup owner                         |
| `text`           | `string \| null`                            | Body text                                    |
| `subject`        | `string \| null`                            | MMS subject                                  |
| `service`        | `'iMessage' \| 'SMS' \| 'MMS' \| 'Unknown'` | Transport service                            |
| `sentAt`         | `Date \| null`                              | Normalized Apple epoch date                  |
| `deliveredAt`    | `Date \| null`                              | Delivery timestamp                           |
| `readAt`         | `Date \| null`                              | Read timestamp                               |
| `isSystem`       | `boolean`                                   | Non-zero `item_type`                         |
| `isTapback`      | `boolean`                                   | Always `false` on message objects            |
| `hasAttachments` | `boolean`                                   | Attachment count > 0                         |
| `attachments`    | `Attachment[]`                              | Resolved attachment objects for this message |
| `attachmentIds`  | `string[]`                                  | Related attachment ids                       |
| `reactions`      | `Reaction[]`                                | Parsed tapback/reaction events               |

### `Reaction`

| Property    | Type     | Description                     |
| ----------- | -------- | ------------------------------- |
| `id`        | `string` | Reaction row id                 |
| `messageId` | `string` | Target message id               |
| `actor`     | `string` | Sender handle or `me`/`unknown` |
| `emoji`     | `string` | Resolved emoji                  |
| `createdAt` | `Date`   | Normalized reaction timestamp   |

### `Handle`

| Property     | Type     | Description        |
| ------------ | -------- | ------------------ |
| `id`         | `string` | Raw handle         |
| `value`      | `string` | Same as id         |
| `normalized` | `string` | Lowercased `value` |

### `Attachments`

Available as:

- `backup.attachments` for global attachment access.
- `chat.attachments` for chat-scoped attachment access.

#### `attachments.list(options?) => Attachment[]`

Returns attachments sorted by message date desc. Deduplicates by attachment id.

Options type:

```ts
type AttachmentListOptionsT = {
	limit?: number
	offset?: number
	type?: string
	extension?: string | string[]
	fromDate?: Date
	toDate?: Date
	minSize?: number
	maxSize?: number
}
```

Defaults:

- `offset: 0`
- `limit: 100000`

Filtering behavior:

- `type` is matched against normalized categories: `image`, `video`, `audio`, `other`.
- `extension` accepts one extension or an array, with or without leading dot.
- `fromDate`/`toDate` compare against attachment message date.
- `minSize`/`maxSize` compare against `total_bytes`.

#### `attachments.get(id: string) => Attachment | null`

Returns one attachment by numeric ROWID (scope-aware).

Behavior:

- Returns `null` for invalid/non-positive id.
- Returns `null` if not found.

#### `attachments.createReadStream(id: string) => ReadStream`

Returns a Node.js read stream for the attachment file.

Throws:

- `Error` if attachment is missing or backing file path is unresolved.

#### `attachments.saveToFile(id: string, destPath: string) => Promise<void>`

Copies an attachment file to `destPath`.

Throws:

- `Error` if attachment is missing or backing file path is unresolved.

### `Attachment`

| Property       | Type                  | Description                      |
| -------------- | --------------------- | -------------------------------- |
| `id`           | `string`              | Attachment ROWID                 |
| `filename`     | `string`              | Original stored filename         |
| `transferName` | `string`              | User-facing name when present    |
| `mimeType`     | `string`              | MIME type                        |
| `size`         | `number`              | Byte size                        |
| `createdAt`    | `Date`                | Derived from linked message date |
| `dataPath`     | `string`              | Resolved absolute path in backup |
| `backupId`     | `string`              | Owning backup id                 |
| `path`         | `string`              | Same as `dataPath`               |
| `chatId`       | `string \| undefined` | Parent chat id when known        |
| `messageId`    | `string \| undefined` | Parent message id when known     |

## End-To-End Example

```ts
import { intunes } from 'intunes'

const backup = intunes.backups.list()[0]
if (!backup) throw new Error('No backup found')

const opened = intunes.backups.get(backup.id)

const chats = opened.chats.list({ limit: 10, offset: 0 })
for (const chat of chats) {
	console.log(chat.id, chat.displayName, chat.messageCount)

	const messages = chat.messages.list({ hasAttachment: true })
	if (messages[0]) {
		const fullMessage = chat.messages.get(messages[0].id)
		console.log(fullMessage?.id, fullMessage?.reactions?.length ?? 0)
	}

	const attachments = chat.attachments.list({ type: 'image', limit: 5 })
	if (attachments[0]) {
		await chat.attachments.saveToFile(attachments[0].id, `./${attachments[0].transferName}`)
	}
}
```
