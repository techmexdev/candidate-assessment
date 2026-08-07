export interface SegmentedProps {
  options: string[];
  value?: string;
  onChange?: (option: string) => void;
  style?: React.CSSProperties;
}
export declare function Segmented(props: SegmentedProps): JSX.Element;
