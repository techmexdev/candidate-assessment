export interface StatTileProps {
  /** Big numeral, e.g. "6.3h" */
  value: string;
  /** Mono microlabel, e.g. "SLEEP AVG 7D" */
  label: string;
  style?: React.CSSProperties;
}
export declare function StatTile(props: StatTileProps): JSX.Element;
