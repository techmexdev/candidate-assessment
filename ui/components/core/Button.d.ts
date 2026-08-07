/**
 * @startingPoint section="Core" subtitle="Pill action button — ink is human" viewport="700x220"
 */
export interface ButtonProps {
  /** 'primary' (ink) | 'secondary' (outlined surface) | 'outline' (ink border) | 'ghost' */
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost';
  /** 'md' = 44px hit, 'lg' = 52px action-bar */
  size?: 'md' | 'lg';
  disabled?: boolean;
  children?: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export declare function Button(props: ButtonProps): JSX.Element;
