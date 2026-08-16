/**
 * In-process human-interaction dialogs for the TUI front door: the
 * `ctx.userQuestions` provider and the `approval/request` answerer that
 * settle model-facing asks with the person at the terminal.
 *
 * Both share one FIFO dialog queue and render as pi-tui overlays. A dialog
 * owns the terminal focus until it settles; the queue is a plugin effect, so
 * unload cancels every pending ask and approval.
 * @module @deepseek-ai/dsh/tui/questions
 */

import { Container, SelectList, Text, type Component, type OverlayHandle, type SelectItem, type TUI } from '@earendil-works/pi-tui'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { displayText } from './transcript.ts'
import type { Palette } from './theme.ts'
import { selectListTheme } from './theme.ts'

/** One settled human decision. */
export type DialogOutcome =
  | { kind: 'answered'; label: string }
  | { kind: 'cancelled' }

/** A queued dialog: how to build its component, plus settlement wiring. */
interface PendingDialog {
  /** Build the dialog component; `onClose` settles this dialog. */
  build(onClose: (outcome: DialogOutcome) => void): Component
  resolve(outcome: DialogOutcome): void
  onAbort(): void
  signal: AbortSignal | undefined
}

/** Renders one modal dialog at a time over the running TUI. */
export class DialogHost {
  private readonly queue: PendingDialog[] = []
  private active: PendingDialog | undefined
  private handle: OverlayHandle | undefined
  private readonly tui: TUI
  private readonly palette: Palette
  private readonly theme: ReturnType<typeof selectListTheme>

  /** Create the dialog host over the running TUI. */
  constructor(tui: TUI, palette: Palette) {
    this.tui = tui
    this.palette = palette
    this.theme = selectListTheme(palette)
  }

  /**
   * Whether a dialog currently owns the terminal focus.
   * @returns true while a dialog overlay is visible.
   */
  isActive(): boolean {
    return this.active !== undefined
  }

  /**
   * Queue a dialog. The returned promise settles when the dialog closes with
   * {@link DialogOutcome}; an aborted signal cancels it.
   * @param build - constructs the dialog component, calling `onClose` on settlement.
   * @param signal - optional abort signal that cancels the dialog.
   * @returns a promise for the closed outcome.
   */
  request(build: PendingDialog['build'], signal: AbortSignal | undefined): Promise<DialogOutcome> {
    return new Promise<DialogOutcome>((resolve) => {
      const pending: PendingDialog = {
        build,
        resolve: (outcome) => {
          signal?.removeEventListener('abort', () => { pending.onAbort() })
          resolve(outcome)
        },
        onAbort: () => {
          this.close(pending, { kind: 'cancelled' })
        },
        signal,
      }
      signal?.addEventListener('abort', () => { pending.onAbort() }, { once: true })
      this.queue.push(pending)
      this.maybeShowNext()
    })
  }

  /** Cancel every queued and active dialog (plugin teardown). */
  closeAll(): void {
    for (const pending of this.queue.splice(0)) {
      pending.signal?.removeEventListener('abort', () => { pending.onAbort() })
      pending.resolve({ kind: 'cancelled' })
    }
    if (this.active !== undefined) this.close(this.active, { kind: 'cancelled' })
  }

  private maybeShowNext(): void {
    if (this.active !== undefined) return
    const next = this.queue.shift()
    if (next === undefined) return
    this.active = next
    const component = next.build((outcome) => { this.close(next, outcome) })
    this.handle = this.tui.showOverlay(component, {
      width: '70%',
      maxHeight: '60%',
      anchor: 'center',
    })
  }

  private close(pending: PendingDialog, outcome: DialogOutcome): void {
    if (this.active !== pending) return
    this.active = undefined
    this.handle?.hide()
    this.handle = undefined
    pending.resolve(outcome)
    this.maybeShowNext()
  }

  /**
   * Build a titled, single-select options dialog.
   * @param title - the dialog heading.
   * @param detail - supporting dim text, or an empty string for none.
   * @param items - the selectable options.
   * @param onSelect - called when the user picks one option.
   * @param onCancel - called when the user cancels the dialog.
   * @returns the dialog component to show as an overlay.
   */
  selectDialog(
    title: string,
    detail: string,
    items: readonly SelectItem[],
    onSelect: (item: SelectItem) => void,
    onCancel: () => void,
  ): Component {
    const palette = this.palette
    const container = new Container()
    container.addChild(new Text(palette.bold(palette.brand(displayText(title)))))
    if (detail !== '') container.addChild(new Text(palette.dim(displayText(detail))))
    container.addChild(new Text(''))
    const list = new SelectList([...items], items.length, this.theme)
    list.onSelect = onSelect
    list.onCancel = onCancel
    container.addChild(list)
    return container
  }
}

/**
 * Build the select items for one user-question option list.
 * @param options - the question's options, or `undefined` for none.
 * @returns the select items.
 */
export function questionOptions(options: AskUserQuestionRequest['questions'][number]['options']): SelectItem[] {
  return (options ?? []).map(option => ({
    value: option.label,
    label: option.label,
    ...option.description === undefined ? {} : { description: option.description },
  }))
}

/**
 * Present one ask_user_question request in a dialog. Single-select questions
 * settle with the chosen label; a cancelled or aborted dialog rejects.
 * @param host - the dialog host.
 * @param request - the pending question request.
 * @returns the question answer.
 */
export function askQuestion(
  host: DialogHost,
  request: AskUserQuestionRequest,
): Promise<{ answers: { id: string; selected: string[] }[] }> {
  const question = request.questions[0]
  if (question === undefined) {
    return Promise.reject(new UserQuestionError('ask_user_question requires at least one question', 'EMPTY_QUESTIONS'))
  }
  return host.request((onClose) => {
    const items = questionOptions(question.options)
    const selectable = items.length > 0 ? items : [{ value: '', label: '(no options)' }]
    return host.selectDialog(
      question.question,
      question.detail ?? '',
      selectable,
      (item) => { onClose({ kind: 'answered', label: item.value }) },
      () => { onClose({ kind: 'cancelled' }) },
    )
  }, request.signal).then((outcome) => {
    if (outcome.kind === 'cancelled') {
      throw new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
    }
    return { answers: [{ id: question.id, selected: [outcome.label] }] }
  })
}

/**
 * Present one approval request as an Allow / Reject dialog. Returns the
 * closed approval outcome vocabulary.
 * @param host - the dialog host.
 * @param request - the pending approval request.
 * @returns the approval outcome.
 */
export function askApproval(host: DialogHost, request: ApprovalRequest): Promise<ApprovalOutcome> {
  const detail = request.reason ?? ''
  return host.request((onClose) => {
    const items: SelectItem[] = [
      { value: 'allowed-once', label: 'Allow' },
      { value: 'rejected', label: 'Reject' },
    ]
    return host.selectDialog(
      `Allow ${request.toolName}?`,
      detail,
      items,
      (item) => { onClose({ kind: 'answered', label: item.value }) },
      () => { onClose({ kind: 'cancelled' }) },
    )
  }, request.signal).then((outcome) => {
    if (outcome.kind === 'cancelled') return 'cancelled'
    return outcome.label as ApprovalOutcome
  })
}
