// index.ts
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Database } from "bun:sqlite";
import plist from 'plist';

const SMS_DB_PATH = 'Library/SMS/sms.db'
const ATTACHMENTS_PATH = 'Library/SMS/Attachments'
const HOME_DIR = os.homedir();
const APP_DATA_DIR = process.env.APPDATA || path.join(HOME_DIR, 'AppData', 'Roaming');

// backupPath: %APPDATA%/Apple Computer/MobileSync/Backup/[id]
// manifestPath: %APPDATA%/Apple Computer/MobileSync/Backup/[id]/Manifest.db
const getManifestPath = (backupPath: string): string => {
	const manifestPath = path.join(backupPath, 'Manifest.db')
	return manifestPath
}

const getManifestDb = (backupPath: string): Database => {
	const manifestPath = getManifestPath(backupPath)
	const manifestDb = new Database(manifestPath, { readonly: true })
	return manifestDb
}

// Given a normal file path, this function asks the manifest database what hashed
// filename iOS used to store that file in the backup.
const getManifestRow = (manifestDb: Database) => {
	const manifestQuery = manifestDb.prepare(`
		SELECT fileID
		FROM Files
		WHERE relativePath = ?
		LIMIT 1
	`)

	const manifestRow = manifestQuery.get(SMS_DB_PATH) as { fileID: string } | undefined
	return manifestRow
}

const getAttachmentManifestRows = (manifestDb:  Database): ManifestFileRowT[] => {
	const manifestQuery = manifestDb.prepare(`
		SELECT fileID, relativePath
		FROM Files
		WHERE relativePath LIKE ?
	`)

	const rows = manifestQuery.all(`${ATTACHMENTS_PATH}/%`) as ManifestFileRowT[]
	return rows
}


// This function attempts to find the correct database file path for
// a given backup by looking up the Manifest.db file.
const findSmsDbPath = (backupPath: string): string => {
	const manifestDb = getManifestDb(backupPath)
	const manifestRow = getManifestRow(manifestDb)
	manifestDb.close()
	if (!manifestRow) return ''
	const targetFileId = manifestRow.fileID
	const targetSubdirectory = targetFileId.slice(0, 2)
	const primaryDatabasePath = path.join(backupPath, targetSubdirectory, targetFileId)
	const isPrimaryPathValid = fs.existsSync(primaryDatabasePath)
	if (isPrimaryPathValid) return primaryDatabasePath
	const fallbackDatabasePath = path.join(backupPath, targetFileId)
	const isFallbackPathValid = fs.existsSync(fallbackDatabasePath)
	if (isFallbackPathValid) return fallbackDatabasePath
	return ''
}

const WINDOWS_ITUNES_BACKUP_PATH = path.join(HOME_DIR, 'Apple', 'MobileSync', 'Backup') 
const ITUNES_BACKUP_PATH = path.join(APP_DATA_DIR, 'Apple Computer', 'MobileSync', 'Backup')

const DEFAULT_CHAT_LIST_OPTIONS: Required<Pick<ChatsListOptionsT, 'limit' | 'offset'>> = {
  limit: 500,
  offset: 0
}

const DEFAULT_MESSAGE_LIST_OPTIONS: MessageListOptionsT = {}
const DEFAULT_ATTACHMENT_LIST_OPTIONS: Required<Pick<AttachmentListOptionsT, 'offset' | 'limit'>> = {
  offset: 0,  
  limit: 100000
}

const getWindowsBackupPaths = (): string[] => {
  return [
    // WINDOWS_ITUNES_BACKUP_PATH,
    ITUNES_BACKUP_PATH
  ].filter(p => fs.existsSync(p));
}

// --- DOMAIN CLASSES ---

class Chat implements ChatT {
  public id: string;
  public displayName: string;
  public isGroup: boolean;
  public participants: HandleT[];
  public messageCount: number;
  public lastMessageAt: Date | null;
  public messages: Messages;
  public attachments: Attachments;

