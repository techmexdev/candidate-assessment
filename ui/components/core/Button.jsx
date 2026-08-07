export function Button({ variant = 'primary', size = 'md', disabled, children, style, ...rest }) {
  const h = size === 'lg' ? 'var(--ax-hit-lg)' : 'var(--ax-hit)';
  const variants = {
    primary: { background: 'var(--ax-action)', color: 'var(--ax-on-action)', border: 'none' },
    secondary: { background: 'var(--ax-surface)', color: 'var(--ax-ink)', border: 'var(--ax-border-strong)' },
    outline: { background: 'transparent', color: 'var(--ax-ink)', border: '1px solid var(--ax-ink)' },
    ghost: { background: 'transparent', color: 'var(--ax-ink-2)', border: 'none' }
  };
  const dis = disabled ? { background: 'var(--ax-disabled-bg)', color: 'var(--ax-disabled-fg)', border: 'none', cursor: 'default' } : {};
  return (
    <button disabled={disabled} style={{ fontFamily: 'var(--ax-font-body)', fontWeight: 600, fontSize: size === 'lg' ? 15 : 13.5, height: h, padding: '0 18px', borderRadius: 'var(--ax-r-pill)', cursor: 'pointer', transition: 'all var(--ax-dur-fast) var(--ax-ease)', ...variants[variant], ...dis, ...style }} {...rest}>{children}</button>
  );
}
