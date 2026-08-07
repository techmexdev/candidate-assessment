export function ProvenanceTag({ children, style }) {
  return (
    <span style={{ fontFamily: 'var(--ax-font-mono)', fontSize: 9.5, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ax-ink-3)', border: 'var(--ax-border)', borderRadius: 'var(--ax-r-pill)', padding: '5px 10px', display: 'inline-block', background: 'var(--ax-surface)', ...style }}>{children}</span>
  );
}
