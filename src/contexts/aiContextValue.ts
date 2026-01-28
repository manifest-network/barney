import { createContext } from 'react';
import type { AIContextType } from './AIContext';

export const AIContext = createContext<AIContextType | null>(null);
