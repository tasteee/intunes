import type { ReactionT } from './types'

export const createReaction = (id: string, messageId: string, actor: string, emoji: string, createdAt: Date): ReactionT => {
	return {
		id,
		messageId,
		actor,
		emoji,
		createdAt
	}
}
