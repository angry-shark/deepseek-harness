/**
 * Ambient symbols available to plugin halves. The market strips `import type`
 * and compiles the body with esbuild without type-checking; this file exists
 * so editors can check a half's body as it is written.
 */

declare const harness: {
  /** Register a Host method the Client half can call with `host.call`. */
  handle(method: string, handler: (args: unknown) => unknown | Promise<unknown>): () => void
  /** Register a model-facing tool (host half only). */
  defineTool(definition: unknown): unknown
  registerTool(ctx: unknown, tool: unknown): () => void
}

declare const React: {
  createElement(type: unknown, props: unknown, ...children: unknown[]): unknown
  useState<S>(initial: S | (() => S)): [S, (value: S) => void]
  useEffect(effect: () => unknown | (() => void), deps?: readonly unknown[]): void
}

declare const styles: {
  insert(css: string): () => void
}

declare const host: {
  call(method: string, args?: unknown): Promise<unknown>
}
