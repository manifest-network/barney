/**
 * AI Assistant wrapper component
 * Connects the AI context with cosmos-kit wallet
 */

import { useEffect } from 'react';
import { useAI } from '../../contexts/AIContext';
import { useManifestMCP } from '../../hooks/useManifestMCP';
import { ChatBubble } from './ChatBubble';

export function AIAssistant() {
  const { setClientManager, setAddress } = useAI();
  const { clientManager, address } = useManifestMCP();

  // Sync wallet state with AI context
  useEffect(() => {
    setClientManager(clientManager);
    setAddress(address);
  }, [clientManager, address, setClientManager, setAddress]);

  return <ChatBubble />;
}
