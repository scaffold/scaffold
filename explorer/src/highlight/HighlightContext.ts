import { createContext, useContext } from 'react';
import { HighlightRegistry } from './HighlightRegistry.ts';

export const HighlightContext = createContext<HighlightRegistry>(new HighlightRegistry());

export function useHighlightRegistry(): HighlightRegistry {
  return useContext(HighlightContext);
}
