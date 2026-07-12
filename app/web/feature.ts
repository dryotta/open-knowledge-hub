export interface FeatureContext {
  root: HTMLElement;
  signal: AbortSignal;
  setStatus: (message: string) => void;
}

export interface WebFeature {
  id: string;
  label: string;
  path: string;
  title: string;
  mount: (context: FeatureContext) => Promise<void> | void;
}
