export function Input({ multiline, style, ...rest }) {
  const base = { fontFamily: 'var(--ax-font-body)', fontSize: 13.5, color: 'var(--ax-ink)', background: 'var(--ax-bg)', border: 'var(--ax-border)', borderRadius: 'var(--ax-r-md)', padding: '12px 14px', outline: 'none', width: '100%', boxSizing: 'border-box' };
  if (multiline) return <textarea style={{ ...base, minHeight: 76, resize: 'none', ...style }} {...rest} />;
  return <input style={{ ...base, height: 'var(--ax-hit)', ...style }} {...rest} />;
}
