/**
 * @deepseek-ai/dsh/tui — the interactive full-screen terminal front door for
 * DeepSeek Harness agents, built on pi-tui. It renders the durable session
 * transcript, drives one created-or-resumed agent, and presents human
 * questions and approvals as keyboard dialogs.
 *
 * Agent lifecycle and persistence stay owned by the core services: this
 * plugin creates or resumes its agent through `ctx.agents`, reads every fact
 * it renders from `session/event`, and registers the shared interaction
 * providers. It requires both stdin and stdout to be TTYs and fails loud
 * otherwise.
 * @module @deepseek-ai/dsh/tui
 */

import type { Context } from '@deepseek-ai/cordis'
import { FiberState } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Command } from 'commander'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
// Type-only imports carry the Context merges for the cmdline and interaction
// services this plugin uses through the optional host and service surfaces.
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { FrontDoor } from './front-door.ts'

export { FrontDoor } from './front-door.ts'
export { DialogHost, askApproval, askQuestion } from './questions.ts'
export {
  TranscriptController, displayText, textOfBlocks, assistantMarkdown,
  parseToolArguments, toolCardText, diffLines,
} from './transcript.ts'
export type { TuiRuntime } from './runtime.ts'

/** Stable Cordis plugin name. */
export const name = 'tui'

/** Core services required before the front door can boot. */
export const inject = [
  'agents', 'agentDefaultModel', 'commands', 'sessions', 'sessionTitle', 'tools',
  'userQuestions', 'approval',
]

/** Plugin config. */
export interface Config {
  /** Exact shared agent/session identity the front door drives. */
  sessionId: string
  /** Banner subtitle row shown until the session has a logged title. */
  welcome: string
  /** Render reasoning blocks. */
  showReasoning: boolean
  /** Apply the built-in ANSI palette; `false` strips all styling. */
  color: boolean
  /** Product suffix for the terminal window title. */
  title: string
}

/** Runtime schema. */
export const Config: z<Config> = z.object({
  sessionId: z.string().default('main'),
  welcome: z.string().default(''),
  showReasoning: z.boolean().default(true),
  color: z.boolean().default(true),
  title: z.string().default('DeepSeek Harness'),
})

/** The front door's command: `--resume <sessionId>` and this app's help. */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Interactive terminal front door for DeepSeek Harness agents.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <sessionId>', 'resume a persisted session by id')
    .addHelpText('after', `
Examples:
  dsh --profile tui                 start a fresh session
  dsh --profile tui --resume <id>   resume a persisted session
`)
}

/** Whether a stream is a TTY; the front door cannot take over a pipe. */
function isTty(stream: { isTTY?: boolean }): boolean {
  return stream.isTTY === true
}

/**
 * Create or resume the configured agent and run the front door.
 * @param ctx - plugin context carrying the core services.
 * @param config - validated front-door config.
 * @param resumeSessionId - persisted session id to resume, or `undefined` for a fresh session.
 * @returns the owned agent handle once created.
 */
async function createAgent(
  ctx: Context, config: Config, resumeSessionId: string | undefined,
): Promise<AgentHandle> {
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  if (agents === undefined) throw new Error('tui: no agent registry is mounted')
  const selection = defaultModel?.currentSelection() ?? { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const agentOptions = { provider: selection.provider, model: selection.model }
  if (resumeSessionId !== undefined) {
    return agents.resume({ resumeSessionId: SessionId(resumeSessionId), agentOptions })
  }
  return agents.create({
    sessionId: SessionId(config.sessionId),
    meta: { cwd: process.cwd() },
    agentOptions,
  })
}

/**
 * Mount the TUI front door. Parses the launcher's inner arguments (owning
 * `--resume` and this app's `--help`), requires TTYs, then boots the terminal
 * and the shared interaction providers asynchronously.
 * @param ctx - plugin context carrying core services and the cmdline host.
 * @param config - validated front-door config.
 */
export function apply(ctx: Context, config: Config): void {
  const program = tuiCommand()
  let resumeSessionId: string | undefined
  program.action(() => {
    const options = program.opts<{ resume?: string }>()
    resumeSessionId = options.resume
  })
  // Help and rejected arguments settle through the launcher's exit request
  // before the TTY requirement is checked, so `--help` works when piped.
  parseCmdline(ctx, program)
  if (!isTty(process.stdin) || !isTty(process.stdout)) {
    throw new Error(
      'tui: both stdin and stdout must be TTYs; use dsh --profile headless for pipes and scripts')
  }

  let frontDoor: FrontDoor | undefined
  ctx.effect(() => () => {
    const current = frontDoor
    frontDoor = undefined
    return current?.dispose()
  }, 'tui: front door')

  void createAgent(ctx, config, resumeSessionId).then(async (handle) => {
    // A signal-shutdown can dispose the tree while creation is in flight; the
    // resolved handle must be released, never mounted on a dead context.
    if (ctx.fiber.state !== FiberState.ACTIVE) {
      await handle.dispose().catch(() => {})
      return
    }
    frontDoor = new FrontDoor(ctx, config, handle)
    frontDoor.start()
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.error(`tui: ${message}`)
    ctx.get('appExit')?.(1)
  })
}
