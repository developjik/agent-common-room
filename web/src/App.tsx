export function App() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-3">
        <h1 className="text-base font-semibold">Agent Common Room</h1>
        <span className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-muted">
          room status
        </span>
      </header>
      <div className="flex flex-1 flex-col md:flex-row">
        <main aria-label="Room feed" className="flex-1 p-4">
          <p className="text-sm text-ink-muted">Live room feed will render here.</p>
        </main>
        <aside
          aria-label="Management rail"
          className="border-t border-line bg-surface p-4 md:w-80 md:border-l md:border-t-0"
        >
          <p className="text-sm text-ink-muted">Invites, pending approvals, participants.</p>
        </aside>
      </div>
    </div>
  );
}
