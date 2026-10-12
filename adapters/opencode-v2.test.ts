import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"

const sdk = await vi.hoisted(async () => (await import("../test/sdk-mock.ts")).createSdkMock())
vi.mock("@typesafe-ai/sdk", () => sdk.module)
const { systemOne } = sdk

const allow = { answers: { destructive: { noul: 0.01 }, credentials: { noul: 0 } } }
const blockDestructive = { answers: { destructive: { noul: 0.98 }, credentials: { noul: 0 } } }

type Hook = (event: { tool: string; input: unknown }) => Promise<void>

let dir: string
let home: string

async function loadHooks(): Promise<Record<string, Hook>> {
  const hooks: Record<string, Hook> = {}
  const mod = await import("./opencode-v2.ts")
  const ctx = {
    location: { directory: dir },
    tool: { hook: async (name: string, callback: Hook) => { hooks[name] = callback; return { dispose: async () => {} } } },
  } as unknown as Plugin.Context
  await mod.default.setup(ctx)
  return hooks
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  home = mkdtempSync(join(tmpdir(), "gate-home-"))
  dir = mkdtempSync(join(tmpdir(), "gate-proj-"))
  vi.stubEnv("HOME", home)
  vi.stubEnv("BERGET_API_KEY", "test-key")
  vi.stubEnv("XDG_DATA_HOME", undefined)
  vi.stubEnv("SYSTEMONE_GATE", undefined)
  vi.stubEnv("SYSTEMONE_THRESHOLD", undefined)
  systemOne.mockResolvedValue(structuredClone(allow))
  sdk.configs.length = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})

describe("opencode v2 adapter", () => {
  it("Given the package entry, When inspected, Then it defines the v2 plugin", async () => {
    const mod = await import("./opencode-v2.ts")
    expect(mod.default.id).toBe("bergetai.guardrails-md")
    expect(mod.default.setup).toBeTypeOf("function")
  })

  it("Given setup, When run, Then it registers execute.before", async () => {
    expect((await loadHooks())["execute.before"]).toBeTypeOf("function")
  })

  it("Given a safe verdict, When shell runs, Then the hook resolves", async () => {
    const hook = (await loadHooks())["execute.before"]!
    await expect(hook({ tool: "shell", input: { command: "ls -la" } })).resolves.toBeUndefined()
  })

  it("Given a destructive verdict, When shell runs, Then the hook throws with opencode wording", async () => {
    systemOne.mockResolvedValue(blockDestructive)
    const hook = (await loadHooks())["execute.before"]!
    await expect(hook({ tool: "shell", input: { command: "rm -rf /data" } })).rejects.toThrow(
      /destructive=0\.98[\s\S]*restart opencode/,
    )
  })

  it("Given a non-gated tool, When it is called, Then the model is not asked", async () => {
    const hook = (await loadHooks())["execute.before"]!
    await hook({ tool: "read", input: { path: "GUARDRAILS.md" } })
    expect(systemOne).not.toHaveBeenCalled()
  })

  it("Given an invalid SYSTEMONE_THRESHOLD, When the plugin loads, Then a warning is logged", async () => {
    vi.stubEnv("SYSTEMONE_THRESHOLD", "abc")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await loadHooks()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/SYSTEMONE_THRESHOLD/))
    warn.mockRestore()
  })
})

describe("opencode v2 adapter: protected paths", () => {
  it("Given an edit on GUARDRAILS.md via path, When the hook runs, Then it throws and the model is not asked", async () => {
    const hook = (await loadHooks())["execute.before"]!
    await expect(hook({ tool: "edit", input: { path: join(dir, "GUARDRAILS.md") } })).rejects.toThrow(
      /protected file — GUARDRAILS\.md[\s\S]*restart opencode/,
    )
    expect(systemOne).not.toHaveBeenCalled()
  })

  it("Given a write to .opencode/GUARDRAILS.md, When the hook runs, Then it throws", async () => {
    const hook = (await loadHooks())["execute.before"]!
    await expect(hook({ tool: "write", input: { path: join(dir, ".opencode", "GUARDRAILS.md") } })).rejects.toThrow(
      /protected file/,
    )
    expect(systemOne).not.toHaveBeenCalled()
  })

  it("Given patch touching opencode.json, When the hook runs, Then it throws", async () => {
    const hook = (await loadHooks())["execute.before"]!
    const patchText = `*** Begin Patch\n*** Update File: ${join(dir, "opencode.json")}\n@@\n@@\n*** End Patch`
    await expect(hook({ tool: "patch", input: { patchText } })).rejects.toThrow(/protected file — opencode\.json/)
    expect(systemOne).not.toHaveBeenCalled()
  })

  it("Given an edit on a plain source file, When the hook runs, Then it passes and the model is not asked", async () => {
    const hook = (await loadHooks())["execute.before"]!
    await expect(hook({ tool: "edit", input: { path: join(dir, "src", "a.ts") } })).resolves.toBeUndefined()
    expect(systemOne).not.toHaveBeenCalled()
  })

  it("Given SYSTEMONE_GATE=off, When an edit on GUARDRAILS.md runs, Then it passes", async () => {
    vi.stubEnv("SYSTEMONE_GATE", "off")
    const hook = (await loadHooks())["execute.before"]!
    await expect(hook({ tool: "edit", input: { path: join(dir, "GUARDRAILS.md") } })).resolves.toBeUndefined()
  })
})
