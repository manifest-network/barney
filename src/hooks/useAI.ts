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
    dnsStatuses: s.dnsStatuses,
    setDnsStatuses: s.setDnsStatuses,
    skuTiers: s.skuTiers,
    loadSkuTiers: s.loadSkuTiers,
    retrySkuTiers: s.retrySkuTiers,
    setIsOpen: s.setIsOpen,
    sendMessage: s.sendMessage,
    updateSettings: s.updateSettings,
    clearHistory: s.clearHistory,
    confirmAction: s.confirmAction,
    cancelAction: s.cancelAction,
    setClientManager: s.setClientManager,
    setAddress: s.setAddress,
    setSigning: s.setSigning,
    setChainId: s.setChainId,
    setWalletContext: s.setWalletContext,
    attachPayload: s.attachPayload,
    clearPayload: s.clearPayload,
    requestBatchDeploy: s.requestBatchDeploy,
    requestStopApp: s.requestStopApp,
    addLocalMessage: s.addLocalMessage,
    addLocalErrorMessage: s.addLocalErrorMessage,
    stopStreaming: s.stopStreaming,
  })));
}
