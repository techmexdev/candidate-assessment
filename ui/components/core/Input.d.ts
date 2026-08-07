export interface InputProps {
  /** Renders a textarea */
  multiline?: boolean;
  placeholder?: string;
  value?: string;
  onChange?: (e: any) => void;
  style?: React.CSSProperties;
}
export declare function Input(props: InputProps): JSX.Element;
