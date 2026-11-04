declare const spindle: import('lumiverse-spindle-types').SpindleAPI

interface SummarizerSettings {
  connectionId: string
  contextCount: number
  maxTokens: number
  autoSongAfterMessages: number
  autoSongEnabled: boolean
  songSystemPrompt: string
  messageSystemPrompt: string
}

const DEFAULT_SONG_PROMPT =
'You are a narrative summarizer for a roleplay chat. Summarize the song lyrics, theme, emotional tone, and any narrative progression taking place during the song. Aim for roughly 2 to 5 sentences (scaling naturally with the length and complexity of the song) and always finish your thoughts completely. Output ONLY the summary text.'

const DEFAULT_MESSAGE_PROMPT =
'You are a narrative summarizer for a roleplay chat. Using the preceding messages solely as context to understand references, summarize all key events, dialogue, and character actions in the Target Message. Aim for 1 to 2 concise paragraphs (scaling naturally with the length of the message so no important plot points are dropped) and always finish every sentence completely. If the Target Message includes a <song>, include a brief summary of the song performance as well. Output ONLY the summary.'

const defaultSettings: SummarizerSettings = {
  connectionId: '',
  contextCount: 5,
  maxTokens: 4096,
  autoSongAfterMessages: 5,
  autoSongEnabled: false,
  songSystemPrompt: DEFAULT_SONG_PROMPT,
  messageSystemPrompt: DEFAULT_MESSAGE_PROMPT,
}

const SUMMARY_MARKER = '[Song Summary:'
const SONG_REGEX = /<song>([\s\S]*?)<\/song>/gi

let currentSettings: SummarizerSettings = { ...defaultSettings }
const activeChatByUser = new Map<string, string>()

function notify(
  level: 'info' | 'success' | 'warning' | 'error',
  msg: string,
  userId?: string
) {
  try {
    const t = spindle.toast as any
    if (userId) {
      t[level](msg, userId)
    } else {
      t[level](msg)
    }
  } catch {
    spindle.log.info(`[Toast ${level}] ${msg}`)
  }
}

async function resolveChatId(
  explicitChatId?: string | null,
  messageId?: string | null,
  userId?: string
): Promise<string | null> {
  if (explicitChatId) {
    if (userId) activeChatByUser.set(userId, explicitChatId)
      return explicitChatId
  }

  if (userId && activeChatByUser.has(userId)) {
    return activeChatByUser.get(userId)!
  }

  const chatsApi = (spindle as any).chats
  const chatMutationApi = (spindle as any).chat

  for (const api of [chatsApi, chatMutationApi]) {
    if (!api) continue
      for (const fnName of ['getActive', 'getActiveChat', 'getActiveChatId', 'getCurrent']) {
        if (typeof api[fnName] === 'function') {
          try {
            const res = userId ? await api[fnName](userId) : await api[fnName]()
            const id = typeof res === 'string' ? res : res?.id || res?.chatId
            if (id) {
              if (userId) activeChatByUser.set(userId, id)
                return id
            }
          } catch {
            try {
              const res = await api[fnName]({ userId })
              const id = typeof res === 'string' ? res : res?.id || res?.chatId
              if (id) {
                if (userId) activeChatByUser.set(userId, id)
                  return id
              }
            } catch {}
          }
        }
      }
  }

  if (chatsApi && typeof chatsApi.list === 'function') {
    try {
      const listRes = userId ? await chatsApi.list(userId) : await chatsApi.list()
      const chatList: any[] = Array.isArray(listRes) ? listRes : listRes?.chats || listRes?.items || []

      if (messageId) {
        for (const c of chatList.slice(0, 15)) {
          const cid = c.id || c.chatId
          if (!cid) continue
            try {
              const msgs = await getChatMessages(cid, userId)
              if (msgs.some((m: any) => String(m.id) === String(messageId))) {
                if (userId) activeChatByUser.set(userId, cid)
                  return cid
              }
            } catch {}
        }
      }

      if (chatList.length > 0) {
        const firstId = chatList[0].id || chatList[0].chatId
        if (firstId) {
          if (userId) activeChatByUser.set(userId, firstId)
            return firstId
        }
      }
    } catch {}
  }

  return null
}

async function getChatMessages(chatId: string, userId?: string): Promise<any[]> {
  const chatApi = spindle.chat as any
  if (userId) {
    try {
      return await chatApi.getMessages(chatId, userId)
    } catch {
      try {
        return await chatApi.getMessages({ chatId, userId })
      } catch {}
    }
  }
  return await chatApi.getMessages(chatId)
}

