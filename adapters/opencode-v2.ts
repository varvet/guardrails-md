/**
 * guardrails-md for OpenCode 2 — the v2 plugin-api binding of core.ts. The
 * package default stays the v1 adapter (adapters/opencode.ts); v2 harnesses
 * load this entrypoint via "@bergetai/guardrails-md/v2".
 *
 * v2 names: bash is shell, apply_patch is patch, edit/write carry `path`
 * instead of `filePath`. A block throws, and opencode hands the message to
 * the agent. The v2 plugin context has no toast API, so config warnings go
 * to the server log — every block reason repeats them anyway.
 */
import type { Plugin } from "@opencode/plugin"
import { createGate, type Harness } from "../core.ts"

function opencode(): Harness {
  const home = process.env.HOME
  return {
    name: "opencode",
    authPath: `${process.env.XDG_DATA_HOME ?? `${home}/.local/share`}/opencode/auth.json`,
    guardrailPaths: ["GUARDRAILS.md", ".opencode/GUARDRAILS.md", "guardrails.md", ".opencode/guardrails.md"],
    logPath: `${home}/.cache/opencode/systemone-gate.log`,
  }
}

// *** Begin Patch / @@ patch text: every marker line names a file.
function patchPaths(patchText: string): string[] {
  const paths: string[] = []
  for (const line of patchText.split("\n")) {
    const match = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): +(.+?)\s*$/)
    if (match) paths.push(match[1])
  }
  return paths
}

export default {
  id: "bergetai.guardrails-md",
  async setup(ctx) {
    const gate = createGate(opencode(), ctx.location.directory)
    for (const message of gate.warnings) console.warn(message)
    await ctx.tool.hook("execute.before", async (event) => {
      const args = (event.input ?? {}) as Record<string, unknown>
      if (event.tool === "shell") {
        const block = await gate.check(String(args.command ?? "").trim())
        if (block) throw new Error(block.reason)
        return
      }
      if (event.tool === "edit" || event.tool === "write") {
        const block = gate.checkPath(String(args.path ?? ""))
        if (block) throw new Error(block.reason)
        return
      }
      if (event.tool === "patch") {
        for (const path of patchPaths(String(args.patchText ?? ""))) {
          const block = gate.checkPath(path)
          if (block) throw new Error(block.reason)
        }
      }
    })
  },
} satisfies Plugin