  constructor(
    private db: Database,
    private backupId: string,
    private backupPath: string,
    private rowId: number,
    displayName: string,
    chatIdentifier: string | null,
    participants: HandleT[],
    messageCount: number
  ) {
    this.id = String(rowId);
    this.displayName = displayName || 'Unknown';
    this.isGroup = Boolean(chatIdentifier?.includes('chat'));
    this.participants = participants;
    this.messageCount = Number(messageCount) || 0;
    this.lastMessageAt = null;
    this.messages = new Messages(this.db, this.backupId, this.rowId);
    this.attachments = new Attachments(this.db, this.backupId, this.backupPath, this.rowId);
  }

  export(_options: ChatExportOptionsT): boolean {
    return false;
  }
}

class Chats {
  constructor(private db: Database, private backupId: string, private backupPath: string) {}

  private getParticipants(chatRowId: number): HandleT[] {
    const participantsStmt = this.db.prepare(`
      SELECT h.id
      FROM chat_handle_join chj
      INNER JOIN handle h ON h.ROWID = chj.handle_id
      WHERE chj.chat_id = ?
      ORDER BY h.id
    `);

    return (participantsStmt.all(chatRowId) as Array<{ id: string | null }>)
      .filter((participantRow) => typeof participantRow.id === 'string' && participantRow.id.length > 0)
      .map((participantRow) => ({
        id: participantRow.id as string,
        value: participantRow.id as string,
        normalized: (participantRow.id as string).toLowerCase()
      }));
  }

  list(options: ChatsListOptionsT = {}) {
    const normalizedOptions = {
      ...DEFAULT_CHAT_LIST_OPTIONS,
      ...options
    };

    const limit = Number.isInteger(normalizedOptions.limit) && normalizedOptions.limit > 0
      ? normalizedOptions.limit
      : DEFAULT_CHAT_LIST_OPTIONS.limit;
    const offset = Number.isInteger(normalizedOptions.offset) && normalizedOptions.offset >= 0
      ? normalizedOptions.offset
      : DEFAULT_CHAT_LIST_OPTIONS.offset;

    const stmt = this.db.prepare(`
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
    `);
    
    const rows = stmt.all(limit, offset);

    return rows.map((row: any) => {
      const participants = this.getParticipants(row.ROWID);
      return new Chat(
        this.db,
        this.backupId,
        this.backupPath,
        row.ROWID,
        row.display_name || 'Unknown',
        row.chat_identifier || null,
        participants,
        Number(row.message_count) || 0
      );
    });
  }

  get(id: string): ChatT {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new Error(`Invalid chat id: ${id}`);
    }

    const stmt = this.db.prepare(`
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
    `);

    const row = stmt.get(numericId) as any;
    if (!row) {
      throw new Error(`Chat ${id} not found`);
    }

    const participants = this.getParticipants(row.ROWID);

    return new Chat(
      this.db,
      this.backupId,
      this.backupPath,
      row.ROWID,
      row.display_name || 'Unknown',
      row.chat_identifier || null,
      participants,
      Number(row.message_count) || 0
    );
  }
}

class Reaction implements ReactionT {
  public id: string;
  public messageId: string;
  public actor: string;
  public emoji: string;
  public createdAt: Date;

  constructor(id: string, messageId: string, actor: string, emoji: string, createdAt: Date) {
    this.id = id;
    this.messageId = messageId;
    this.actor = actor;
    this.emoji = emoji;
    this.createdAt = createdAt;
  }
}

class Messages {
  constructor(
    private db: Database, 
    private backupId: string, 
    private chatId?: number
  ) {}

  private static readonly legacyReactionCodeMap: Record<number, string> = {
    2000: '❤️',
    2001: '👍',
    2002: '👎',
    2003: '😂',
    2004: '‼️',
    2005: '❓'
  };

  private readonly appleEpochMs = Date.UTC(2001, 0, 1);

