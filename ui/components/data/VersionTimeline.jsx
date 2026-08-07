export function VersionTimeline({ versions = [], style }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, ...style }}>
      {versions.map((v, i) => (
        <div key={i} style={{ display: 'flex', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: v.signal ? 'var(--ax-signal)' : v.filled ? 'var(--ax-ink)' : 'var(--ax-surface)', border: '1.5px solid var(--ax-ink)', flex: 'none' }} />
            {i < versions.length - 1 && <div style={{ width: 1, flex: 1, background: 'var(--ax-line)', marginTop: 4 }} />}
          </div>
          <div style={{ flex: 1, background: 'var(--ax-surface)', border: 'var(--ax-border)', borderRadius: 'var(--ax-r-md)', padding: '13px 15px' }}>
            <div style={{ fontFamily: 'var(--ax-font-body)', fontWeight: 700, fontSize: 14, letterSpacing: '-0.01em', color: 'var(--ax-ink)' }}>{v.title}</div>
            <div style={{ fontFamily: 'var(--ax-font-mono)', fontSize: 9.5, color: 'var(--ax-ink-3)', marginTop: 3 }}>{v.meta}</div>
            {(v.changes || []).map((c, j) => (
              <div key={j} style={{ fontFamily: 'var(--ax-font-body)', fontSize: 12.5, color: 'var(--ax-ink-2)', display: 'flex', gap: 7, marginTop: j === 0 ? 8 : 4 }}><span>·</span><span>{c}</span></div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
