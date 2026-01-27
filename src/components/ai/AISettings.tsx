import { useState, useEffect } from 'react';
import { Settings, RefreshCw, Trash2, X, Check, Wifi, WifiOff, Brain } from 'lucide-react';
import { useAI } from '../../contexts/AIContext';
import { validateEndpointUrl } from '../../ai/validation';

interface AISettingsProps {
  onClose: () => void;
}

export function AISettings({ onClose }: AISettingsProps) {
  const {
    settings,
    updateSettings,
    clearHistory,
    refreshModels,
    availableModels,
    isConnected,
    messages,
  } = useAI();

  const [localEndpoint, setLocalEndpoint] = useState(settings.ollamaEndpoint);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Sync local endpoint state when settings change (e.g., loaded from localStorage)
  useEffect(() => {
    setLocalEndpoint(settings.ollamaEndpoint);
  }, [settings.ollamaEndpoint]);

  const handleEndpointChange = async () => {
    // Validate and normalize the endpoint before using it
    const normalizedEndpoint = validateEndpointUrl(localEndpoint);
    if (!normalizedEndpoint) {
      // Invalid URL - don't update
      return;
    }

    // Update local state to show normalized value
    setLocalEndpoint(normalizedEndpoint);
    updateSettings({ ollamaEndpoint: normalizedEndpoint });

    setIsRefreshing(true);
    await refreshModels(normalizedEndpoint);
    setIsRefreshing(false);
  };

  const handleRefresh = async () => {
    // Use the validated endpoint from settings, not the potentially un-normalized local state
    setIsRefreshing(true);
    await refreshModels(settings.ollamaEndpoint);
    setIsRefreshing(false);
  };

  const handleClearHistory = () => {
    if (confirm('Are you sure you want to clear your chat history?')) {
      clearHistory();
    }
  };

  return (
    <div className="ai-settings">
      <div className="ai-settings-header">
        <div className="ai-settings-title">
          <Settings className="w-4 h-4" />
          <span>AI Settings</span>
        </div>
        <button type="button" onClick={onClose} className="ai-settings-close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="ai-settings-body">
        {/* Connection Status */}
        <div className="ai-settings-section">
          <label className="ai-settings-label">
            Connection Status
          </label>
          <div className={`ai-settings-status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? (
              <>
                <Wifi className="w-4 h-4" />
                <span>Connected to Ollama</span>
              </>
            ) : (
              <>
                <WifiOff className="w-4 h-4" />
                <span>Disconnected</span>
              </>
            )}
          </div>
        </div>

        {/* Ollama Endpoint */}
        <div className="ai-settings-section">
          <label className="ai-settings-label" htmlFor="ollama-endpoint">
            Ollama Endpoint
          </label>
          <div className="ai-settings-input-group">
            <input
              id="ollama-endpoint"
              type="text"
              value={localEndpoint}
              onChange={(e) => setLocalEndpoint(e.target.value)}
              placeholder="http://localhost:11434"
              className="input"
            />
            <button
              type="button"
              onClick={handleEndpointChange}
              className="btn btn-secondary btn-sm"
              title="Save endpoint"
            >
              <Check className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Model Selection */}
        <div className="ai-settings-section">
          <label className="ai-settings-label" htmlFor="model-select">
            Model
          </label>
          <div className="ai-settings-input-group">
            <select
              id="model-select"
              value={settings.model}
              onChange={(e) => updateSettings({ model: e.target.value })}
              className="input select"
            >
              {availableModels.length > 0 ? (
                availableModels.map((model) => (
                  <option key={model.name} value={model.name}>
                    {model.name}
                  </option>
                ))
              ) : (
                <option value={settings.model}>{settings.model}</option>
              )}
            </select>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="btn btn-secondary btn-sm"
              title="Refresh models"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Enable Thinking Toggle */}
        <div className="ai-settings-section">
          <div className="ai-settings-row">
            <div>
              <label id="thinking-mode-label" className="ai-settings-label">
                <Brain className="w-3 h-3 inline mr-1" />
                Enable Thinking Mode
              </label>
              <p id="thinking-mode-hint" className="ai-settings-hint">
                {settings.enableThinking
                  ? 'Model will show reasoning process (requires Qwen3, Cogito, or similar)'
                  : 'Standard response mode'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => updateSettings({ enableThinking: !settings.enableThinking })}
              className={`toggle ${settings.enableThinking ? 'active' : ''}`}
              role="switch"
              aria-checked={settings.enableThinking}
              aria-labelledby="thinking-mode-label"
              aria-describedby="thinking-mode-hint"
            >
              <span className="toggle-knob" />
            </button>
          </div>
        </div>

        {/* Save History Toggle */}
        <div className="ai-settings-section">
          <div className="ai-settings-row">
            <div>
              <label id="save-history-label" className="ai-settings-label">
                Save Chat History
              </label>
              <p id="save-history-hint" className="ai-settings-hint">
                {settings.saveHistory
                  ? 'Chat history will be saved across sessions'
                  : 'Chat history will not be saved'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => updateSettings({ saveHistory: !settings.saveHistory })}
              className={`toggle ${settings.saveHistory ? 'active' : ''}`}
              role="switch"
              aria-checked={settings.saveHistory}
              aria-labelledby="save-history-label"
              aria-describedby="save-history-hint"
            >
              <span className="toggle-knob" />
            </button>
          </div>
        </div>

        {/* Clear History */}
        <div className="ai-settings-section">
          <label className="ai-settings-label">
            Chat History
          </label>
          <button
            type="button"
            onClick={handleClearHistory}
            disabled={messages.length === 0}
            className="btn btn-danger btn-sm"
          >
            <Trash2 className="w-4 h-4" />
            Clear History ({messages.length} messages)
          </button>
        </div>
      </div>
    </div>
  );
}
