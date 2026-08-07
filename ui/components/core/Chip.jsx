export function Chip({ selected, dashed, children, style, ...rest }) {
  return (
    <button style={{ fontFamily: 'var(--ax-font-body)', fontWeight: selected ? 600 : 500, fontSize: 13, height: 40, padding: '0 15px', borderRadius: 'var(--ax-r-pill)', whiteSpace: 'nowrap', cursor: 'pointer', transition: 'all var(--ax-dur-fast) var(--ax-ease)', background: selected ? 'var(--ax-ink)' : 'var(--ax-surface)', color: selected ? 'var(--ax-on-ink)' : 'var(--ax-ink-2)', border: dashed ? 'var(--ax-border-dashed)' : selected ? '1px solid var(--ax-ink)' : 'var(--ax-border-strong)', ...style }} {...rest}>{children}</button>
  );
}
