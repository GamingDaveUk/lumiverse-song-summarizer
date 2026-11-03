import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

export function setup(ctx: SpindleFrontendContext) {
  let selectedConnectionId = ''
  let contextCount = 5
  let autoSongAfterMessages = 5
  let autoSongEnabled = false
  let currentChatId: string | null = null

  // 1. Add theme-aware styles using Lumiverse CSS variables
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
      display: inline-flex;
      gap: 6px;
      margin-top: 6px;
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

  // 2. Register Sidebar Drawer Tab for Connection Selection & Controls
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

    // Fetch LLM Connection Profiles from ctx.connections
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
        <strong>Tip:</strong> Each message bubble gets <em>Summarize</em> buttons at the bottom, or you can hold <strong>Alt + Right-Click</strong> on any message bubble to open the Summarizer menu.
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
        chatId: currentChatId,
      })
    })

    latestBtn?.addEventListener('click', () => {
      const latestId = ctx.messages.getLatestMessageId()
      if (!latestId) return
      ctx.sendToBackend({
        type: 'summarize_message',
        chatId: currentChatId,
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

  // 3. Inject Action Buttons into Mounted Message Bubbles
  const decoratedMessages = new Set<string>()

  function decorateMountedMessages() {
    for (const { messageId, element } of ctx.dom.listMessageElements()) {
      if (decoratedMessages.has(messageId)) continue

      const bar = ctx.dom.inject(
        element,
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
        decoratedMessages.add(messageId)
        bar.addEventListener('click', (e) => {
          const btn = (e.target as HTMLElement).closest('[data-sms-action]') as HTMLElement | null
          if (!btn) return
          e.stopPropagation()
          const mode = btn.getAttribute('data-sms-action') || 'auto_detect'
          const resolvedId = ctx.dom.getMessageId(btn) || messageId
          ctx.sendToBackend({
            type: 'summarize_message',
            chatId: currentChatId,
            messageId: resolvedId,
            mode,
            connectionId: selectedConnectionId,
          })
        })
      }
    }
  }

  // Initial pass + event-driven updates
  decorateMountedMessages()

  // 4. Alt + Right-Click Context Menu on any Message Bubble
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
        chatId: currentChatId,
        messageId,
        mode: selectedKey,
        connectionId: selectedConnectionId,
      })
    }
  }
  document.addEventListener('contextmenu', onContextMenu)

  // 5. Subscribe to Host Events to keep chatId & bubble buttons updated
  const unsubGenEnded = ctx.events.on('GENERATION_ENDED', (payload: any) => {
    if (payload?.chatId) currentChatId = payload.chatId
    setTimeout(decorateMountedMessages, 150)
  })

  const unsubChatChanged = ctx.events.on('CHAT_CHANGED', (payload: any) => {
    if (payload?.chatId) currentChatId = payload.chatId
    decoratedMessages.clear()
    setTimeout(decorateMountedMessages, 150)
  })

  // Cleanup when extension unloads
  return () => {
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