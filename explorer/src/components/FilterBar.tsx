import React from 'react';

export interface FilterState {
  search: string;
  showCanonical: boolean;
  showNonCanonical: boolean;
  sourceFilter: string; // '' = all, 'local', 'remote', 'storage'
}

interface FilterBarProps {
  filter: FilterState;
  onChange: (filter: FilterState) => void;
  columns: Set<string>;
  onColumnsChange: (columns: Set<string>) => void;
  allColumns: { key: string; label: string }[];
}

export const FilterBar = React.memo(function FilterBar({
  filter,
  onChange,
  columns,
  onColumnsChange,
  allColumns,
}: FilterBarProps) {
  const [showColumns, setShowColumns] = React.useState(false);

  return (
    <div className='filter-bar'>
      <input
        className='filter-search'
        type='text'
        placeholder='Search by hash...'
        value={filter.search}
        onChange={(e) => onChange({ ...filter, search: e.target.value })}
      />

      <label className='filter-check'>
        <input
          type='checkbox'
          checked={filter.showCanonical}
          onChange={(e) => onChange({ ...filter, showCanonical: e.target.checked })}
        />
        Canonical
      </label>

      <label className='filter-check'>
        <input
          type='checkbox'
          checked={filter.showNonCanonical}
          onChange={(e) => onChange({ ...filter, showNonCanonical: e.target.checked })}
        />
        Non-canonical
      </label>

      <select
        className='filter-select'
        value={filter.sourceFilter}
        onChange={(e) => onChange({ ...filter, sourceFilter: e.target.value })}
      >
        <option value=''>All sources</option>
        <option value='local'>Local</option>
        <option value='remote'>Remote</option>
        <option value='storage'>Storage</option>
      </select>

      <div className='column-toggle-wrapper'>
        <button
          className='column-toggle-btn'
          onClick={() => setShowColumns(!showColumns)}
        >
          Columns {showColumns ? '\u25B4' : '\u25BE'}
        </button>
        {showColumns && (
          <div className='column-dropdown'>
            {allColumns.map(({ key, label }) => (
              <label key={key} className='column-option'>
                <input
                  type='checkbox'
                  checked={columns.has(key)}
                  onChange={(e) => {
                    const next = new Set(columns);
                    if (e.target.checked) next.add(key);
                    else next.delete(key);
                    onColumnsChange(next);
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
