/** @jsxImportSource @opentui/solid */
/**
 * TUI side of the v2 adapter: opencode's permission prompt does not render
 * the verdict the server-side plugin stamps onto the ask, so this claims the
 * composer-top slot and shows it there while the ask is unresolved, and keeps
 * a rolling history behind the /verdicts slash command.
 */
export default {
  id: "bergetai.guardrails-md.tui",
  setup(ctx) {
    const [state, setState] = ctx.storage.memory("systemone-asks-2", {
      initial: {
        lines: [] as Array<{ id: string; sessionID: string; text: string }>,
        history: [] as Array<{ text: string }>,
      },
    })
    const dispose: Array<() => void> = []
    dispose.push(
      ctx.data.on("permission.asked", (event) => {
        const request = event.data
        if (request.action !== "shell" || typeof request.message !== "string") return
        setState((draft) => {
          draft.lines = [
            ...draft.lines.filter((line) => line.id !== request.id),
            { id: request.id, sessionID: request.sessionID, text: request.message },
          ]
          draft.history = [
            { text: request.message },
            ...draft.history.filter((entry) => entry.text !== request.message),
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
              const options = state.history.length
                ? state.history.map((entry, index) => ({ title: entry.text, value: String(index), category: "verdict" }))
                : [{ title: "No verdicts yet — run a gated shell command", value: "none" }]
              ctx.ui.dialog.select({ title: "SystemOne verdicts", options })
            },
          },
        ],
      })),
    )
    return () => dispose.forEach((fn) => fn())
  },
}
