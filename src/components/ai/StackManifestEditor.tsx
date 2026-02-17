import { memo, useState, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import { ManifestEditor } from './ManifestEditor';
import type { StackManifestFields, ManifestFields } from './manifestEditorUtils';

export interface StackManifestEditorProps {
  stack: StackManifestFields;
  onChange: (updated: StackManifestFields) => void;
}

export const StackManifestEditor = memo(function StackManifestEditor({ stack, onChange }: StackManifestEditorProps) {
  const serviceNames = Object.keys(stack);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    serviceNames.forEach((name, i) => { initial[name] = i === 0; });
    return initial;
  });

  const toggleService = useCallback((name: string) => {
    setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  const handleServiceChange = useCallback((name: string, updated: ManifestFields) => {
    onChange({
      ...stack,
      [name]: { ...stack[name], editable: updated },
    });
  }, [stack, onChange]);

  return (
    <div className="stack-manifest-editor" data-testid="stack-manifest-editor">
      {serviceNames.map((name) => {
        const isOpen = expanded[name] ?? false;
        const { editable } = stack[name];
        return (
          <div key={name} className="stack-manifest-service" data-testid="stack-manifest-service">
            <button
              type="button"
              className="stack-manifest-service-toggle"
              onClick={() => toggleService(name)}
              aria-expanded={isOpen}
              aria-controls={`stack-service-${name}`}
            >
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform ${isOpen ? '' : '-rotate-90'}`}
                aria-hidden="true"
              />
              <span className="stack-manifest-service-name">{name}</span>
              <span className="stack-manifest-service-image">{editable.image}</span>
            </button>
            {isOpen && (
              <div id={`stack-service-${name}`} className="stack-manifest-service-body">
                <ManifestEditor
                  manifest={editable}
                  onChange={(updated) => handleServiceChange(name, updated)}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});
