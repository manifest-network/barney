import { useContext } from 'react';
import { AIContext } from '../contexts/aiContextValue';
import type { AIContextType } from '../contexts/AIContext';

export function useAI(): AIContextType {
  const context = useContext(AIContext);
  if (!context) {
    throw new Error('useAI must be used within an AIProvider');
  }
  return context;
}