  private normalizeAppleDate(raw: unknown): Date | null {
    if (raw === null || raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;

    // iOS backups often store message times as Apple epoch nanoseconds.
    const secondsFromAppleEpoch = value > 1e12 ? value / 1e9 : value;
    return new Date(this.appleEpochMs + secondsFromAppleEpoch * 1000);
  }

  private extractBaseGuid(associatedGuid: unknown): string | null {
    if (typeof associatedGuid !== 'string' || associatedGuid.length === 0) return null;

    const guidParts = associatedGuid.split('/').map((part) => part.trim()).filter(Boolean);
    const guidLikePart = guidParts.find((part) => /^[0-9A-Fa-f-]{8,}$/.test(part));
    if (guidLikePart) return guidLikePart;

    return guidParts[0] ?? null;
  }

  private normalizeReactionTarget(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  private mapReactionCodeToEmoji(code: unknown): string | null {
    const numericCode = Number(code);
    if (!Number.isFinite(numericCode)) return null;

    // 3000-series indicates a removed reaction, so we do not surface it.
    if (numericCode >= 3000 && numericCode < 4000) return null;

    return Messages.legacyReactionCodeMap[numericCode] ?? null;
  }

  private extractEmojiFromReactionText(text: unknown): string | null {
    if (typeof text !== 'string' || text.length === 0) return null;

    const reactedMatch = text.match(/Reacted\s+(.+?)\s+to\b/i);
    if (reactedMatch && reactedMatch[1]) {
      return reactedMatch[1].trim();
    }

    const namedReactionMap: Record<string, string> = {
      loved: '❤️',
      liked: '👍',
      disliked: '👎',
      laughed: '😂',
      emphasized: '‼️',
      questioned: '❓'
    };

    const namedReactionMatch = text.match(/^(Loved|Liked|Disliked|Laughed|Emphasized|Questioned)\b/i);
    if (namedReactionMatch && namedReactionMatch[1]) {
      return namedReactionMap[namedReactionMatch[1].toLowerCase()] ?? null;
    }

    const removedReactionMatch = text.match(/^Removed\s+(.+?)\s+from\b/i);
    if (removedReactionMatch && removedReactionMatch[1]) {
      return removedReactionMatch[1].trim();
    }

    const firstEmojiMatch = text.match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/u);
    return firstEmojiMatch ? firstEmojiMatch[0] : null;
  }

  private buildReactionFromRow(row: any): ReactionT | null {
    if (!(typeof row.associated_message_guid === 'string' && row.associated_message_guid.length > 0)) {
      return null;
    }

    const emojiFromCode = this.mapReactionCodeToEmoji(row.associated_message_type);
    const emojiFromText = this.extractEmojiFromReactionText(row.text);
    const emoji = emojiFromCode ?? emojiFromText;
    if (!emoji) return null;

    const createdAt = this.normalizeAppleDate(row.date) ?? new Date(0);
    const actor = row.sender || (row.is_from_me ? 'me' : 'unknown');

    return new Reaction(String(row.rowid), '', actor, emoji, createdAt);
  }

  private getReactionRowsForScope(): Array<any> {
    const where: string[] = [
      'm.associated_message_guid IS NOT NULL',
      "m.associated_message_guid != ''",
      'COALESCE(m.associated_message_type, 0) > 0'
    ];
    const params: Array<string | number> = [];

    if (this.chatId !== undefined) {
      where.push('cmj.chat_id = ?');
      params.push(this.chatId);
    }

    const stmt = this.db.prepare(`
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
    `);

    return stmt.all(...params) as Array<any>;
  }

  private populateReactions(messages: Array<any>): void {
    if (messages.length === 0) return;

    const reactionTargetToMessageId = new Map<string, string>();
    for (const message of messages) {
      const normalizedId = this.normalizeReactionTarget(message.id);
      if (normalizedId) reactionTargetToMessageId.set(normalizedId, message.id);

      const normalizedGuid = this.normalizeReactionTarget(message.guid);
      if (normalizedGuid) reactionTargetToMessageId.set(normalizedGuid, message.id);
    }

    if (reactionTargetToMessageId.size === 0) {
      for (const message of messages) {
        message.reactions = [];
      }
      return;
    }

    const messageById = new Map(messages.map((message) => [message.id, message]));
    const reactionRows = this.getReactionRowsForScope();

    for (const reactionRow of reactionRows) {
      const target = this.normalizeReactionTarget(this.extractBaseGuid(reactionRow.associated_message_guid));
      if (!target) continue;

      const targetMessageId = reactionTargetToMessageId.get(target);
      if (!targetMessageId) continue;

      const targetMessage = messageById.get(targetMessageId);
      if (!targetMessage) continue;

      const reaction = this.buildReactionFromRow(reactionRow);
      if (!reaction) continue;

      targetMessage.reactions.push(
        new Reaction(reaction.id, targetMessage.id, reaction.actor, reaction.emoji, reaction.createdAt)
      );
    }
  }

  private getReactionsForMessage(messageId: string, messageGuid: string | undefined): ReactionT[] {
    const message = {
      id: messageId,
      guid: messageGuid,
      reactions: [] as ReactionT[]
    };

    this.populateReactions([message]);
    console.log(`Found ${message.reactions.length} reaction(s) for message ${messageId}`);
    return message.reactions;
  }

  list(options: MessageListOptionsT = DEFAULT_MESSAGE_LIST_OPTIONS) {
    const normalizedOptions = {
      ...DEFAULT_MESSAGE_LIST_OPTIONS,
      ...options
    };

    const where: string[] = ['COALESCE(m.associated_message_type, 0) <= 0'];
    const params: Array<string | number> = [];

    if (this.chatId !== undefined) {
      where.push('cmj.chat_id = ?');
      params.push(this.chatId);
    }

    if (typeof normalizedOptions.hasAttachment === 'boolean') {
      where.push(
        normalizedOptions.hasAttachment
          ? '(SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) > 0'
          : '(SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) = 0'
      );
    }

    if (typeof normalizedOptions.minAttachments === 'number') {
      where.push('(SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) >= ?');
      params.push(normalizedOptions.minAttachments);
    }

    if (typeof normalizedOptions.maxAttachments === 'number') {
      where.push('(SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID) <= ?');
      params.push(normalizedOptions.maxAttachments);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const stmt = this.db.prepare(`
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
    `);

    const rows = stmt.all(...params) as Array<any>;

    const matchesDateFilter = (sentAt: Date | null): boolean => {
      if (!sentAt) return !(normalizedOptions.fromDate || normalizedOptions.toDate);

      if (normalizedOptions.fromDate instanceof Date && sentAt < normalizedOptions.fromDate) return false;
      if (normalizedOptions.toDate instanceof Date && sentAt > normalizedOptions.toDate) return false;
      return true;
    };

    const messages = rows.map((row: any) => {
      const sentAt = this.normalizeAppleDate(row.date);
      const deliveredAt = this.normalizeAppleDate(row.date_delivered);
      const readAt = this.normalizeAppleDate(row.date_read);

      const attachmentIds = typeof row.attachment_ids === 'string' && row.attachment_ids.length > 0
        ? row.attachment_ids.split(',').map((id: string) => id.trim())
        : [];

      const service = row.service === 'iMessage' || row.service === 'SMS' || row.service === 'MMS'
        ? row.service
        : 'Unknown';

      const message: any = {
        id: String(row.rowid),
        guid: row.guid || undefined,
        chatId: String(this.chatId ?? row.chat_id ?? ''),
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
        hasAttachments: Number(row.attachment_count) > 0,
        reactions: [] as ReactionT[],
        attachmentIds
      };

      return message;
    });

    this.populateReactions(messages);

    return messages
      .filter((message: any) => matchesDateFilter(message.sentAt))
      .map((message: any) => message);
  }
  
  get(id: string) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) return null as any;

    const where: string[] = ['m.ROWID = ?', 'COALESCE(m.associated_message_type, 0) <= 0'];
    const params: Array<string | number> = [numericId];

    if (this.chatId !== undefined) {
      where.push('cmj.chat_id = ?');
      params.push(this.chatId);
    }

    const stmt = this.db.prepare(`
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
    `);

    const row = stmt.get(...params) as any;
    if (!row) return null as any;

    const attachmentIds = typeof row.attachment_ids === 'string' && row.attachment_ids.length > 0
      ? row.attachment_ids.split(',').map((attachmentId: string) => attachmentId.trim())
      : [];

    const service = row.service === 'iMessage' || row.service === 'SMS' || row.service === 'MMS'
      ? row.service
      : 'Unknown';

      const reactions = this.getReactionsForMessage(String(row.rowid), row.guid || undefined)

    return {
      id: String(row.rowid),
      guid: row.guid || undefined,
      chatId: String(this.chatId ?? row.chat_id ?? ''),
      sender: row.sender || null,
      isFromMe: Boolean(row.is_from_me),
      text: row.text || null,
      subject: row.subject || null,
      service,
      sentAt: this.normalizeAppleDate(row.date),
      deliveredAt: this.normalizeAppleDate(row.date_delivered),
      readAt: this.normalizeAppleDate(row.date_read),
      isSystem: row.item_type !== 0,
      isTapback: false,
      hasAttachments: Number(row.attachment_count) > 0,
      reactions,
      attachmentIds
    } as any;
  }
}

