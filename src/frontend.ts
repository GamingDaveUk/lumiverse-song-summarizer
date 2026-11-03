import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(ctx: SpindleFrontendContext) {
  let selectedConnectionId = ''
  let contextCount = 5
  let autoSongAfterMessages = 5
  let autoSongEnabled = false
  let currentChatId: string | null = null

  // Retire any leftover DOM elements from earlier versions
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
  .sms-select, .sms-input, .sms-btn {
    padding: 7px 10px;
    border-radius: var(--lumiverse-radius);
    border: 1px solid var(--lumiverse-border);
    background: var(--lumiverse-fill);
    color: var(--lumiverse-text);
    font-size: 13px;
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

  function syncSettingsToBackend() {
    ctx.sendToBackend({
      type: 'update_settings',
      settings: {
        connectionId: selectedConnectionId,
        contextCount,
        autoSongAfterMessages,
        autoSongEnabled,
      },
    })
  }

  const tab = ctx.ui.registerDrawerTab({
    id: 'song-summarizer',
    title: 'Song & Message Summarizer',
    shortName: 'Summarize',
    description: 'Configure connection profile and <song> / message summarization',
    keywords: ['song', 'summarize', 'summary', 'lyrics', 'connection'],
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
      `<option value="${p.id}" ${p.id === selectedConnectionId ? 'selected' : ''}>
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
    <input type="number" class="sms-input" id="sms-context-count" min="0" max="30" value="${contextCount}" />
    </div>

    <div class="sms-field">
    <label>
    <input type="checkbox" id="sms-auto-toggle" ${autoSongEnabled ? 'checked' : ''} />
    Auto-summarize &lt;song&gt; tags after N messages
    </label>
    </div>

    <div class="sms-field">
    <label>Messages to wait before auto-summarizing &lt;song&gt;</label>
    <input type="number" class="sms-input" id="sms-auto-count" min="1" max="50" value="${autoSongAfterMessages}" />
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
    const autoToggle = wrapper.querySelector('#sms-auto-toggle') as HTMLInputElement
    const autoCountInput = wrapper.querySelector('#sms-auto-count') as HTMLInputElement
    const scanBtn = wrapper.querySelector('#sms-scan-now') as HTMLButtonElement
    const latestBtn = wrapper.querySelector('#sms-summarize-latest') as HTMLButtonElement

    connSelect?.addEventListener('change', () => {
      selectedConnectionId = connSelect.value
      syncSettingsToBackend()
    })

    ctxInput?.addEventListener('change', () => {
      contextCount = Math.max(0, parseInt(ctxInput.value || '5', 10))
      syncSettingsToBackend()
    })

    autoToggle?.addEventListener('change', () => {
      autoSongEnabled = autoToggle.checked
      syncSettingsToBackend()
    })

    autoCountInput?.addEventListener('change', () => {
      autoSongAfterMessages = Math.max(1, parseInt(autoCountInput.value || '5', 10))
      syncSettingsToBackend()
    })

    scanBtn?.addEventListener('click', () => {
      ctx.sendToBackend({
        type: 'scan_all_past_songs',
        chatId: getActiveChatId(),
                        latestMessageId: ctx.messages.getLatestMessageId(),
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
                          connectionId: selectedConnectionId,
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
    // Deduplicate by messageId so if listMessageElements() returns both a header and body
    // element for the same messageId, we only ever process each messageId once using findMessageElement()
    const seenIds = new Set<string>()

    for (const { messageId } of ctx.dom.listMessageElements()) {
      if (!messageId || seenIds.has(messageId)) continue
        seenIds.add(messageId)

        const bubble = ctx.dom.findMessageElement(messageId)
        if (!bubble) continue

          // Check if this message already has any .sms-msg-bar inside it
          const existingBars = bubble.querySelectorAll('.sms-msg-bar')
          if (existingBars.length > 0) {
            // If an older injection left more than one bar, uninject the extras
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
                                  connectionId: selectedConnectionId,
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
                              connectionId: selectedConnectionId,
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
