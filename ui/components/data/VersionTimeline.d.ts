export interface Version {
  title: string;
  /** Mono meta line: actor · time */
  meta: string;
  changes?: string[];
  /** Filled ink dot (coach action) */
  filled?: boolean;
  /** Signal dot (override / machine event) */
  signal?: boolean;
}
export interface VersionTimelineProps {
  versions: Version[];
  style?: React.CSSProperties;
}
export declare function VersionTimeline(props: VersionTimelineProps): JSX.Element;