class Attachments {
  private manifestAttachmentPathByRelativePath: Map<string, string> | null = null;
  private readonly appleEpochMs = Date.UTC(2001, 0, 1);

  constructor(
    private db: Database,
    private backupId: string,
    private backupPath: string,
    private chatId?: number,
    private messageId?: number
  ) {}

  private normalizeAppleDate(raw: unknown): Date | null {
    if (raw === null || raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;

    const secondsFromAppleEpoch = value > 1e12 ? value / 1e9 : value;
    return new Date(this.appleEpochMs + secondsFromAppleEpoch * 1000);
  }

  private toRelativeAttachmentPath(filename: unknown): string | null {
    if (typeof filename !== 'string' || filename.length === 0) return null;

    const normalized = filename.replaceAll('\\', '/').trim();
    if (normalized.length === 0) return null;

    const markerIndex = normalized.indexOf(`${ATTACHMENTS_PATH}/`);
    if (markerIndex >= 0) {
      return normalized.slice(markerIndex);
    }

    if (normalized.startsWith('~/')) {
      return normalized.slice(2);
    }

    return null;
  }

  private ensureAttachmentPathIndex(): Map<string, string> {
    if (this.manifestAttachmentPathByRelativePath) {
      return this.manifestAttachmentPathByRelativePath;
    }

    const manifestDb = getManifestDb(this.backupPath);
    const rows = getAttachmentManifestRows(manifestDb);
    manifestDb.close();

    const pathByRelativePath = new Map<string, string>();

    for (const row of rows) {
      const subdirectory = row.fileID.slice(0, 2);
      const primaryPath = path.join(this.backupPath, subdirectory, row.fileID);
      const fallbackPath = path.join(this.backupPath, row.fileID);
      const resolvedPath = fs.existsSync(primaryPath) ? primaryPath : fallbackPath;

      pathByRelativePath.set(row.relativePath, resolvedPath);
    }

    this.manifestAttachmentPathByRelativePath = pathByRelativePath;
    return pathByRelativePath;
  }

  private resolveAttachmentDataPath(filename: unknown): string {
    const relativePath = this.toRelativeAttachmentPath(filename);
    if (!relativePath) return '';

    const pathByRelativePath = this.ensureAttachmentPathIndex();
    const resolvedPath = pathByRelativePath.get(relativePath);
    return resolvedPath || '';
  }

  private toAttachmentType(mimeType: string): string {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'other';
  }

  private getFileExtension(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    return ext.startsWith('.') ? ext.slice(1) : ext;
  }

  private matchesTypeAndExtensionFilters(attachment: AttachmentT, options: any): boolean {
    if (typeof options.type === 'string' && options.type.length > 0) {
      if (this.toAttachmentType(attachment.mimeType).toLowerCase() !== options.type.toLowerCase()) {
        return false;
      }
    }

    if (options.extension !== undefined) {
      const extensionFilter = Array.isArray(options.extension)
        ? options.extension.map((value: unknown) => String(value).toLowerCase().replace(/^\./, ''))
        : [String(options.extension).toLowerCase().replace(/^\./, '')];

      const extension = this.getFileExtension(attachment.transferName || attachment.filename);
      if (!extensionFilter.includes(extension)) return false;
    }

    return true;
  }

  private matchesDateFilters(createdAt: Date, options: any): boolean {
    if (options.fromDate instanceof Date && createdAt < options.fromDate) return false;
    if (options.toDate instanceof Date && createdAt > options.toDate) return false;
    return true;
  }

  private buildAttachmentFromRow(row: any): AttachmentT {
    const filename = typeof row.filename === 'string' ? row.filename : '';
    const transferName = typeof row.transfer_name === 'string' && row.transfer_name.length > 0
      ? row.transfer_name
      : path.basename(filename || `attachment-${row.rowid}`);

    const mimeType = typeof row.mime_type === 'string' ? row.mime_type : '';
    const size = Number(row.total_bytes) || 0;
    const createdAt = this.normalizeAppleDate(row.message_date) ?? new Date(0);
    const dataPath = this.resolveAttachmentDataPath(row.filename);

    return {
      id: String(row.rowid),
      filename,
      transferName,
      mimeType,
      size,
      createdAt,
      dataPath,
      backupId: this.backupId,
      path: dataPath,
      chatId: row.chat_id !== null && row.chat_id !== undefined ? String(row.chat_id) : undefined,
      messageId: row.message_id !== null && row.message_id !== undefined ? String(row.message_id) : undefined
    };
  }

  list(options: AttachmentListOptionsT = DEFAULT_ATTACHMENT_LIST_OPTIONS) {
    const normalizedOptions = {
      ...DEFAULT_ATTACHMENT_LIST_OPTIONS,
      ...options
    };

    const where: string[] = [];
    const params: Array<string | number> = [];

    if (this.chatId !== undefined) {
      where.push('cmj.chat_id = ?');
      params.push(this.chatId);
    }

    if (this.messageId !== undefined) {
      where.push('maj.message_id = ?');
      params.push(this.messageId);
    }

    if (typeof normalizedOptions.minSize === 'number') {
      where.push('COALESCE(a.total_bytes, 0) >= ?');
      params.push(normalizedOptions.minSize);
    }

    if (typeof normalizedOptions.maxSize === 'number') {
      where.push('COALESCE(a.total_bytes, 0) <= ?');
      params.push(normalizedOptions.maxSize);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const stmt = this.db.prepare(`
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
    `);

    const rows = stmt.all(...params) as Array<any>;
    const uniqueRowsById = new Map<string, any>();

    for (const row of rows) {
      const key = String(row.rowid);
      if (!uniqueRowsById.has(key)) {
        uniqueRowsById.set(key, row);
      }
    }

    const attachments = Array.from(uniqueRowsById.values())
      .map((row) => this.buildAttachmentFromRow(row))
      .filter((attachment) => this.matchesTypeAndExtensionFilters(attachment, normalizedOptions))
      .filter((attachment) => this.matchesDateFilters(attachment.createdAt, normalizedOptions));

    const offset = Number.isInteger(normalizedOptions.offset) && normalizedOptions.offset >= 0
      ? normalizedOptions.offset
      : DEFAULT_ATTACHMENT_LIST_OPTIONS.offset;

    const limit = Number.isInteger(normalizedOptions.limit) && normalizedOptions.limit > 0
      ? normalizedOptions.limit
      : undefined;

    if (limit === undefined) {
      return attachments.slice(offset);
    }

    return attachments.slice(offset, offset + limit);
  }

  get(id: string) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId <= 0) return null as any;

    const where: string[] = ['a.ROWID = ?'];
    const params: Array<string | number> = [numericId];

    if (this.chatId !== undefined) {
      where.push('cmj.chat_id = ?');
      params.push(this.chatId);
    }

    if (this.messageId !== undefined) {
      where.push('maj.message_id = ?');
      params.push(this.messageId);
    }

    const stmt = this.db.prepare(`
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
    `);

    const row = stmt.get(...params) as any;
    if (!row) return null as any;

    return this.buildAttachmentFromRow(row) as any;
  }

