/**
 * TypeScript → body compilation for plugin halves. A half is authored as a
 * TS-flavored async function body (type annotations and `import type` allowed,
 * value imports and exports forbidden); esbuild strips the types so the
 * existing sandbox/closure evaluators can run the result unchanged.
 * @module @deepseek-ai/dsh-host-plugin-market/ts-compile
 */

import { transform } from 'esbuild'

/**
 * Strips single- and multi-line `import type … from …` statements. Anchored to
 * line starts so prose in a doc comment that merely mentions "`import type`"
 * is never mistaken for an import.
 */
const STRIP_TYPE_IMPORTS = /^\s*import\s+type\b[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm

/**
 * Marker comments that survive esbuild's transform: the `/*!` prefix marks a
 * legal (license-style) comment, which esbuild keeps verbatim with
 * `legalComments: 'inline'`, so the extracted slice is exactly the compiled
 * body without brace counting.
 */
const BODY_START = '/*!__dsh_ts_body_start__*/'
const BODY_END = '/*!__dsh_ts_body_end__*/'

/**
 * Compile one TS-authored half body to the plain-JS body the sandbox and
 * browser closure evaluate.
 * @param source - the TS function body (type-only imports allowed).
 * @returns the compiled JS function body.
 * @throws a teaching error for value imports/exports or an esbuild failure.
 */
export async function compileTsBody(source: string): Promise<string> {
  const cleaned = source.replace(STRIP_TYPE_IMPORTS, '')
  for (const line of cleaned.split('\n')) {
    if (/^\s*(import|export)\b/.test(line)) {
      throw new Error(
        'plugin halves must not use value imports or exports: '
        + `found ${JSON.stringify(line.trim())}. `
        + 'Use `import type { … } from "…"` for types only, or inline the helper code; '
        + 'the sandbox evaluates a single function body with React (client half) and '
        + 'the cordis services as the only available symbols.',
      )
    }
  }
  const wrapped = `async function __dsh_body() {\n${BODY_START}\n${cleaned}\n${BODY_END}\n}`
  let code: string
  try {
    const result = await transform(wrapped, {
      loader: 'ts',
      target: 'es2020',
      legalComments: 'inline',
    })
    code = result.code
  } catch (error) {
    throw new Error(`plugin half failed to compile as TypeScript: ${error instanceof Error ? error.message : String(error)}`)
  }
  const start = code.indexOf(BODY_START) + BODY_START.length
  const end = code.indexOf(BODY_END)
  if (start < BODY_START.length || end < 0 || end < start) {
    throw new Error(`plugin half failed to compile: esbuild dropped the body markers (${JSON.stringify(code.slice(0, 120))})`)
  }
  return code.slice(start, end).trim()
}
