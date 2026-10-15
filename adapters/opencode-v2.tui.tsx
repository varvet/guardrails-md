/** @jsxImportSource @opentui/solid */
/**
 * TUI side of the v2 adapter: opencode's permission prompt does not render
 * the verdict the server-side plugin stamps onto the ask, so this claims the
 * composer-top slot and shows it there while the ask is unresolved, and keeps
 * a rolling history behind the /verdicts slash command.
 */

export function parseVerdict(message: string): {
  kind: "judged" | "blocked"
  destructive: string
  credentials: string
  guardrails: string | null
  command: string
} | null {
  // Trap: a raw quote inside the command breaks this parse; callers fall back to raw text.
  const match = message.match(
    /^SystemOne-gate (judged|blocked) "([^"]*)": destructive ([0-9.]+), credentials ([0-9.]+)(?:, guardrails_violation ([0-9.]+))?, (?:below|over) the block threshold/,
  )
  if (!match) return null
  return {
    kind: match[1] as "judged" | "blocked",
    command: match[2],
    destructive: match[3],
    credentials: match[4],
    guardrails: match[5] ?? null,
  }
}

export function formatTime(at: number) {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const VERDICT_WIDTHS = [8, 7, 5, 5, 5]

function verdictRow(
  time: string,
  kind: string,
  destructive: string,
  credentials: string,
  guardrails: string,
  command: string,
) {
  const cells = [time, kind, destructive, credentials, guardrails]
  return cells.map((cell, index) => cell.padEnd(VERDICT_WIDTHS[index])).join(" ") + " " + command
}

export default {
  id: "bergetai.guardrails-md.tui",
  setup(ctx) {
    const [state, setState] = ctx.storage.memory("systemone-asks-3", {
      initial: {
        lines: [] as Array<{ id: string; sessionID: string; text: string }>,
        history: [] as Array<{
          at: number
          kind: "judged" | "blocked" | "?"
          destructive: string
          credentials: string
          guardrails: string | null
          command: string
        }>,
      },
    })
    const dispose: Array<() => void> = []
    dispose.push(
      ctx.data.on("permission.asked", (event) => {
        const request = event.data
        if (request.action !== "shell" || typeof request.message !== "string") return
        const verdict = parseVerdict(request.message) ?? {
          kind: "?" as const,
          destructive: "",
          credentials: "",
          guardrails: null,
          command: request.message,
        }
        setState((draft) => {
          draft.lines = [
            ...draft.lines.filter((line) => line.id !== request.id),
            { id: request.id, sessionID: request.sessionID, text: request.message },
          ]
          draft.history = [
            { at: event.created, ...verdict },
            ...draft.history.filter(
              (entry) => entry.command !== verdict.command,
            ),
          ].slice(0, 20)
        })
      }),
    )
    dispose.push(
      ctx.data.on("permission.replied", (event) => {
        setState((draft) => {
          draft.lines = draft.lines.filter((line) => line.id !== event.data.requestID)
        })
      }),
    )
    dispose.push(
      ctx.ui.slot({
        append: "session.composer.top",
        render: ({ sessionID }) => {
          const lines = state.lines
            .filter((line) => line.sessionID === sessionID)
            .filter((line) => line.text.length > 0)
          if (lines.length === 0) return <box />
          return (
            <box paddingLeft={2} marginBottom={1}>
              {lines.map((line) => (
                <text fg="#9ca3af">{line.text}</text>
              ))}
            </box>
          )
        },
      }),
    )
    dispose.push(
      ctx.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "systemone.verdicts",
            title: "SystemOne verdicts",
            group: "SystemOne",
            bind: false,
            palette: true,
            slash: { name: "verdicts" },
            run: () => {
              ctx.ui.dialog.set({ size: "large" })
              ctx.ui.dialog.show(
                () => (
                  <box paddingLeft={2} paddingTop={1} paddingBottom={1}>
                    {state.history.length === 0 ? (
                      <text fg="#9ca3af">No verdicts yet — run a gated shell command</text>
                    ) : (
                      <box>
                        <text fg="#9ca3af">
                          {verdictRow("time", "verdict", "destr", "creds", "guard", "command")}
                        </text>
                        {state.history.map((entry) => (
                          <text fg="#9ca3af">
                            {verdictRow(
                              formatTime(entry.at),
                              entry.kind,
                              entry.destructive,
                              entry.credentials,
                              entry.guardrails ?? "-",
                              entry.command.length > 64 ? entry.command.slice(0, 63) + "…" : entry.command,
                            )}
                          </text>
                        ))}
                      </box>
                    )}
                  </box>
                ),
                () => {},
              )
            },
          },
        ],
      })),
    )
    return () => dispose.forEach((fn) => fn())
  },
}
