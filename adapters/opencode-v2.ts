/**
 * guardrails-md for OpenCode 2 — the v2 plugin-api binding of core.ts. The
 * package default stays the v1 adapter (adapters/opencode.ts); v2 harnesses
 * load this entrypoint via "@bergetai/guardrails-md/v2".
 *
 * v2 names: bash is shell, apply_patch is patch, edit/write carry `path`
 * instead of `filePath`. A block throws, and opencode hands the message to
 * the agent. Verdicts that pass get stamped onto the permission ask, so the
 * human sees the scores when asked to approve. The v2 plugin context has no
 * toast API, so config warnings go
 * to the server log — every block reason repeats them anyway.
 */
import type { Plugin } from "@opencode/plugin"
import { createGate, type Harness, type Verdict } from "../core.ts"

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
    // Verdicts arrive from the gate without a call id — the in-flight queue
    // matches them back to the execute.before call by command text.
    const verdicts = new Map<string, { command: string; scores: Verdict }>()
    const inflight: { id: string; command: string }[] = []
    const gate = createGate(opencode(), ctx.location.directory, {
      onVerdict: (verdict) => {
        if (verdict.block) return
        const index = inflight.findIndex((call) => call.command === verdict.command)
        if (index === -1) return
        const [call] = inflight.splice(index, 1)
        verdicts.set(call.id, { command: verdict.command, scores: verdict.scores })
      },
    })
    for (const message of gate.warnings) console.warn(message)
    await ctx.tool.hook("execute.before", async (event) => {
      const args = (event.input ?? {}) as Record<string, unknown>
      if (event.tool === "shell") {
        const command = String(args.command ?? "").trim()
        const call = { id: event.id, command }
        inflight.push(call)
        const block = await gate.check(command)
        const index = inflight.indexOf(call)
        if (index !== -1) inflight.splice(index, 1)
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
    await ctx.permission.hook("evaluate", (event) => {
      if (event.action !== "shell" || !event.source) return
      const hit = verdicts.get(event.source.id)
      if (!hit) return
      verdicts.delete(event.source.id)
      const quote = hit.command.length > 80 ? `${hit.command.slice(0, 77)}…` : hit.command
      const scores = [
        `destructive ${hit.scores.destructive.toFixed(2)}`,
        `credentials ${hit.scores.credentials.toFixed(2)}`,
      ]
      if (hit.scores.guardrails_violation !== undefined) {
        scores.push(`guardrails_violation ${hit.scores.guardrails_violation.toFixed(2)}`)
      }
      event.message = `SystemOne-gate judged "${quote}": ${scores.join(", ")} — passed the block threshold`
    })
  },
} satisfies Plugin