  createReadStream(id: string) {
    const attachment = this.get(id) as AttachmentT | null;
    if (!attachment || !attachment.dataPath) {
      throw new Error(`Attachment ${id} not found`);
    }

    return fs.createReadStream(attachment.dataPath) as any;
  }

  async saveToFile(id: string, destPath: string) {
    const attachment = this.get(id) as AttachmentT | null;
    if (!attachment || !attachment.dataPath) {
      throw new Error(`Attachment ${id} not found`);
    }

    await fs.promises.copyFile(attachment.dataPath, destPath);
  }
}

export class Backup {
  public id: string;
  public path: string;
  public deviceName: string = 'Unknown';
  public iosVersion: string = 'Unknown';
  public sizeOnDisk: number = 0;
  
  private smsDb: Database;

  public chats: Chats;
  public messages: Messages;
  public attachments: Attachments;

  constructor(backupPath: string) {
    this.path = backupPath;
    this.id = path.basename(backupPath);
    const smsDbPath = findSmsDbPath(backupPath);

    this.parseMetadata();

    if (!fs.existsSync(smsDbPath)) {
      throw new Error(`sms.db not found for backup ${this.id}`);
    }

    // Open connection to the iMessage SQLite database
    this.smsDb = new Database(smsDbPath, { readonly: true });

    // Initialize scoped accessors
    this.chats = new Chats(this.smsDb, this.id, this.path);
    this.messages = new Messages(this.smsDb, this.id);
    this.attachments = new Attachments(this.smsDb, this.id, this.path);
  }

