export interface Bar {
  /** Height percent 0–100 */
  h: number;
  /** Mono axis label */
  lab?: string;
  /** Context bars in line-strong gray */
  muted?: boolean;
  /** Machine-highlighted bar gets the Signal gradient */
  signal?: boolean;
}
export interface BarChartProps {
  bars: Bar[];
  height?: number;
  style?: React.CSSProperties;
}
export declare function BarChart(props: BarChartProps): JSX.Element;
