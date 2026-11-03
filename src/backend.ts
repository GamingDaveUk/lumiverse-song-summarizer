declare const spindle: import('lumiverse-spindle-types').SpindleAPI

interface SummarizerSettings {
  connectionId: string // "" means use active profile via spindle.generate.quiet
  contextCount: number // How many preceding messages to include as context
  autoSongAfterMessages: number // Default 5
  autoSongEnabled: boolean
}

const defaultSettings: SummarizerSettings = {
  connectionId: '',
  contextCount: 5,
  autoSongAfterMessages: 5,
  autoSongEnabled: false,
}

// Marker placed inside summarized <song> tags so the loop never re-summarizes them
const SUMMARY_MARKER = '[Song Summary:'
const SONG_REGEX = /<song>([\s\S]*?)<\/song>/gi

let currentSettings: SummarizerSettings = { ...defaultSettings }
let activeChatId: string | null = null

/**
 * Helper to call the LLM using either a specific connection profile or the active one,
 * with extended thinking turned off for fast, cheap summarization.
 */
async function runGeneration(
  systemPrompt: string,
  userPrompt: string,
  connectionId?: string
): Promise<string> {
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userPrompt },
  ]

  const targetConn = connectionId ?? currentSettings.connectionId

  if (targetConn && targetConn.trim() !== '') {
    const res = await spindle.generate.raw({
      messages,
      connection_id: targetConn,
      parameters: { temperature: 0.3, max_tokens: 400 },
      reasoning: { source: 'off' },
    })
    return (res.content ?? '').trim()
  } else {
    const res = await spindle.generate.quiet({
      messages,
      parameters: { temperature: 0.3, max_tokens: 400 },
      reasoning: { source: 'off' },
    })
    return (res.content ?? '').trim()
  }
}

/**
 * Adapter for updating a stored message via spindle.chat (chat_mutation permission).
 * Handles signature variations across Spindle host versions safely.
 */
async function updateStoredMessage(chatId: string, messageId: string, newContent: string) {
  const chatApi = spindle.chat as any

  if (typeof chatApi.updateMessage === 'function') {
    // Try (chatId, messageId, { content }) or (chatId, messageId, newContent)
    try {
      await chatApi.updateMessage(chatId, messageId, { content: newContent })
      return
    } catch {
      await chatApi.updateMessage(chatId, messageId, newContent)
      return
    }
  }

  if (typeof chatApi.editMessage === 'function') {
    await chatApi.editMessage(chatId, messageId, newContent)
    return
  }

  if (typeof chatApi.update === 'function') {
    await chatApi.update(chatId, messageId, { content: newContent })
    return
  }

  throw new Error('Could not find message update method on spindle.chat. Check chat_mutation permission.')
}

/**
 * Builds a formatted transcript of the preceding N messages for context.
 */
function buildContextBlock(messages: any[], targetIndex: number, count: number): string {
  const start = Math.max(0, targetIndex - count)
  const slice = messages.slice(start, targetIndex)
  if (slice.length === 0) return '(No prior messages)'

  return slice
    .map((m: any) => `[${m.name || m.role}]: ${m.content}`)
    .join('\n\n')
}

/**
 * Summarizes either <song>...</song> tags inside a message or the entire message.
 * mode: 'auto_detect' | 'song_only' | 'full_message'
 */
