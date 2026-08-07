export function StatTile({ value, label, style }) {
  return (
    <div style={{ background: 'var(--ax-surface)', border: 'var(--ax-border)', borderRadius: 'var(--ax-r-md)', padding: 12, boxShadow: 'var(--ax-shadow-card)', ...style }}>
      <div style={{ fontFamily: 'var(--ax-font-display)', fontStretch: '110%', fontWeight: 700, fontSize: 19, letterSpacing: '-0.01em', color: 'var(--ax-ink)' }}>{value}</div>
      <div style={{ fontFamily: 'var(--ax-font-mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ax-ink-3)', marginTop: 3 }}>{label}</div>
    </div>
  );
}
