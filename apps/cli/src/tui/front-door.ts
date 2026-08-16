/**
 * The running TUI front door: owns the pi-tui screen, the transcript, the
 * editor, the status/todo chrome, and the in-process human-interaction
 * providers for one exact agent.
 * @module @deepseek-ai/dsh/tui/front-door
 */

import {
  Container, Editor, matchesKey, ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack,
} from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { TodoItem } from '@deepseek-ai/dsh-session'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { createPalette, editorTheme } from './theme.ts'
import type { Palette } from './theme.ts'
import { askApproval, askQuestion, DialogHost } from './questions.ts'
import { TranscriptController, displayText } from './transcript.ts'
import type { CardToolResult } from './transcript.ts'
import type { Config } from './types.ts'
import type { TuiRuntime } from './runtime.ts'

/** The footer cwd label; an embedding may override it through {@link TuiRuntime}. */
function cwdLabel(cwd: string, runtime: TuiRuntime | undefined): string {
  return runtime?.formatCwd?.(cwd) ?? cwd
}

/**
 * The assembled TUI for one agent. Construction is synchronous; {@link start}
 * enters full-screen mode and wires the service providers.
 */
export class FrontDoor {
  private readonly ctx: Context
  private readonly config: Config
  private readonly handle: AgentHandle
  private readonly agent: Agent
  private readonly palette: Palette
  private readonly tui: TuiAltScreen
  private readonly terminal = new ProcessTerminal()
  private readonly transcript: TranscriptController
  private readonly header: Text
  private readonly todo: Text
  private readonly status: Text
  private readonly editor: Editor
  private readonly dialogHost: DialogHost
  private readonly abort = new AbortController()
  private running = false
  private exiting = false
  private disposed = false
  private readonly disposers: (() => void)[] = []

  /** Create the front door over one owned agent handle. */
  constructor(ctx: Context, config: Config, handle: AgentHandle) {
    this.ctx = ctx
    this.config = config
    this.handle = handle
    this.agent = handle.agent
    this.palette = createPalette(config.color)
    this.tui = new TuiAltScreen(this.terminal, false)
    this.dialogHost = new DialogHost(this.tui, this.palette)

    const transcriptHost = new Container()
    const scrollView = new ScrollView(transcriptHost, { follow: 'end', scrollbar: 'auto' })
    const root = new VStack()
    this.header = new Text('')
    this.todo = new Text('')
    this.status = new Text('')
    this.editor = new Editor(this.tui, editorTheme(this.palette))
    // The editor must own the terminal focus while typing.
    this.editor.disableSubmit = false
    for (const component of [this.header, scrollView, this.todo, this.status, this.editor]) {
      root.addChild(component, component === scrollView
        ? { grow: 1, shrink: 1, minSize: 5 }
        : { grow: 0 })
    }
    this.tui.setLayoutRoot(root)
    this.tui.setFocus(this.editor)

    this.transcript = new TranscriptController(transcriptHost, {
      showReasoning: config.showReasoning,
      palette: this.palette,
      presentCall: (name, args) => this.presentCall(name, args),
      presentResult: (name, args, result) => this.presentResult(name, args, result),
    })
  }

  /**
   * Enter full-screen mode, seed the transcript, and wire every service
   * provider. Resolves once the terminal owns the screen.
   */
  start(): void {
    this.transcript.seed(this.agent.session.events)
    this.updateTodo(this.agent.session.events.findLast(event => event.type === 'todo/write')?.data.todos)
    this.updateTitle(this.agent.session.events.findLast(event => event.type === 'session/title')?.data.title)
    this.updateStatus()
    if (this.config.welcome !== '') this.transcript.appendWelcome(this.config.welcome)

    // Durable session events rebuild the transcript and chrome.
    this.disposers.push(this.ctx.on('session/event', (session, event) => {
      if (session.id !== this.agent.session.id) return
      this.transcript.handleEvent(event)
      if (event.type === 'todo/write') this.updateTodo(event.data.todos)
      if (event.type === 'session/title') this.updateTitle(event.data.title)
      this.tui.requestRender()
    }))

    this.disposers.push(this.ctx.on('agent/status', ({ agent, status }) => {
      if (agent.id !== this.agent.id) return
      this.running = status === 'running'
      this.updateStatus()
    }))

    // Human questions settle in a dialog; the model-facing ask_user_question
    // tool awaits the answer.
    this.disposers.push(this.ctx.userQuestions.registerProvider({
      ask: (request: AskUserQuestionRequest) => askQuestion(this.dialogHost, request),
    }))

    // Approval asks for this agent and its children settle interactively;
    // every other agent delegates down the chain.
    this.disposers.push(this.ctx.on('approval/request', (req: ApprovalRequest, next) => {
      if (!this.owns(req.agent)) return next()
      if (req.signal?.aborted === true) return Promise.resolve('cancelled' as ApprovalOutcome)
      return askApproval(this.dialogHost, req)
    }))

    // TUI-local slash commands.
    this.disposers.push(this.ctx.commands.register({
      name: 'help',
      description: 'List available slash commands.',
      handler: () => ({ kind: 'success', text: this.helpText() }),
    }))
    this.disposers.push(this.ctx.commands.register({
      name: 'exit',
      description: 'Exit the terminal UI.',
      handler: () => { void this.exit(0); return { kind: 'success', text: 'Exiting…' } },
    }))
    this.disposers.push(this.ctx.commands.register({
      name: 'clear',
      description: 'Clear the on-screen transcript.',
      handler: () => { this.transcript.clear(); return { kind: 'success' } },
    }))

    this.editor.onSubmit = (line) => { this.submit(line) }

    this.tui.addInputListener((data) => { this.handleGlobalKey(data) })

    this.terminal.setTitle(this.config.title)
    this.tui.start()
  }

