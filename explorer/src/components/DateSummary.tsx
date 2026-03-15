import { useEffect, useState } from 'react';

interface DateSummaryProps {
  instantMs: number;
}

function formatRelative(instantMs: number): string {
  const diff = Date.now() - instantMs;
  if (diff < 0) return 'just now';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getInterval(instantMs: number): number {
  const diff = Date.now() - instantMs;
  if (diff < 60_000) return 1000;
  if (diff < 3_600_000) return 10_000;
  return 60_000;
}

export function DateSummary({ instantMs }: DateSummaryProps) {
  const [text, setText] = useState(() => formatRelative(instantMs));

  useEffect(() => {
    setText(formatRelative(instantMs));
    const id = setInterval(() => {
      setText(formatRelative(instantMs));
    }, getInterval(instantMs));
    return () => clearInterval(id);
  }, [instantMs]);

  return <span title={new Date(instantMs).toISOString()}>{text}</span>;
}
