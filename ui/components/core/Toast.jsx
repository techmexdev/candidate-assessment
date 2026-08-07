export function Toast({ children, style }) {
  return (
    <div style={{ background: 'var(--ax-ink)', color: 'var(--ax-on-ink)', fontFamily: 'var(--ax-font-body)', fontWeight: 600, fontSize: 13, padding: '11px 18px', borderRadius: 'var(--ax-r-pill)', boxShadow: 'var(--ax-shadow-float)', whiteSpace: 'nowrap', animation: 'ax-fade-up var(--ax-dur-med) var(--ax-ease)', display: 'inline-block', ...style }}>{children}</div>
  );
}
