/**
 * Transcript projection and rendering for the TUI front door: turns the
 * durable `session/event` stream into the ordered pi-tui components the user
 * reads. The controller seeds from an existing log (fresh create or resume)
 * and then consumes the live feed incrementally, so a resumed conversation
 * renders identically to one this process watched.
 *
 * Assistant steps stream: text and reasoning accumulate per (turn, step) and
 * the Markdown body re-renders on each chunk. Tool calls pair with their
 * results through the durable `callId`, and the tool's own
 * `presentCall`/`presentResult` intents drive card titles and bodies when the
 * definition is registered.
 * @module @deepseek-ai/dsh-tui/transcript
 */

import { Container, Markdown, Text, type Component } from '@earendil-works/pi-tui'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import { markdownTheme } from './theme.ts'
import type { Palette } from './theme.ts'

/**
 * Render every C0/C1 control except line feeds as visible hex escapes.
 * @param text - the untrusted string to escape.
 * @returns the escaped text, safe to render to a terminal.
 */
export function displayText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/g, char =>
    `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/**
 * Join the text blocks of a content block list.
 * @param blocks - the content blocks to scan.
 * @returns the concatenated text block contents.
 */
export function textOfBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * A user message's header label, by source.
 * @param source - the message source.
 * @returns the header label.
 */
export function headerForSource(source: MessageSource): string {
  switch (source.kind) {
    case 'user':
      return 'You'
    case 'plugin':
      return `Context · ${source.plugin}`
    default:
      return 'Context'
  }
}

/**
 * Whether a user message is the model-facing tool-result injection (rendered by tool cards).
 * @param message - the user message to classify.
 * @returns true when the message carries a tool result.
 */
export function isToolResultMessage(message: UserMessage): boolean {
  return message.source.kind === 'tool'
}

/**
 * The markdown body of one assistant message, with reasoning on top when shown.
 * @param text - the visible assistant text.
 * @param reasoning - the reasoning text.
 * @param showReasoning - whether reasoning renders.
 * @returns the combined markdown body.
 */
export function assistantMarkdown(text: string, reasoning: string, showReasoning: boolean): string {
  if (!showReasoning || reasoning.trim() === '') return text
  return `${reasoning}\n\n---\n\n${text}`
}

/**
 * Parse a raw tool-arguments JSON string, returning the raw string on failure.
 * @param raw - the raw JSON arguments string.
 * @returns the parsed value, or the raw string when it is not valid JSON.
 */
export function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/**
 * Pretty-print an unknown argument value for a generic card body.
 * @param value - the value to render.
 * @returns a string representation.
 */
export function formatGenericInput(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** A completed tool outcome in the shape `presentResult` receives. */
export interface CardToolResult {
  content: ContentBlock[]
  isError: boolean
  meta?: JsonValue
}

/**
 * Render the pending or completed tool card text from its presentation intents.
 * @param call - the tool's pending-call presentation, when registered.
 * @param result - the completed presentation and raw outcome, when the call settled.
 * @returns the card title and body lines.
 */
export function toolCardText(
  call: ToolCallView | undefined,
  result: { view: ToolResultView | undefined; value: CardToolResult } | undefined,
): { title: string; body: string } {
  const pendingTitle = call?.title ?? ''
  const title = result?.view?.title ?? pendingTitle
  const body: string[] = []
  if (call !== undefined) {
    if (call.card === 'terminal') {
      body.push(`$ ${call.title}`)
      if (call.cwd !== undefined && call.cwd !== '') body.push(displayText(call.cwd))
    } else if (call.card === 'diff') {
      for (const diff of call.diffs) {
        body.push(displayText(diff.path))
        body.push(...diffLines(diff.oldText, diff.newText))
      }
    } else if (call.rawInput !== undefined) {
      body.push(displayText(formatGenericInput(call.rawInput)))
    }
  }
  if (result !== undefined) {
    const view = result.view
    if (view !== undefined) {
      if (view.card === 'terminal') {
        if (view.output !== undefined && view.output !== '') body.push(displayText(view.output))
        if (view.exitCode !== undefined) body.push(`exit ${view.exitCode}`)
        if (view.signal !== undefined) body.push(`signal ${view.signal}`)
      } else if (view.card === 'diff') {
        for (const diff of view.diffs) body.push(displayText(diff.path), ...diffLines(diff.oldText, diff.newText))
      } else if (view.card === 'generic' && view.content !== undefined) {
        const text = textOfBlocks(view.content)
        if (text !== '') body.push(displayText(text))
      }
    } else {
      const text = textOfBlocks(result.value.content)
      if (text !== '') body.push(displayText(text))
    }
  }
  return { title, body: body.join('\n') }
}

/**
 * Added/removed lines of one diff, `+`/`-` prefixed.
 * @param oldText - the prior content, or `null` for a create.
 * @param newText - the content after the change.
 * @returns the prefixed line list.
 */
export function diffLines(oldText: string | null, newText: string): string[] {
  const lines: string[] = []
  const oldLines = oldText === null ? [] : oldText.split('\n')
  const newLines = newText.split('\n')
  if (oldLines.length + newLines.length <= 1000) {
    const oldSet = new Set(oldLines)
    const newSet = new Set(newLines)
    for (const line of newLines) lines.push(oldSet.has(line) ? `  ${line}` : `+ ${line}`)
    for (const line of oldLines) if (!newSet.has(line)) lines.push(`- ${line}`)
  } else {
    for (const line of oldLines) lines.push(`- ${line}`)
    for (const line of newLines) lines.push(`+ ${line}`)
  }
  return lines
}

/**
 * Status glyph of one tool card.
 * @param status - the card's completion state.
 * @returns the one-cell glyph.
 */
export function toolStatusGlyph(status: 'pending' | 'done' | 'error'): string {
  return status === 'pending' ? '·' : status === 'error' ? '✗' : '✓'
}

/** Live streaming state of one assistant step. */
interface AssistantGroup {
  turn: number
  step: number
  header: Text
  reasoning: Text | undefined
  body: Markdown
  container: Container
  text: string
  reasoningText: string
}

/** One tool call's card components. */
interface ToolCard {
  name: string
  header: Text
  body: Text
  rawArguments: string
  call: ToolCallView | undefined
  status: 'pending' | 'done' | 'error'
}

/** Minimum host a transcript appends rows to; pi-tui `Container` satisfies it. */
export interface RowHost {
  addChild(component: Component): void
  clear(): void
}

/** Options the front door supplies to the transcript controller. */
export interface TranscriptOptions {
  /** Whether reasoning blocks render (below the assistant header, dimmed). */
  showReasoning: boolean
  /** The active palette. */
  palette: Palette
  /** Resolve a registered tool definition's presentation intents. */
  presentCall(name: string, args: unknown): ToolCallView | undefined
  presentResult(name: string, args: unknown, result: CardToolResult): ToolResultView | undefined
}

/**
 * Consume the durable event stream into transcript rows. Replay the loaded
 * log with {@link seed}, then feed live events through {@link handleEvent}.
 */
export class TranscriptController {
  private currentAssistant: AssistantGroup | undefined
  private readonly toolCards = new Map<string, ToolCard>()
  private readonly host: RowHost
  private readonly options: TranscriptOptions
  private readonly theme: ReturnType<typeof markdownTheme>

  /** Create a controller over a row host. */
  constructor(host: RowHost, options: TranscriptOptions) {
    this.host = host
    this.options = options
    this.theme = markdownTheme(options.palette)
  }

  /**
   * Replay a full log (fresh or resumed) to rebuild the transcript.
   * @param events - the ordered durable event log.
   */
  seed(events: readonly SessionEvent[]): void {
    for (const event of events) this.handleEvent(event)
  }

  /** Remove every rendered row (the `/clear` command). */
  clear(): void {
    this.currentAssistant = undefined
    this.toolCards.clear()
    this.host.clear()
  }

  /**
   * Append a dim, one-line banner row (the configured welcome text).
   * @param text - the banner text.
   */
  appendWelcome(text: string): void {
    this.appendNotice(text)
  }

  /**
   * Append a dim one-line notice row.
   * @param text - the notice text.
   */
  appendNotice(text: string): void {
    const palette = this.options.palette
    this.host.addChild(new Text(palette.dim(displayText(text))))
  }

  /**
   * Process one durable session event, appending or updating rows.
   * @param event - the session event to project.
   */
  handleEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start':
        this.appendTurn(event.data.turn)
        break
      case 'user/message': {
        const message = event.data
        if (!isToolResultMessage(message)) this.appendUser(message)
        break
      }
      case 'assistant/chunk':
        this.streamChunk(event.data.turn, event.data.step, event.data.chunk)
        break
      case 'assistant/message':
        this.settleAssistant(event.data.turn, event.data.step, event.data.message.content)
        break
      case 'tool/call':
        this.appendToolCall(event.data)
        break
      case 'tool/result': {
        const card = this.toolCards.get(String(event.data.message.source.callId))
        if (card !== undefined) this.settleTool(card, event.data)
        break
      }
      case 'command/done': {
        const text = event.data.text
        if (text !== undefined && text !== '') this.appendNotice(text)
        break
      }
      case 'turn/end':
      case 'step/start':
      case 'step/end':
      case 'todo/write':
      case 'request/header':
      case 'request/context':
      case 'session/end-seed':
      case 'command/run':
        break
      default:
        // Merge-extensible map: unknown durable events render nothing.
        break
    }
  }

  private appendTurn(turn: number): void {
    const palette = this.options.palette
    const component = new Text(palette.dim(`── turn ${turn} ──`))
    this.host.addChild(component)
  }

  private appendUser(message: UserMessage): void {
    const palette = this.options.palette
    const isUser = message.source.kind === 'user'
    const container = new Container()
    container.addChild(new Text(isUser ? palette.bold(palette.brand('You')) : palette.dim(headerForSource(message.source))))
    container.addChild(new Markdown(displayText(textOfBlocks(message.content)), 0, 0, this.theme))
    this.host.addChild(container)
  }

  private assistantGroup(turn: number, step: number): AssistantGroup {
    const group = this.currentAssistant
    if (group !== undefined && group.turn === turn && group.step === step) return group
    const palette = this.options.palette
    const container = new Container()
    container.addChild(new Text(palette.bold(palette.accent('Assistant'))))
    container.addChild(new Markdown('', 0, 0, this.theme))
    const fresh: AssistantGroup = {
      turn, step,
      header: container.children[0] as Text,
      reasoning: undefined,
      body: container.children[1] as Markdown,
      container, text: '', reasoningText: '',
    }
    this.currentAssistant = fresh
    this.host.addChild(container)
    return fresh
  }

  private streamChunk(
    turn: number,
    step: number,
    chunk: SessionEvent<'assistant/chunk'>['data']['chunk'],
  ): void {
    const group = this.assistantGroup(turn, step)
    if (chunk.type === 'text-delta') {
      group.text += chunk.text
    } else if (chunk.type === 'reasoning-delta') {
      group.reasoningText += chunk.text
    } else if (chunk.type === 'block-end' && chunk.block.type === 'text') {
      group.text = chunk.block.text
    } else if (chunk.type === 'block-end' && chunk.block.type === 'reasoning') {
      group.reasoningText = chunk.block.text
    }
    this.refreshAssistant(group)
  }

  private settleAssistant(turn: number, step: number, content: readonly ContentBlock[]): void {
    const group = this.assistantGroup(turn, step)
    group.text = textOfBlocks(content)
    group.reasoningText = content
      .filter((block): block is Extract<ContentBlock, { type: 'reasoning' }> => block.type === 'reasoning')
      .map(block => block.text)
      .join('')
    this.refreshAssistant(group)
  }

  private refreshAssistant(group: AssistantGroup): void {
    const palette = this.options.palette
    const wantsReasoning = this.options.showReasoning && group.reasoningText.trim() !== ''
    if (wantsReasoning && group.reasoning === undefined) {
      const reasoning = new Text(palette.italic(palette.dim(group.reasoningText)))
      group.reasoning = reasoning
      group.container.clear()
      group.container.addChild(group.header)
      group.container.addChild(reasoning)
      group.container.addChild(group.body)
    } else if (!wantsReasoning && group.reasoning !== undefined) {
      group.reasoning = undefined
      group.container.clear()
      group.container.addChild(group.header)
      group.container.addChild(group.body)
    } else if (group.reasoning !== undefined) {
      group.reasoning.setText(palette.italic(palette.dim(group.reasoningText)))
    }
    group.body.setText(displayText(assistantMarkdown(group.text, group.reasoningText, this.options.showReasoning)))
  }

  private appendToolCall(data: SessionEvent<'tool/call'>['data']): void {
    const palette = this.options.palette
    const args = parseToolArguments(data.arguments)
    const call = this.options.presentCall(data.name, args)
    const { title, body } = toolCardText(call, undefined)
    const header = new Text(palette.dim(`${toolStatusGlyph('pending')} ${displayText(title || data.name)}`))
    const bodyText = new Text(body === '' ? '' : palette.dim(body))
    const container = new Container()
    container.addChild(header)
    container.addChild(bodyText)
    this.toolCards.set(String(data.callId), {
      name: data.name, header, body: bodyText, rawArguments: data.arguments, call, status: 'pending',
    })
    this.host.addChild(container)
  }

  private settleTool(card: ToolCard, data: SessionEvent<'tool/result'>['data']): void {
    const palette = this.options.palette
    const args = parseToolArguments(card.rawArguments)
    const value: CardToolResult = {
      content: data.message.content[0].content,
      isError: data.error !== undefined,
      ...data.meta === undefined ? {} : { meta: data.meta },
    }
    const view = this.options.presentResult(card.name, args, value)
    const status = data.error !== undefined ? 'error' : 'done'
    const { title, body } = toolCardText(card.call, { view, value })
    card.status = status
    card.header.setText(palette[status === 'error' ? 'error' : 'success'](
      `${toolStatusGlyph(status)} ${displayText(title || card.name)}`))
    card.body.setText(body === '' ? '' : palette.dim(body))
  }
}
