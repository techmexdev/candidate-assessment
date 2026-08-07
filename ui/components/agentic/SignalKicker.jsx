export function SignalKicker({ working, children, style }) {
  return (
    <span style={{ fontFamily: 'var(--ax-font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ax-ink)', background: working ? 'var(--ax-signal)' : 'var(--ax-signal-soft)', backgroundSize: working ? '200% 100%' : undefined, animation: working ? 'ax-signal-shift 1.6s ease infinite' : undefined, borderRadius: 'var(--ax-r-pill)', padding: '5px 10px', display: 'inline-block', ...style }}>{children}</span>
  );
}
