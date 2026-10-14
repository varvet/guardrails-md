/**
 * guardrails-md for OpenCode 2 — the v2 plugin-api binding of core.ts. The
 * package default stays the v1 adapter (adapters/opencode.ts); v2 harnesses
 * load this entrypoint via "@bergetai/guardrails-md/v2".
 *
 * The gate judges every shell command. Passing verdicts stamp the ask; judged
 * blocks ask the human, whose Allow overrules the gate and whose Deny keeps
 * the command blocked. Unattended runs auto-reject that ask, so it fails closed.
 */
import type { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { createGate, type Block, type Harness, type Verdict } from "../core.ts"

function trace(message: string): void {
  try {
    const path = `${process.env.HOME}/.cache/opencode/systemone-v2-debug.log`
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

// The berget provider refreshes its credential into opencode's v2 store
// (credential table in opencode.db); auth.json is a legacy file v2 no
// longer updates. Read-only, no refresh of our own — a refresh token
// rotation we failed to persist would lock the provider out.
async function v2Seat(): Promise<string | undefined> {
  try {
    const { Database } = await import("bun:sqlite")
    const base = process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`
    const db = new Database(`${base}/opencode/opencode.db`, { readonly: true })
    try {
      const row = db
        .query("SELECT value FROM credential WHERE active = 1 AND lower(label) LIKE 'berget%'")
        .all() as Array<{ value: string }>
      const parsed = row
        .map((entry) => JSON.parse(entry.value) as { access?: unknown; expires?: unknown })
        .filter((entry) => typeof entry.access === "string" && typeof entry.expires === "number")
      const freshest = parsed.toSorted((a, b) => (b.expires as number) - (a.expires as number))[0]
      if (!freshest || (freshest.expires as number) <= Date.now()) return undefined
      return freshest.access as string
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

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
    trace(`setup directory=${ctx.location.directory}`)
    // Verdicts arrive from the gate without a call id — the in-flight queue
    // matches them back to the execute.before call by command text.
    const verdicts = new Map<string, { command: string; scores: Verdict; block: Block | null }>()
    const inflight: { id: string; command: string }[] = []
    const gate = createGate(opencode(), ctx.location.directory, {
      onVerdict: (verdict) => {
        trace(
          `onVerdict block=${verdict.block ? "true" : "false"} destructive=${verdict.scores.destructive.toFixed(2)} credentials=${verdict.scores.credentials.toFixed(2)}`,
        )
        const index = inflight.findIndex((call) => call.command === verdict.command)
        if (index === -1) {
          trace(`onVerdict no inflight match for ${verdict.command.length} chars`)
          return
        }
        const [call] = inflight.splice(index, 1)
        verdicts.set(call.id, { command: verdict.command, scores: verdict.scores, block: verdict.block })
      },
    })
    for (const message of gate.warnings) console.warn(message)
    await ctx.tool.hook("execute.before", async (event) => {
      const args = (event.input ?? {}) as Record<string, unknown>
      if (event.tool === "shell") {
        const command = String(args.command ?? "").trim()
        const seat = await v2Seat()
        trace(
          `shell check credential=${gate.hasCredential() || !!seat} seat=${seat ? "v2-store" : "none"} gate=${process.env.SYSTEMONE_GATE ?? "on"} command=${command.length} chars`,
        )
        const call = { id: event.id, command }
        inflight.push(call)
        const block = await gate.check(command, seat)
        const index = inflight.indexOf(call)
        if (index !== -1) inflight.splice(index, 1)
        if (block && !verdicts.has(event.id)) throw new Error(block.reason)
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
    try {
      await ctx.permission.hook("evaluate", (event) => {
        try {
          trace(`evaluate action=${event.action} source=${event.source?.id ?? "none"}`)
          if (event.action !== "shell" || !event.source) return
          const hit = verdicts.get(event.source.id)
          if (!hit) {
            trace(`evaluate no stash for ${event.source.id}`)
            return
          }
          verdicts.delete(event.source.id)
          const quote = hit.command.length > 80 ? `${hit.command.slice(0, 77)}…` : hit.command
          const scores = [
            `destructive ${hit.scores.destructive.toFixed(2)}`,
            `credentials ${hit.scores.credentials.toFixed(2)}`,
          ]
          if (hit.scores.guardrails_violation !== undefined) {
            scores.push(`guardrails_violation ${hit.scores.guardrails_violation.toFixed(2)}`)
          }
          if (hit.block) {
            event.effect = "ask"
            event.message = `SystemOne-gate blocked "${quote}": ${scores.join(", ")}, over the block threshold. Allow overrules the gate and runs it. Deny keeps it blocked.`
            trace(`evaluate asked for ${event.source.id}`)
            return
          }
          event.message = `SystemOne-gate judged "${quote}": ${scores.join(", ")} — passed the block threshold`
          trace(`evaluate stamped for ${event.source.id}`)
        } catch (err) {
          trace(`evaluate threw ${String(err)}`)
        }
      })
    } catch (err) {
      trace(`permission hook registration threw ${String(err)}`)
    }
  },
} satisfies Plugin
