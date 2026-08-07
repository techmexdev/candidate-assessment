export interface CardProps {
  /** Signal wash background — ONLY for machine-produced content */
  signal?: boolean;
  /** Recessed sub-surface with dashed border (e.g. exclusions group) */
  recessed?: boolean;
  radius?: 'sm' | 'md' | 'lg';
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Card(props: CardProps): JSX.Element;
