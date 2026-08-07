export function Card({ signal, recessed, radius = 'lg', children, style, ...rest }) {
  const r = { sm: 'var(--ax-r-sm)', md: 'var(--ax-r-md)', lg: 'var(--ax-r-lg)' }[radius];
  return (
    <div style={{ background: signal ? 'var(--ax-signal-soft), var(--ax-surface)' : recessed ? 'var(--ax-surface-sub)' : 'var(--ax-surface)', backgroundBlendMode: 'normal', border: recessed ? 'var(--ax-border-dashed)' : 'var(--ax-border)', borderRadius: r, padding: 16, boxShadow: recessed ? 'none' : 'var(--ax-shadow-card)', ...style }} {...rest}>{children}</div>
  );
}
