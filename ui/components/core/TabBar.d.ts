export interface TabBarProps {
  tabs: string[];
  active?: string;
  onChange?: (tab: string) => void;
  style?: React.CSSProperties;
}
export declare function TabBar(props: TabBarProps): JSX.Element;