async function updateStoredMessage(
  chatId: string,
  messageId: string,
  newContent: string,
  userId?: string
) {
  const chatApi = spindle.chat as any

  const attempts: Array<() => Promise<any>> = [
    () => chatApi.updateMessage(chatId, messageId, { content: newContent }, userId),
    () => chatApi.updateMessage(chatId, messageId, newContent, userId),
    () => chatApi.updateMessage({ chatId, messageId, content: newContent, userId }),
    () => chatApi.editMessage(chatId, messageId, newContent, userId),
    () => chatApi.updateMessage(chatId, messageId, { content: newContent }),
    () => chatApi.updateMessage(chatId, messageId, newContent),
  ]

  let lastErr: any = null
  for (const attempt of attempts) {
    try {
      await attempt()
      return
    } catch (err: any) {
      lastErr = err
    }
  }

  throw lastErr || new Error('Failed to update message via spindle.chat')
}

async function runGeneration(
  systemPrompt: string,
  userPrompt: string,
  connectionId?: string,
  userId?: string
): Promise<string> {
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userPrompt },
  ]

  const targetConn = connectionId ?? currentSettings.connectionId
  const genApi = spindle.generate as any

  // If maxTokens > 0, pass it; if 0, let the provider use its own default ceiling
  const parameters: Record<string, any> = { temperature: 0.3 }
  if (currentSettings.maxTokens && currentSettings.maxTokens > 0) {
    parameters.max_tokens = currentSettings.maxTokens
  }

  if (targetConn && targetConn.trim() !== '') {
    const req: any = {
      messages,
      connection_id: targetConn,
      parameters,
      reasoning: { source: 'off' },
      ...(userId ? { userId, user_id: userId } : {}),
    }
    try {
      const res = userId ? await genApi.raw(req, userId) : await genApi.raw(req)
      return (res.content ?? '').trim()
    } catch {
      const res = await genApi.raw(req)
      return (res.content ?? '').trim()
    }
  } else {
    const req: any = {
      messages,
      parameters,
      reasoning: { source: 'off' },
      ...(userId ? { userId, user_id: userId } : {}),
    }
    try {
      const res = userId ? await genApi.quiet(req, userId) : await genApi.quiet(req)
      return (res.content ?? '').trim()
    } catch {
      const res = await genApi.quiet(req)
      return (res.content ?? '').trim()
    }
  }
}

function buildContextBlock(messages: any[], targetIndex: number, count: number): string {
  const start = Math.max(0, targetIndex - count)
  const slice = messages.slice(start, targetIndex)
  if (slice.length === 0) return '(No prior messages)'

    return slice
    .map((m: any) => `[${m.name || m.role}]: ${m.content}`)
    .join('\n\n')
}

async function summarizeMessageById(
  chatId: string,
  messageId: string,
  mode: 'auto_detect' | 'song_only' | 'full_message',
  connectionId?: string,
  userId?: string
): Promise<{ updated: boolean; summary?: string; reason?: string }> {
  const messages: any[] = await getChatMessages(chatId, userId)
  const targetIndex = messages.findIndex((m: any) => String(m.id) === String(messageId))

  if (targetIndex === -1) {
    return { updated: false, reason: 'Message not found in active chat' }
  }

  const targetMsg = messages[targetIndex]
  const rawContent: string = targetMsg.content ?? ''
  const contextText = buildContextBlock(messages, targetIndex, currentSettings.contextCount)

  const hasSongTags = /<song>[\s\S]*?<\/song>/i.test(rawContent)
  const effectiveMode =
  mode === 'auto_detect' ? (hasSongTags ? 'song_only' : 'full_message') : mode

  if (effectiveMode === 'song_only') {
    if (!hasSongTags) {
      return { updated: false, reason: 'No <song>...</song> tags found in this message' }
    }

    let anyReplaced = false
    let updatedContent = rawContent

    const matches = Array.from(rawContent.matchAll(SONG_REGEX))
    for (const match of matches) {
      const fullMatch = match[0]
      const innerSong = (match[1] ?? '').trim()

      if (!innerSong || innerSong.includes(SUMMARY_MARKER)) {
        continue
      }

      const systemPrompt = currentSettings.songSystemPrompt || DEFAULT_SONG_PROMPT
      const userPrompt = `### Recent Conversation Context:\n${contextText}\n\n### Full Message Context:\n${rawContent}\n\n### Song Content to Summarize:\n${innerSong}`

      const summary = await runGeneration(systemPrompt, userPrompt, connectionId, userId)
      if (summary) {
        const replacement = `<song>${SUMMARY_MARKER} ${summary}]</song>`
        updatedContent = updatedContent.replace(fullMatch, replacement)
        anyReplaced = true
      }
    }

    if (!anyReplaced) {
      return { updated: false, reason: 'Song tags in this message are already summarized' }
    }

    await updateStoredMessage(chatId, messageId, updatedContent, userId)
    spindle.sendToFrontend(
      { type: 'message_summarized', chatId, messageId, content: updatedContent },
      userId
    )
    return { updated: true, summary: updatedContent }
  }

  const systemPrompt = currentSettings.messageSystemPrompt || DEFAULT_MESSAGE_PROMPT
  const userPrompt = `### Preceding Context (Do not summarize this):\n${contextText}\n\n### Target Message to Summarize:\n${rawContent}`

  const summary = await runGeneration(systemPrompt, userPrompt, connectionId, userId)
  if (!summary) {
    return { updated: false, reason: 'Empty summary returned by LLM' }
  }

  const newContent = `[Message Summary: ${summary}]`
  await updateStoredMessage(chatId, messageId, newContent, userId)
  spindle.sendToFrontend(
    { type: 'message_summarized', chatId, messageId, content: newContent },
    userId
  )
  return { updated: true, summary: newContent }
}

