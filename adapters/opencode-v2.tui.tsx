/**
 * TUI side of the v2 adapter: opencode's permission prompt does not render
 * the verdict the server-side plugin stamps onto the ask, so this claims the
 * composer-top slot and shows it there while the ask is unresolved.
 */
export default {
  id: "bergetai.guardrails-md.tui",
  setup(ctx) {
    ctx.ui.slot({
      append: "session.composer.top",
      render: (input) => {
        const pending = (ctx.data.session.permission.list(input.sessionID) ?? []).filter(
          (request) => request.action === "shell" && typeof request.message === "string",
        )
        if (pending.length === 0) return <box />
        return (
          <box paddingLeft={2} marginBottom={1}>
            {pending.map((request) => (
              <text fg="#9ca3af">{request.message}</text>
            ))}
          </box>
        )
      },
    })
  },
}
