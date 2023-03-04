import React from 'react';

export default (
  { label, value, setValue }: {
    label: string;
    value: string;
    setValue: (val: string) => void;
  },
) => {
  const id = React.useMemo(() => Math.random().toString(36).slice(2), []);
  return (
    <span>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type='text'
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </span>
  );
};