async function scanPastSongs(chatId: string, userId?: string) {
  const messages: any[] = await getChatMessages(chatId, userId)
  const lookback = Math.max(1, currentSettings.autoSongAfterMessages || 5)

  if (messages.length <= lookback) return

    const cutoffIndex = messages.length - lookback
    for (let i = 0; i < cutoffIndex; i++) {
      const msg = messages[i]
      const content: string = msg?.content ?? ''
      if (/<song>[\s\S]*?<\/song>/i.test(content) && !content.includes(SUMMARY_MARKER)) {
        spindle.log.info(`Auto-summarizing <song> in message ${msg.id}`)
        await summarizeMessageById(
          chatId,
          msg.id,
          'song_only',
          currentSettings.connectionId,
          userId
        )
      }
    }
}

spindle.on('CHAT_CHANGED', (payload: any, userId?: string) => {
  const cid = payload?.chatId || payload?.id
  const uid = userId || payload?.userId
  if (cid && uid) {
    activeChatByUser.set(uid, cid)
  }
})

spindle.on('GENERATION_ENDED', async (payload: any, userId?: string) => {
  const uid = userId || payload?.userId
  const chatId = await resolveChatId(payload?.chatId, payload?.messageId, uid)
  if (!chatId) return

    if (currentSettings.autoSongEnabled) {
      try {
        await scanPastSongs(chatId, uid)
      } catch (err: any) {
        spindle.log.error(`Auto song summary failed: ${err.message}`)
      }
    }
})

spindle.onFrontendMessage(async (payload: any, userId?: string) => {
  try {
    if (payload.type === 'update_settings') {
      currentSettings = { ...currentSettings, ...payload.settings }
      if (!payload.silent) {
        notify('success', 'Summarizer settings saved.', userId)
      }
      return
    }

    if (payload.type === 'summarize_message') {
      if (payload.settings) {
        currentSettings = { ...currentSettings, ...payload.settings }
      }

      const chatId = await resolveChatId(payload.chatId, payload.messageId, userId)
      if (!chatId) {
        notify('warning', 'Could not resolve active chat.', userId)
        return
      }

      notify('info', 'Summarizing with selected connection...', userId)
      const res = await summarizeMessageById(
        chatId,
        payload.messageId,
        payload.mode || 'auto_detect',
        payload.connectionId ?? currentSettings.connectionId,
        userId
      )

      if (res.updated) {
        notify('success', 'Summary applied!', userId)
      } else {
        notify('info', res.reason || 'Nothing to summarize.', userId)
      }
      return
    }

    if (payload.type === 'scan_all_past_songs') {
      if (payload.settings) {
        currentSettings = { ...currentSettings, ...payload.settings }
      }

      const chatId = await resolveChatId(payload.chatId, payload.latestMessageId, userId)
      if (!chatId) {
        notify('warning', 'Could not resolve active chat.', userId)
        return
      }
      notify(
        'info',
        `Scanning messages older than ${currentSettings.autoSongAfterMessages} turns for <song> tags...`,
        userId
      )
      await scanPastSongs(chatId, userId)
      notify('success', 'Song scan complete!', userId)
    }
  } catch (err: any) {
    spindle.log.error(`Summarizer error: ${err.message}`)
    notify('error', `Summarizer failed: ${err.message}`, userId)
  }
})

spindle.log.info('Song & Message Summarizer backend loaded!')
