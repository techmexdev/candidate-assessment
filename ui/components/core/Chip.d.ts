export interface ChipProps {
  /** Filled ink when true */
  selected?: boolean;
  /** Dashed border = excluded / not-applicable */
  dashed?: boolean;
  children?: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export declare function Chip(props: ChipProps): JSX.Element;
