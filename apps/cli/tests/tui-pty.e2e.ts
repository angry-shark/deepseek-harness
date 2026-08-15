import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

// The Python driver forks a real pty, sizes it, and runs two phases over the
// same isolated DSH home. Phase one launches `dsh --profile tui`, waits for
// the full-screen banner, types `/exit`, and requires a clean exit (which
// flushes the persisted `main` session). Phase two launches
// `dsh --profile tui --resume main`, waits for the banner again, exits, and
// requires a clean exit — proving the persisted session resumed. This
// exercises the assembled TUI composition through the real Loader: TTY
// admission, the pi-tui screen, command dispatch, persistence flush, resume,
// and the launcher-owned shutdown.
const POSIX_TUI_PTY_DRIVER = String.raw`
import errno, fcntl, json, os, pty, select, signal, struct, sys, termios, time

node, launch_args_json, launch_env_json, cwd, timeout_seconds = sys.argv[1:]
env = os.environ.copy()
env.update(json.loads(launch_env_json))

def run_phase(args, expect_resume):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        os.execvpe(node, [node, *args], env)
    winsize = struct.pack("HHHH", 30, 100, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    output = bytearray()
    deadline = time.monotonic() + float(timeout_seconds)
    status = None
    sent_exit = False
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if chunk:
                output.extend(chunk)
        if not sent_exit and b"DeepSeek Harness" in output and b"Coding agent ready" in output:
            os.write(fd, b"/exit\r")
            sent_exit = True
        waited, candidate = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            status = candidate
            break
    if status is None:
        os.kill(pid, signal.SIGKILL)
        _, status = os.waitpid(pid, 0)
    sys.stdout.buffer.write(output)
    if not sent_exit:
        sys.stderr.write(f"{'resume' if expect_resume else 'fresh'} phase: TUI banner never rendered before timeout\n")
        sys.exit(124)
    actual_exit = os.waitstatus_to_exitcode(status)
    if actual_exit != 0:
        sys.stderr.write(f"{'resume' if expect_resume else 'fresh'} phase: expected exit 0 after /exit, got {actual_exit}\n")
        sys.exit(125)

# Phase one: fresh session main, flushed on /exit.
launch_args = json.loads(launch_args_json)
run_phase(launch_args, False)
# Phase two: resume the persisted main session.
run_phase([*launch_args, "--resume", "main"], True)
`

async function runTuiPtySmoke(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-tui-pty-'))
  try {
    const launch = resolveExampleLaunch({
      srcBin: dshBinScript,
      configArgs: ['--profile', 'tui'],
      tsconfigPath,
      env: {
        DSH_HOME: join(cwd, '.dsh'),
        DSH_AGENTS_HOME: join(cwd, '.agents'),
        DSH_TELEMETRY_DISABLED: '1',
      },
    })
    const timeoutMs = 20_000
    const result = await execa('python3', [
      '-c',
      POSIX_TUI_PTY_DRIVER,
      launch.command,
      JSON.stringify(launch.args),
      JSON.stringify(launch.env),
      cwd,
      String(timeoutMs / 1_000),
    ], {
      stdin: 'ignore',
      timeout: (timeoutMs * 2) + 15_000,
      killSignal: 'SIGKILL',
      reject: false,
      stripFinalNewline: false,
    })
    if (result.timedOut) {
      throw new Error(`dsh tui PTY driver did not exit. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    if (result.failed) {
      throw new Error(`dsh tui PTY driver exited ${String(result.exitCode)}. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    return result.stdout
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform === 'win32')('tui profile (real Loader tree in a PTY)', () => {
  it('boots the full-screen front door and exits cleanly on /exit', async () => {
    const output = await runTuiPtySmoke()
    expect(output).toContain('DeepSeek Harness')
    expect(output).toContain('Coding agent ready')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS + 10_000)
})
