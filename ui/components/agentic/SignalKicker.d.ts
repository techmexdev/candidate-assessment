export interface SignalKickerProps {
  /** Animates the shimmer — ONLY while the machine is actively working */
  working?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function SignalKicker(props: SignalKickerProps): JSX.Element;