async function summarizeMessageById(
  chatId: string,
  messageId: string,
  mode: 'auto_detect' | 'song_only' | 'full_message',
  connectionId?: string,
  userId?: string
): Promise<{ updated: boolean; summary?: string; reason?: string }> {
  if (!spindle.permissions.has('generation') || !spindle.permissions.has('chat_mutation')) {
    spindle.toast.warning('Enable "generation" and "chat_mutation" permissions for Song & Message Summarizer.')
    return { updated: false, reason: 'Missing permissions' }
  }

  const messages: any[] = await spindle.chat.getMessages(chatId)
  const targetIndex = messages.findIndex((m: any) => String(m.id) === String(messageId))

  if (targetIndex === -1) {
    return { updated: false, reason: 'Message not found in chat' }
  }

  const targetMsg = messages[targetIndex]
  const rawContent: string = targetMsg.content ?? ''
  const contextText = buildContextBlock(messages, targetIndex, currentSettings.contextCount)

  const hasSongTags = /<song>[\s\S]*?<\/song>/i.test(rawContent)
  const effectiveMode =
    mode === 'auto_detect' ? (hasSongTags ? 'song_only' : 'full_message') : mode

  if (effectiveMode === 'song_only') {
    if (!hasSongTags) {
      return { updated: false, reason: 'No <song>...</song> tags found in message' }
    }

    let anyReplaced = false
    let updatedContent = rawContent

    const matches = Array.from(rawContent.matchAll(SONG_REGEX))
    for (const match of matches) {
      const fullMatch = match[0]
      const innerSong = (match[1] ?? '').trim()

      // Skip if already summarized
      if (!innerSong || innerSong.includes(SUMMARY_MARKER)) {
        continue
      }

      const systemPrompt =
        'You are a concise narrative summarizer for a roleplay chat. Summarize the song lyrics, theme, emotional tone, and any narrative progression taking place during the song in 2 to 3 sentences. Output ONLY the summary text.'
      const userPrompt = `### Recent Conversation Context:\n${contextText}\n\n### Full Message Context:\n${rawContent}\n\n### Song Content to Summarize:\n${innerSong}`

      const summary = await runGeneration(systemPrompt, userPrompt, connectionId)
      if (summary) {
        const replacement = `<song>${SUMMARY_MARKER} ${summary}]</song>`
        updatedContent = updatedContent.replace(fullMatch, replacement)
        anyReplaced = true
      }
    }

    if (!anyReplaced) {
      return { updated: false, reason: 'Song tags were already summarized' }
    }

    await updateStoredMessage(chatId, messageId, updatedContent)
    spindle.sendToFrontend(
      { type: 'message_summarized', chatId, messageId, content: updatedContent },
      userId
    )
    return { updated: true, summary: updatedContent }
  }

  // Otherwise: Summarize the entire message (and if it contains <song> tags, note them in the summary)
  const systemPrompt =
    'You are a concise narrative summarizer for a roleplay chat. Using the preceding messages solely as context to understand references, summarize what happens in the Target Message clearly and concisely in 1 short paragraph. If the Target Message includes a <song>, include a brief summary of the song performance as well. Output ONLY the summary.'
  const userPrompt = `### Preceding Context (Do not summarize this):\n${contextText}\n\n### Target Message to Summarize:\n${rawContent}`

  const summary = await runGeneration(systemPrompt, userPrompt, connectionId)
  if (!summary) {
    return { updated: false, reason: 'Empty summary returned by LLM' }
  }

  const newContent = `[Message Summary: ${summary}]`
  await updateStoredMessage(chatId, messageId, newContent)
  spindle.sendToFrontend(
    { type: 'message_summarized', chatId, messageId, content: newContent },
    userId
  )
  return { updated: true, summary: newContent }
}

/**
 * Scans messages in the chat that are at least N messages old (default 5)
 * and summarizes any un-summarized <song>...</song> blocks.
 */
async function scanPastSongs(chatId: string, userId?: string) {
  const messages: any[] = await spindle.chat.getMessages(chatId)
  const lookback = Math.max(1, currentSettings.autoSongAfterMessages || 5)

  if (messages.length <= lookback) return

  // Eligible messages are everything before the most recent `lookback` messages
  const cutoffIndex = messages.length - lookback
  for (let i = 0; i < cutoffIndex; i++) {
    const msg = messages[i]
    const content: string = msg?.content ?? ''
    if (/<song>[\s\S]*?<\/song>/i.test(content) && !content.includes(SUMMARY_MARKER)) {
      spindle.log.info(`Auto-summarizing <song> in message ${msg.id} (index ${i}/${messages.length})`)
      await summarizeMessageById(chatId, msg.id, 'song_only', currentSettings.connectionId, userId)
    }
  }
}

// Track active chat changes
spindle.on('CHAT_CHANGED', (payload: any) => {
  if (payload?.chatId) {
    activeChatId = payload.chatId
  }
})

// Automatic check after each LLM generation finishes
spindle.on('GENERATION_ENDED', async (payload: any, userId?: string) => {
  const chatId = payload?.chatId || activeChatId
  if (!chatId) return
  activeChatId = chatId

  if (currentSettings.autoSongEnabled) {
    try {
      await scanPastSongs(chatId, userId)
    } catch (err: any) {
      spindle.log.error(`Auto song summary failed: ${err.message}`)
    }
  }
})

// Handle messages from the Frontend UI
spindle.onFrontendMessage(async (payload: any, userId?: string) => {
  try {
    if (payload.type === 'update_settings') {
      currentSettings = { ...currentSettings, ...payload.settings }
      spindle.toast.success('Summarizer settings updated.')
      return
    }

    if (payload.type === 'summarize_message') {
      const chatId = payload.chatId || activeChatId
      if (!chatId) {
        spindle.toast.warning('No active chat detected yet — send or switch to a chat first.')
        return
      }

      spindle.toast.info('Summarizing with selected connection...')
      const res = await summarizeMessageById(
        chatId,
        payload.messageId,
        payload.mode || 'auto_detect',
        payload.connectionId ?? currentSettings.connectionId,
        userId
      )

      if (res.updated) {
        spindle.toast.success('Summary applied!')
      } else {
        spindle.toast.info(res.reason || 'Nothing to summarize.')
      }
      return
    }

    if (payload.type === 'scan_all_past_songs') {
      const chatId = payload.chatId || activeChatId
      if (!chatId) {
        spindle.toast.warning('No active chat detected.')
        return
      }
      spindle.toast.info(`Scanning messages older than ${currentSettings.autoSongAfterMessages} turns for <song> tags...`)
      await scanPastSongs(chatId, userId)
      spindle.toast.success('Song scan complete!')
    }
  } catch (err: any) {
    spindle.log.error(`Summarizer error: ${err.message}`)
    spindle.toast.error(`Summarizer failed: ${err.message}`)
  }
})

spindle.log.info('Song & Message Summarizer backend loaded!')