  private parseMetadata() {
    const infoPlistPath = path.join(this.path, 'Info.plist');
    if (fs.existsSync(infoPlistPath)) {
      try {
        const info: any = plist.parse(fs.readFileSync(infoPlistPath, 'utf8'));
        this.deviceName = info['Device Name'] || 'Unknown';
        this.iosVersion = info['Product Version'] || 'Unknown';
      } catch (e) {
        console.warn(`Could not parse Info.plist for ${this.id}`);
      }
    }
  }
}

class Backups {
  list(): Backup[] {
    const backupDirs = getWindowsBackupPaths();
    const backups: Backup[] = [];

    for (const dir of backupDirs) {
      const folders = fs.readdirSync(dir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => path.join(dir, dirent.name));

      for (const folder of folders) {
        // A valid backup usually has an Info.plist and Manifest.db
        if (fs.existsSync(path.join(folder, 'Info.plist'))) {
          // console.log('creating backup: ', folder);
          backups.push(new Backup(folder));
        }
      }
    }
    
    return backups;
  }

  get(id: string): Backup {
    const backup = this.list().find(b => b.id === id);
    if (!backup) throw new Error(`Backup ${id} not found`);
    return backup;
  }
}

class Intunes {
  public backups = new Backups();
}

// Export the singleton instance
export const intunes = new Intunes();