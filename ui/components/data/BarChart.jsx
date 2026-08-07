export function BarChart({ bars = [], height = 84, style }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height, padding: 10, background: 'var(--ax-bg)', border: '1px solid var(--ax-line-2)', borderRadius: 'var(--ax-r-md)', boxSizing: 'border-box', ...style }}>
      {bars.map((b, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 4, height: '100%' }}>
          <div style={{ height: b.h + '%', background: b.signal ? 'var(--ax-signal)' : b.muted ? 'var(--ax-line-strong)' : 'var(--ax-ink)', borderRadius: '4px 4px 2px 2px' }} />
          {b.lab != null && <div style={{ fontFamily: 'var(--ax-font-mono)', fontSize: 8.5, color: 'var(--ax-ink-4)', textAlign: 'center' }}>{b.lab}</div>}
        </div>
      ))}
    </div>
  );
}
