export function Segmented({ options = [], value, onChange, style }) {
  return (
    <div style={{ display: 'flex', gap: 8, ...style }}>
      {options.map((o) => (
        <button key={o} onClick={() => onChange && onChange(o)} style={{ flex: 1, height: 'var(--ax-hit)', borderRadius: 'var(--ax-r-sm)', fontFamily: 'var(--ax-font-body)', fontWeight: 600, fontSize: 13.5, cursor: 'pointer', transition: 'all var(--ax-dur-fast) var(--ax-ease)', background: value === o ? 'var(--ax-ink)' : 'var(--ax-surface)', color: value === o ? 'var(--ax-on-ink)' : 'var(--ax-ink-2)', border: value === o ? '1px solid var(--ax-ink)' : 'var(--ax-border-strong)' }}>{o}</button>
      ))}
    </div>
  );
}
