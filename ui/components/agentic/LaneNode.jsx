export function LaneNode({ text, source, empty, style }) {
  if (empty) return (
    <div style={{ border: 'var(--ax-border-dashed)', borderRadius: 'var(--ax-r-md)', padding: '11px 13px', fontFamily: 'var(--ax-font-body)', fontSize: 12.5, color: 'var(--ax-ink-4)', ...style }}>not used for this decision</div>
  );
  return (
    <div style={{ border: '1px solid var(--ax-line-strong)', background: 'var(--ax-signal-faint), var(--ax-surface)', borderRadius: 'var(--ax-r-md)', padding: '11px 13px', ...style }}>
      <div style={{ fontFamily: 'var(--ax-font-body)', fontSize: 13.5, fontWeight: 500, color: 'var(--ax-ink)' }}>{text}</div>
      {source && <div style={{ fontFamily: 'var(--ax-font-mono)', fontSize: 9, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ax-ink-3)', marginTop: 4 }}>{source}</div>}
    </div>
  );
}
