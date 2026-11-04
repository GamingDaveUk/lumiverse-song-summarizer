import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

const STORAGE_KEY = 'lumiverse_song_message_summarizer_v1'

const DEFAULT_SONG_PROMPT =
'You are a narrative summarizer for a roleplay chat. Summarize the song lyrics, theme, emotional tone, and any narrative progression taking place during the song. Aim for roughly 2 to 5 sentences (scaling naturally with the length and complexity of the song) and always finish your thoughts completely. Output ONLY the summary text.'

const DEFAULT_MESSAGE_PROMPT =
'You are a narrative summarizer for a roleplay chat. Using the preceding messages solely as context to understand references, summarize all key events, dialogue, and character actions in the Target Message. Aim for 1 to 2 concise paragraphs (scaling naturally with the length of the message so no important plot points are dropped) and always finish every sentence completely. If the Target Message includes a <song>, include a brief summary of the song performance as well. Output ONLY the summary.'

export function setup(ctx: SpindleFrontendContext) {
  let settings = {
    connectionId: '',
    contextCount: 5,
    maxTokens: 4096,
    autoSongAfterMessages: 5,
    autoSongEnabled: false,
    songSystemPrompt: DEFAULT_SONG_PROMPT,
    messageSystemPrompt: DEFAULT_MESSAGE_PROMPT,
  }

  // Load saved settings from localStorage
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) {
      settings = { ...settings, ...JSON.parse(raw) }
    }
  } catch {}

  let currentChatId: string | null = null

  // Clean up any leftover DOM elements from earlier reloads
  for (const stale of Array.from(document.querySelectorAll('.sms-msg-bar'))) {
    const wrapper = stale.parentElement || stale
    try {
      ctx.dom.uninject(wrapper)
    } catch {}
    stale.remove()
  }
  ctx.dom.cleanup()

  const removeStyle = ctx.dom.addStyle(`
  .sms-drawer {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    color: var(--lumiverse-text);
    font-size: 13px;
  }
  .sms-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .sms-field label {
    font-weight: 600;
    color: var(--lumiverse-text-muted);
    font-size: 12px;
  }
  .sms-select, .sms-input, .sms-textarea, .sms-btn {
    padding: 7px 10px;
    border-radius: var(--lumiverse-radius);
    border: 1px solid var(--lumiverse-border);
    background: var(--lumiverse-fill);
    color: var(--lumiverse-text);
    font-size: 13px;
    font-family: inherit;
  }
  .sms-textarea {
    min-height: 90px;
    resize: vertical;
    line-height: 1.4;
    font-size: 12px;
  }
  .sms-btn {
    cursor: pointer;
    background: var(--lumiverse-fill-subtle);
    transition: border-color var(--lumiverse-transition-fast);
    text-align: center;
    font-weight: 500;
  }
  .sms-btn:hover {
    border-color: var(--lumiverse-accent);
  }
  .sms-msg-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    width: 100%;
    flex-basis: 100%;
    order: 999;
    margin-top: 8px;
    padding-top: 4px;
    opacity: 0.75;
    transition: opacity var(--lumiverse-transition-fast);
  }
  .sms-msg-bar:hover {
    opacity: 1;
  }
  .sms-msg-btn {
    padding: 2px 8px;
    font-size: 11px;
    border-radius: var(--lumiverse-radius);
    border: 1px solid var(--lumiverse-border);
    background: var(--lumiverse-fill-subtle);
    color: var(--lumiverse-text-muted);
    cursor: pointer;
  }
  .sms-msg-btn:hover {
    color: var(--lumiverse-text);
    border-color: var(--lumiverse-accent);
  }
  `)

  function detectChatIdFromUrl(): string | null {
    const match = window.location.pathname.match(/\/chats?\/([a-zA-Z0-9_-]+)/i)
    return match ? match[1] : null
  }

  function getActiveChatId(): string | null {
    return currentChatId || detectChatIdFromUrl()
  }

  function saveAndSyncSettings(silent = false) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {}

    ctx.sendToBackend({
      type: 'update_settings',
      settings,
      silent,
    })
  }

  // Push stored settings to backend immediately on startup
  saveAndSyncSettings(true)

  const tab = ctx.ui.registerDrawerTab({
    id: 'song-summarizer',
    title: 'Song & Message Summarizer',
    shortName: 'Summarize',
    description: 'Configure connection profile, prompts, max tokens, and <song> / message summarization',
    keywords: ['song', 'summarize', 'summary', 'lyrics', 'connection', 'prompt'],
    headerTitle: 'Summarizer',
  })

  async function renderDrawer() {
    tab.root.replaceChildren()
    const wrapper = ctx.dom.createElement('div', { class: 'sms-drawer' })

    let profiles: Array<{ id: string; name: string; provider: string; model: string; active?: boolean }> = []
    try {
      if ((ctx.host?.capabilities?.['connection-kinds-v1'] ?? 0) >= 1) {
        profiles = (await (ctx.connections as any).list({ kind: 'llm' })) ?? []
      } else {
        profiles = (await Promise.resolve(ctx.connections.list())) ?? []
      }
    } catch {
      profiles = []
    }

    const connOptions = profiles
    .map(
      (p) =>
      `<option value="${p.id}" ${p.id === settings.connectionId ? 'selected' : ''}>
      ${p.name} (${p.provider} - ${p.model})${p.active ? ' ★' : ''}
      </option>`
    )
    .join('')

    wrapper.innerHTML = `
    <div class="sms-field">
    <label>Connection Profile</label>
    <select class="sms-select" id="sms-conn-select">
    <option value="">Use Active Profile (Default)</option>
    ${connOptions}
    </select>
    </div>

    <div class="sms-field">
    <label>Past Messages for Context</label>
    <input type="number" class="sms-input" id="sms-context-count" min="0" max="50" value="${settings.contextCount}" />
    </div>

    <div class="sms-field">
    <label>Max Summary Tokens (0 = Provider Default / No Limit)</label>
    <input type="number" class="sms-input" id="sms-max-tokens" min="0" max="32000" step="256" value="${settings.maxTokens}" />
    </div>

    <div class="sms-field">
    <label>Full Message Summary System Prompt</label>
    <textarea class="sms-textarea" id="sms-msg-prompt"></textarea>
    </div>

    <div class="sms-field">
    <label>&lt;song&gt; Summary System Prompt</label>
    <textarea class="sms-textarea" id="sms-song-prompt"></textarea>
    </div>

    <button type="button" class="sms-btn" id="sms-reset-prompts">
    ↺ Reset Prompts to Default
    </button>

    <div class="sms-field">
    <label>
    <input type="checkbox" id="sms-auto-toggle" ${settings.autoSongEnabled ? 'checked' : ''} />
    Auto-summarize &lt;song&gt; tags after N messages
    </label>
    </div>

    <div class="sms-field">
    <label>Messages to wait before auto-summarizing &lt;song&gt;</label>
    <input type="number" class="sms-input" id="sms-auto-count" min="1" max="50" value="${settings.autoSongAfterMessages}" />
    </div>

    <button type="button" class="sms-btn" id="sms-scan-now">
    🎵 Scan &amp; Summarize Past &lt;song&gt; Tags Now
    </button>

    <button type="button" class="sms-btn" id="sms-summarize-latest">
    📝 Summarize Latest Message
    </button>

    <div style="font-size: 11px; color: var(--lumiverse-text-dim); line-height: 1.4;">
    <strong>Tip:</strong> Click the buttons at the bottom of any message, or hold <strong>Alt + Right-Click</strong> on any message to open the Summarizer context menu.
    </div>
    `

    tab.root.appendChild(wrapper)

    const connSelect = wrapper.querySelector('#sms-conn-select') as HTMLSelectElement
    const ctxInput = wrapper.querySelector('#sms-context-count') as HTMLInputElement
    const maxTokensInput = wrapper.querySelector('#sms-max-tokens') as HTMLInputElement
    const msgPromptArea = wrapper.querySelector('#sms-msg-prompt') as HTMLTextAreaElement
    const songPromptArea = wrapper.querySelector('#sms-song-prompt') as HTMLTextAreaElement
    const resetPromptsBtn = wrapper.querySelector('#sms-reset-prompts') as HTMLButtonElement
    const autoToggle = wrapper.querySelector('#sms-auto-toggle') as HTMLInputElement
    const autoCountInput = wrapper.querySelector('#sms-auto-count') as HTMLInputElement
    const scanBtn = wrapper.querySelector('#sms-scan-now') as HTMLButtonElement
    const latestBtn = wrapper.querySelector('#sms-summarize-latest') as HTMLButtonElement

    if (msgPromptArea) msgPromptArea.value = settings.messageSystemPrompt
      if (songPromptArea) songPromptArea.value = settings.songSystemPrompt

        connSelect?.addEventListener('change', () => {
          settings.connectionId = connSelect.value
          saveAndSyncSettings()
        })

        ctxInput?.addEventListener('change', () => {
          settings.contextCount = Math.max(0, parseInt(ctxInput.value || '5', 10))
          saveAndSyncSettings()
        })

        maxTokensInput?.addEventListener('change', () => {
          settings.maxTokens = Math.max(0, parseInt(maxTokensInput.value || '4096', 10))
          saveAndSyncSettings()
        })

        msgPromptArea?.addEventListener('change', () => {
          settings.messageSystemPrompt = msgPromptArea.value.trim() || DEFAULT_MESSAGE_PROMPT
          saveAndSyncSettings()
        })

        songPromptArea?.addEventListener('change', () => {
          settings.songSystemPrompt = songPromptArea.value.trim() || DEFAULT_SONG_PROMPT
          saveAndSyncSettings()
        })

        resetPromptsBtn?.addEventListener('click', () => {
          settings.messageSystemPrompt = DEFAULT_MESSAGE_PROMPT
          settings.songSystemPrompt = DEFAULT_SONG_PROMPT
          if (msgPromptArea) msgPromptArea.value = DEFAULT_MESSAGE_PROMPT
            if (songPromptArea) songPromptArea.value = DEFAULT_SONG_PROMPT
              saveAndSyncSettings()
        })

        autoToggle?.addEventListener('change', () => {
          settings.autoSongEnabled = autoToggle.checked
          saveAndSyncSettings()
        })

        autoCountInput?.addEventListener('change', () => {
          settings.autoSongAfterMessages = Math.max(1, parseInt(autoCountInput.value || '5', 10))
          saveAndSyncSettings()
        })

        scanBtn?.addEventListener('click', () => {
          ctx.sendToBackend({
            type: 'scan_all_past_songs',
            chatId: getActiveChatId(),
                            latestMessageId: ctx.messages.getLatestMessageId(),
                            settings,
          })
        })

        latestBtn?.addEventListener('click', () => {
          const latestId = ctx.messages.getLatestMessageId()
          if (!latestId) return
            ctx.sendToBackend({
              type: 'summarize_message',
              chatId: getActiveChatId(),
                              messageId: latestId,
                              mode: 'auto_detect',
                              connectionId: settings.connectionId,
                              settings,
            })
        })
  }

  void renderDrawer()
  const unsubDrawerActivate = tab.onActivate(() => {
    void renderDrawer()
  })
  const unsubConnections = ctx.connections.subscribe(() => {
    void renderDrawer()
  })

  function decorateMountedMessages() {
    const seenIds = new Set<string>()

    for (const { messageId } of ctx.dom.listMessageElements()) {
      if (!messageId || seenIds.has(messageId)) continue
        seenIds.add(messageId)

        const bubble = ctx.dom.findMessageElement(messageId)
        if (!bubble) continue

          const existingBars = bubble.querySelectorAll('.sms-msg-bar')
          if (existingBars.length > 0) {
            for (let i = 0; i < existingBars.length - 1; i++) {
              const extra = existingBars[i]
              try {
                ctx.dom.uninject(extra.parentElement || extra)
              } catch {}
              extra.remove()
            }
            continue
          }

          const bar = ctx.dom.inject(
            bubble,
            `
            <div class="sms-msg-bar" data-sms-id="${messageId}">
            <button type="button" class="sms-msg-btn" data-sms-action="auto_detect" title="Summarize <song> tags if present, otherwise summarize message">
            ✨ Summarize
            </button>
            <button type="button" class="sms-msg-btn" data-sms-action="song_only" title="Replace only <song>...</song> with a summary">
            🎵 &lt;song&gt; Only
            </button>
            </div>
            `,
            'beforeend'
          )

          if (bar) {
            bar.addEventListener('click', (e) => {
              const btn = (e.target as HTMLElement).closest('[data-sms-action]') as HTMLElement | null
              if (!btn) return
                e.stopPropagation()
                const mode = btn.getAttribute('data-sms-action') || 'auto_detect'
                const resolvedId = ctx.dom.getMessageId(btn) || messageId
                ctx.sendToBackend({
                  type: 'summarize_message',
                  chatId: getActiveChatId(),
                                  messageId: resolvedId,
                                  mode,
                                  connectionId: settings.connectionId,
                                  settings,
                })
            })
          }
    }
  }

  decorateMountedMessages()
  const decorateInterval = window.setInterval(decorateMountedMessages, 1000)

  const onContextMenu = async (event: MouseEvent) => {
    if (!event.altKey) return
      const target = event.target as Element | null
      if (!target) return

        const messageId = ctx.dom.getMessageId(target)
        if (!messageId) return

          event.preventDefault()
          const { selectedKey } = await ctx.ui.showContextMenu({
            position: { x: event.clientX, y: event.clientY },
            items: [
              { key: 'auto_detect', label: '✨ Smart Summarize (<song> or Message)' },
                                                               { key: 'song_only', label: '🎵 Summarize <song>...</song> Tags Only' },
                                                               { key: 'full_message', label: '📝 Summarize Entire Message (with context)' },
            ],
          })

          if (selectedKey) {
            ctx.sendToBackend({
              type: 'summarize_message',
              chatId: getActiveChatId(),
                              messageId,
                              mode: selectedKey,
                              connectionId: settings.connectionId,
                              settings,
            })
          }
  }
  document.addEventListener('contextmenu', onContextMenu)

  const unsubGenEnded = ctx.events.on('GENERATION_ENDED', (payload: any) => {
    if (payload?.chatId) currentChatId = payload.chatId
      setTimeout(decorateMountedMessages, 150)
  })

  const unsubChatChanged = ctx.events.on('CHAT_CHANGED', (payload: any) => {
    if (payload?.chatId) currentChatId = payload.chatId
      setTimeout(decorateMountedMessages, 150)
  })

  return () => {
    window.clearInterval(decorateInterval)
    document.removeEventListener('contextmenu', onContextMenu)
    unsubGenEnded()
    unsubChatChanged()
    unsubDrawerActivate()
    unsubConnections()
    tab.destroy()
    removeStyle()
    ctx.dom.cleanup()
  }
}
