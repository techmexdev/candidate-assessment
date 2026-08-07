export interface LaneNodeProps {
  text?: string;
  /** Mono source line, e.g. "SNOMED CT SUBSET" */
  source?: string;
  /** Dashed "not used for this decision" placeholder */
  empty?: boolean;
  style?: React.CSSProperties;
}
export declare function LaneNode(props: LaneNodeProps): JSX.Element;