  /** Dispose the terminal, owned agent, and every registered provider. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort()
    this.dialogHost.closeAll()
    for (const dispose of this.disposers.splice(0)) {
      try { dispose() } catch { /* provider teardown is best-effort */ }
    }
    this.tui.stop()
    try {
      await this.handle.dispose()
    } catch { /* agent disposal is best-effort during teardown */ }
  }

  /** Whether the agent owns a request (the agent itself or a child agent it created). */
  private owns(agent: Agent): boolean {
    if (agent.id === this.agent.id) return true
    return this.ctx.agents.isOwnedBy(agent.id, this.agent)
  }

  private presentCall(name: string, args: unknown): ToolCallView | undefined {
    try {
      return this.ctx.tools.get(name, this.agent)?.presentCall?.(args)
    } catch {
      return undefined
    }
  }

  private presentResult(name: string, args: unknown, result: CardToolResult): ToolResultView | undefined {
    try {
      return this.ctx.tools.get(name, this.agent)?.presentResult?.(args, result)
    } catch {
      return undefined
    }
  }

  private updateTodo(todos: readonly TodoItem[] | undefined): void {
    const list = todos ?? []
    this.todo.setText(list.length === 0 ? '' : this.palette.dim(
      list.map(item => `${item.status === 'completed' ? '☑' : item.status === 'in_progress' ? '◐' : '☐'} ${displayText(item.content)}`).join('\n')))
    this.tui.requestRender()
  }

  private updateTitle(title: string | undefined): void {
    const label = title !== undefined && title !== '' ? title : 'New session'
    this.header.setText(`${this.palette.brand('DeepSeek Harness')}  ${this.palette.dim(label)}`)
    this.terminal.setTitle(`${label} — ${this.config.title}`)
  }

  private updateStatus(): void {
    const palette = this.palette
    if (this.running) {
      this.status.setText(palette.dim(`${palette.accent('●')} running · esc interrupt`))
    } else {
      const cwd = cwdLabel(this.agent.session.header.cwd ?? process.cwd(), this.ctx.get('tuiRuntime'))
      const model = this.agent.options.model ?? 'unknown'
      this.status.setText(palette.dim(`idle · ${model} · ${displayText(cwd)}`))
    }
    this.tui.requestRender()
  }

  private helpText(): string {
    return this.ctx.commands.list(this.agent)
      .map(command => `/${command.name} — ${command.description}`)
      .join('\n')
  }

  private submit(line: string): void {
    const text = line
    if (text.trim() === '') return
    this.editor.setText('')
    if (text.startsWith('/')) {
      void this.dispatchCommand(text)
      return
    }
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    if (this.running) this.agent.steer(message)
    else this.agent.followup(message)
  }

  private async dispatchCommand(line: string): Promise<void> {
    const parsed = parseCommand(line)
    if (parsed === undefined) {
      this.appendNotice(this.palette.warning(`unknown command: ${displayText(line)}`))
      return
    }
    if (this.ctx.commands.find(this.agent, parsed.name) === undefined) {
      this.appendNotice(this.palette.warning(`unknown command: /${displayText(parsed.name)}`))
      return
    }
    try {
      const execution = await this.ctx.commands.execute(this.agent, line, this.abort.signal)
      if (execution === undefined) {
        this.appendNotice(this.palette.warning(`unknown command: /${displayText(parsed.name)}`))
      }
    } catch (error) {
      this.appendNotice(this.palette.error(`/${displayText(parsed.name)}: ${error instanceof Error ? error.message : String(error)}`))
    }
  }

  private appendNotice(text: string): void {
    this.transcript.appendNotice(text)
    this.tui.requestRender()
  }

  private handleGlobalKey(data: string): undefined {
    if (this.dialogHost.isActive()) return undefined
    if (matchesKey(data, 'esc') || matchesKey(data, 'ctrl+c')) {
      if (this.running) {
        this.agent.cancel({ kind: 'user' })
        return undefined
      }
      if (matchesKey(data, 'ctrl+c')) void this.exit(0)
      return undefined
    }
    if (matchesKey(data, 'ctrl+d')) {
      if (!this.running) void this.exit(0)
      return undefined
    }
    if (matchesKey(data, 'ctrl+l')) {
      this.tui.requestRender(true)
      return undefined
    }
    return undefined
  }

  /** Cancel a running turn, flush the session, restore the terminal, dispose the agent, and exit. */
  private async exit(code: number): Promise<void> {
    if (this.exiting) return
    this.exiting = true
    if (this.running) this.agent.cancel({ kind: 'user' })
    await this.agent.whenIdle().catch(() => {})
    await this.ctx.get('sessions')?.flush(this.agent.session).catch(() => {})
    await this.dispose()
    this.ctx.get('appExit')?.(code)
  }
}
