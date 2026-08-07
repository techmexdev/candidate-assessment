export function SignalShimmer({ width = '80%', height = 12, style }) {
  return (
    <div style={{ height, width, background: 'var(--ax-signal-soft)', backgroundSize: '200% 100%', animation: 'ax-signal-shift 1.6s ease infinite', borderRadius: height / 2, ...style }} />
  );
}
