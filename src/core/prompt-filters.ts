// Steps that clean a prompt before it is shown. Integrations add their own envelopes here
// without the transcript parser knowing about them.
export type PromptFilter = (text: string) => string

/** Strips a leading "[telegram …] " the Telegram channel puts before a message. */
export const telegramEnvelope: PromptFilter = text => text.replace(/^\[telegram[^\]]*\]\s*/i, '')

/** Strips the <channel source="…" …> and </channel> a channel plugin wraps a message in (core/channel-message.ts). */
export const channelEnvelope: PromptFilter = text =>
  text.replace(/<channel\b(?:\s+[\w:-]+="[^"]*")*\s*>\s*|\s*<\/channel>/g, '')

export const DEFAULT_PROMPT_FILTERS: readonly PromptFilter[] = [telegramEnvelope, channelEnvelope]
