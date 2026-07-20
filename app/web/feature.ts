import type { AppRoute } from "./routing.js";

export interface FeatureContext {
  root: HTMLElement;
  signal: AbortSignal;
  setStatus: (message: string) => void;
  route: AppRoute;
}

export interface WebFeature {
  id: string;
  label: string;
  path: string;
  title: string;
  routes: AppRoute["id"][];
  mount: (context: FeatureContext) => Promise<void> | void;
}
