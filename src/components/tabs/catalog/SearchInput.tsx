import { Search, X } from 'lucide-react';
import type { SearchInputProps } from './types';

export function SearchInput({ value, onChange, placeholder }: SearchInputProps) {
  return (
    <div className="catalog-search">
      <Search size={14} className="catalog-search-icon" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="catalog-search-input"
        aria-label={placeholder || 'Search'}
      />
      {value && (
        <button onClick={() => onChange('')} className="catalog-search-clear" title="Clear">
          <X size={14} />
        </button>
      )}
    </div>
  );
}
