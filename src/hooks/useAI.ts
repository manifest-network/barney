import { useShallow } from 'zustand/react/shallow';
import { useAIStore } from '../contexts/aiStoreContext';

export function useAI() {
  return useAIStore(useShallow((s) => ({
    isOpen: s.isOpen,
    messages: s.messages,
    isStreaming: s.isStreaming,
    isConnected: s.isConnected,
    settings: s.settings,
    pendingConfirmation: s.pendingConfirmation,
    pendingPayload: s.pendingPayload,
    deployProgress: s.deployProgress,
    setIsOpen: s.setIsOpen,
    sendMessage: s.sendMessage,
    updateSettings: s.updateSettings,
    clearHistory: s.clearHistory,
    confirmAction: s.confirmAction,
    cancelAction: s.cancelAction,
    setClientManager: s.setClientManager,
    setAddress: s.setAddress,
    setSignArbitrary: s.setSignArbitrary,
    attachPayload: s.attachPayload,
    clearPayload: s.clearPayload,
    requestBatchDeploy: s.requestBatchDeploy,
    addLocalMessage: s.addLocalMessage,
    stopStreaming: s.stopStreaming,
  })));
}
