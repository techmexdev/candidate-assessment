export function TabBar({ tabs = [], active, onChange, style }) {
  return (
    <div style={{ display: 'flex', borderTop: '1px solid var(--ax-line-2)', background: 'var(--ax-surface-sub)', ...style }}>
      {tabs.map((t) => (
        <button key={t} onClick={() => onChange && onChange(t)} style={{ flex: 1, height: 58, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
          <div style={{ width: 18, height: 2.5, borderRadius: 2, background: 'var(--ax-ink)', opacity: active === t ? 1 : 0 }} />
          <span style={{ fontFamily: 'var(--ax-font-body)', fontSize: 12.5, fontWeight: 600, color: active === t ? 'var(--ax-ink)' : 'var(--ax-ink-4)' }}>{t}</span>
        </button>
      ))}
    </div>
  );
}
