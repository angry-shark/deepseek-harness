/**
 * Transcript projection from the durable event stream: row emission, assistant
 * streaming accumulation, tool-card pairing, and control escaping. Rows are
 * real pi-tui components rendered at a fixed width, so the assertions read the
 * same ANSI strings the terminal would.
 */

import { describe, expect, it } from 'vitest'
import type { Component } from '@earendil-works/pi-tui'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  CallId,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createPalette } from '../src/tui/theme.ts'
import { TranscriptController, assistantMarkdown, diffLines, displayText, textOfBlocks, toolCardText } from '../src/tui/transcript.ts'
import type { RowHost } from '../src/tui/transcript.ts'

/** A fake row host that records added components for rendering. */
class FakeHost implements RowHost {
  readonly children: Component[] = []
  addChild(component: Component): void { this.children.push(component) }
  clear(): void { this.children.length = 0 }
  render(width = 80): string[] {
    return this.children.flatMap(component => component.render(width))
  }
}

function controller(host: FakeHost): TranscriptController {
  return new TranscriptController(host, {
    showReasoning: true,
    palette: createPalette(false),
    presentCall: () => undefined,
    presentResult: () => undefined,
  })
}

describe('displayText', () => {
  it('escapes C0/C1 controls except line feeds', () => {
    expect(displayText('a\x1b[31mb\x00c\nd')).toBe('a\\x1b[31mb\\x00c\nd')
  })
})

describe('assistant markdown assembly', () => {
  it('prefixes reasoning when shown', () => {
    expect(assistantMarkdown('answer', 'think', true)).toBe('think\n\n---\n\nanswer')
  })
  it('omits reasoning when hidden or empty', () => {
    expect(assistantMarkdown('answer', 'think', false)).toBe('answer')
    expect(assistantMarkdown('answer', '  ', true)).toBe('answer')
  })
})

describe('diff lines', () => {
  it('marks added and removed lines exactly', () => {
    expect(diffLines('a\nb\nc', 'a\nc\nd')).toEqual(['  a', '  c', '+ d', '- b'])
  })
  it('treats a create as all added', () => {
    expect(diffLines(null, 'x\ny')).toEqual(['+ x', '+ y'])
  })
  it('falls back to whole-side comparison beyond the bound', () => {
    const oldLines = Array.from({ length: 600 }, (_, index) => `old${index}`).join('\n')
    const newLines = Array.from({ length: 600 }, (_, index) => `new${index}`).join('\n')
    const lines = diffLines(oldLines, newLines)
    expect(lines.filter(line => line.startsWith('- '))).toHaveLength(600)
    expect(lines.filter(line => line.startsWith('+ '))).toHaveLength(600)
  })
})

describe('tool card text', () => {
  it('renders a terminal call and its output', () => {
    const { title, body } = toolCardText(
      { card: 'terminal', title: 'npm test' },
      { view: { card: 'terminal', title: 'npm test', output: 'PASS', exitCode: 0 }, value: { content: [], isError: false } },
    )
    expect(title).toBe('npm test')
    expect(body).toContain('$ npm test')
    expect(body).toContain('PASS')
    expect(body).toContain('exit 0')
  })
  it('renders a diff card from call and result views', () => {
    const { body } = toolCardText(
      { card: 'diff', title: 'Write a.txt', diffs: [{ path: 'a.txt', oldText: null, newText: 'hi' }] },
      undefined,
    )
    expect(body).toContain('a.txt')
    expect(body).toContain('+ hi')
  })
  it('falls back to the raw result content without a result view', () => {
    const { body } = toolCardText(undefined, { view: undefined, value: { content: [{ type: 'text', text: 'raw' }], isError: false } })
    expect(body).toBe('raw')
  })
})

describe('transcript projection', () => {
  it('renders a user turn, streaming assistant text, and a tool card', () => {
    const session = Session.create(SessionId('t'))
    const host = new FakeHost()
    const view = controller(host)
    const user = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })

    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', user, { surfaceOp: 'append' })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } })
    session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: ' there' } })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'hi there' }],
        source: { provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('call-1'), name: 'noop', arguments: '{}' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    view.seed(session.events)
    const lines = host.render(120)
    const joined = lines.join('\n')
    expect(joined).toContain('You')
    expect(joined).toContain('hello')
    expect(joined).toContain('Assistant')
    expect(joined).toContain('hi there')
    expect(joined).toContain('think')
    expect(joined).toContain('noop')
  })

  it('skips tool-result user messages (rendered by the paired card)', () => {
    const session = Session.create(SessionId('t2'))
    const host = new FakeHost()
    const view = controller(host)
    const toolResult = createToolResultMessage({
      callId: CallId('call-1'),
      content: [{ type: 'text', text: 'output' }],
      isError: false,
    })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', toolResult, { surfaceOp: 'append' })
    view.seed(session.events)
    expect(host.render(80).join('\n')).not.toContain('output')
  })

  it('pairs a tool result with its call card', () => {
    const session = Session.create(SessionId('t3'))
    const host = new FakeHost()
    const view = controller(host)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('call-1'), name: 'bash', arguments: '{"cmd":"echo hi"}' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: CallId('call-1'),
        content: [{ type: 'text', text: 'hi' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    view.seed(session.events)
    const joined = host.render(120).join('\n')
    expect(joined).toContain('bash')
    expect(joined).toContain('hi')
  })

  it('clears rows for /clear', () => {
    const session = Session.create(SessionId('t4'))
    const host = new FakeHost()
    const view = controller(host)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    view.seed(session.events)
    expect(host.children.length).toBeGreaterThan(0)
    view.clear()
    expect(host.children).toHaveLength(0)
  })
})

describe('textOfBlocks', () => {
  it('joins text blocks and ignores others', () => {
    expect(textOfBlocks([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'r' }, { type: 'text', text: 'b' }])).toBe('ab')
  })
})
